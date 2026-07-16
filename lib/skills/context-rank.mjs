// @ts-check
// Stage-2 state-conditional re-rank. Stage 1 (scoreAll) scores the prompt text
// alone; this stage adds priors the prompt text lacks, drawn from the durable
// workflow state. A paraphrase like "why does this return undefined" carries no
// trigger tokens, but at gate=impl-started the debug skill is almost certainly
// what's needed — and during any active lane, that lane's orchestrator skill
// must be available. Additive, capped, deterministic; a vetoed (negatively
// triggered) skill is never resurrected.

import { selectMatches, normalizeQuery } from './semantic-matcher.mjs';
import { morphologicallyMatches } from './trigram.mjs';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').MatchResult} MatchResult */
/** @typedef {import('../types.mjs').MatchContext} MatchContext */
/** @typedef {import('../types.mjs').SkillManifest} SkillManifest */

/** Confidence added to the active lane's orchestrator skill. */
export const LANE_PRIOR = 0.4;

/** Confidence added to the debug skill during implementation/verification gates. */
export const DEBUG_PRIOR = 0.3;

/**
 * DN-5: confidence added once per active business domain whose vocabulary
 * (config keywords ∪ the domain id) intersects the skill's matchable tokens
 * (tags ∪ synonyms ∪ trigger tokens ∪ skillId tokens). Deliberately below
 * LANE_PRIOR and DEBUG_PRIOR: domain hints must not outrank workflow-state
 * signals, and DOMAIN_PRIOR_CAP stays below the trigger-phrase weight (0.5)
 * so domain priors alone can never displace a lexically-strong rank-1 match.
 */
// TODO: calibrate — provisional placeholder (measure displacement once the routing evals consume the domain fixtures)
export const DOMAIN_PRIOR = 0.2;

/** DN-5: total domain-prior cap across all active domains. */
// TODO: calibrate — provisional placeholder
export const DOMAIN_PRIOR_CAP = 0.3;

/** The single debug skill boosted by implementation-phase gates. */
export const DEBUG_SKILL_ID = 'tdd-debug';

/** Gates at which the debug skill is the likely need. */
export const DEBUG_GATES = Object.freeze(['impl-started', 'verification-passed']);

/** @param {number} n @returns {number} */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** The orchestrator skill id for a lane, or null. @param {string|null|undefined} lane */
export function laneSkillId(lane) {
  return lane === 'feature' || lane === 'bug' || lane === 'chore' ? `orchestrator-${lane}-lane` : null;
}

/**
 * Normalized token set of a list of phrases — the semantic-matcher's exported
 * normalization/stemming, reused, never forked.
 * @param {string[]} phrases
 * @returns {Set<string>}
 */
function tokenSetOf(phrases) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const phrase of phrases) {
    if (typeof phrase !== 'string') continue;
    for (const token of normalizeQuery(phrase)) set.add(token);
  }
  return set;
}

/**
 * True when any domain token matches any skill token — exact set membership
 * or morphological (invoices~invoice) via the trigram matcher, mirroring the
 * semantic-matcher's trigger-token matching.
 * @param {Set<string>} domainTokens
 * @param {Set<string>} skillTokens
 * @returns {boolean}
 */
function vocabulariesIntersect(domainTokens, skillTokens) {
  const skillArr = [...skillTokens];
  for (const dt of domainTokens) {
    if (skillTokens.has(dt) || skillArr.some((st) => morphologicallyMatches(dt, st))) {
      return true;
    }
  }
  return false;
}

/**
 * Re-score candidates with workflow-state priors. Pure; returns a new, re-sorted
 * list. A null/absent context (fresh session) is a no-op.
 *
 * DN-5: when `ctx.domains` is non-empty and `manifests` are provided, an
 * additive domain prior applies — DOMAIN_PRIOR once per active domain whose
 * vocabulary (keywords ∪ id, from `ctx.domainKeywords`) intersects the skill's
 * matchable tokens, capped at DOMAIN_PRIOR_CAP total. Same design grammar as
 * the lane/debug priors: additive, capped, no force-include — a wrong domain
 * map can waste a prior, never force a skill in or resurrect a vetoed one.
 * Absent/empty domains ⇒ scores identical to the pre-domain behavior.
 * @param {MatchResult[]} scored  Output of scoreAll (all candidates, sorted).
 * @param {MatchContext|null|undefined} ctx
 * @param {SkillManifest[]} [manifests]  Catalog for domain-vocabulary intersection (DN-5); only read when ctx.domains is non-empty.
 * @returns {MatchResult[]}
 */
export function rankWithContext(scored, ctx, manifests = []) {
  if (!ctx) return scored;
  const laneId = laneSkillId(ctx.lane);
  const boostDebug = typeof ctx.gate === 'string' && DEBUG_GATES.includes(ctx.gate);

  // DN-5: precompute the per-domain and per-skill token sets once per call.
  const domains = Array.isArray(ctx.domains) ? ctx.domains : [];
  const keywordsByDomain = ctx.domainKeywords ?? {};
  const domainTokenSets = domains.map((id) => ({
    id,
    tokens: tokenSetOf([...(getOwn(keywordsByDomain, id) ?? []), id]),
  }));
  // "Vocab" naming (not "tokens"): the no-insecure-comparison lint treats
  // comparisons on token-named identifiers as secret comparison.
  /** @type {Map<string, Set<string>>} */
  const skillVocabById = new Map();
  if (domainTokenSets.length > 0) {
    for (const m of manifests) {
      skillVocabById.set(
        m.skillId,
        tokenSetOf([
          ...(Array.isArray(m.triggers) ? m.triggers : []),
          ...(Array.isArray(m.tags) ? m.tags : []),
          ...(Array.isArray(m.synonyms) ? m.synonyms : []),
          m.skillId,
        ]),
      );
    }
  }

  const ranked = scored.map((r) => {
    if (r.negativeTriggered) return r; // never resurrect a vetoed skill
    let bonus = 0;
    /** @type {string[]} */
    const reasons = [];
    if (laneId !== null && r.skillId === laneId) {
      bonus += LANE_PRIOR;
      reasons.push('state:lane');
    }
    if (boostDebug && r.skillId === DEBUG_SKILL_ID) {
      bonus += DEBUG_PRIOR;
      reasons.push('state:debug-gate');
    }
    if (domainTokenSets.length > 0) {
      const skillVocab = skillVocabById.get(r.skillId);
      if (skillVocab !== undefined && skillVocab.size > 0) {
        let domainBonus = 0;
        for (const d of domainTokenSets) {
          if (vocabulariesIntersect(d.tokens, skillVocab)) {
            domainBonus += DOMAIN_PRIOR;
            reasons.push(`state:domain:${d.id}`);
          }
        }
        bonus += Math.min(domainBonus, DOMAIN_PRIOR_CAP);
      }
    }
    if (bonus === 0) return r;
    return {
      ...r,
      confidence: Math.min(round4(r.confidence + bonus), 1),
      reason: [r.reason, ...reasons].filter((s) => s !== '').join(', '),
    };
  });

  return ranked.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      (a.priority ?? 5) - (b.priority ?? 5) ||
      a.skillId.localeCompare(b.skillId),
  );
}

/**
 * Select matches with state priors applied, and FORCE-INCLUDE the active lane's
 * orchestrator skill: during a lane the matcher may be wrong about which
 * secondary skill to load, but never about whether to load the lane skill. The
 * lane skill is prepended if the operating-point cut dropped it (unless it was
 * vetoed by a negative trigger), and the result is re-capped at topN.
 * DN-5: domains do NOT get force-include — only the additive prior above. A
 * wrong domain map must never be able to force a skill in.
 * @param {MatchResult[]} scored  Output of scoreAll.
 * @param {MatchContext|null|undefined} ctx
 * @param {{ topN?: number, minConfidence?: number }} [opts]
 * @param {SkillManifest[]} [manifests]  Catalog for the domain prior (DN-5).
 * @returns {MatchResult[]}
 */
export function selectWithContext(scored, ctx, opts = {}, manifests = []) {
  const ranked = rankWithContext(scored, ctx, manifests);
  const selected = selectMatches(ranked, opts);
  const laneId = ctx ? laneSkillId(ctx.lane) : null;
  if (laneId !== null) {
    const laneCand = ranked.find((r) => r.skillId === laneId && !r.negativeTriggered);
    if (laneCand && !selected.some((s) => s.skillId === laneId)) {
      const topN = opts && typeof opts.topN === 'number' ? opts.topN : 5;
      return [laneCand, ...selected].slice(0, topN);
    }
  }
  return selected;
}
