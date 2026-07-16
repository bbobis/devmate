// @ts-check
// E4-5: robust semantic skill matching. Purely algorithmic multi-field scoring
// over SkillManifest frontmatter (triggers, tags, skillId, negative-triggers).
// No LLM calls, so routing is fast, deterministic, and testable (TCM-4, TCM-5).
// Loading the wrong skill wastes the whole skill body in context; failing to
// load the right skill forces an agent to improvise. Negative triggers stop a
// debugging query from matching a `learn`/`research` skill, for example.
//
// Improvements over base implementation:
//   - Stemming: strips common English suffixes so verb-tense variants match.
//   - Synonyms: optional frontmatter field expands token matching surface.
//   - Position weighting: trigger token in first 3 query words gets a small bonus.
//   - Priority tiebreaker: `priority` frontmatter field (lower = higher priority).
//
// This module is pure and I/O-free (TCM per CONTRIBUTING §4): it scores and
// ranks only. Telemetry (the decision ledger) is written at the hook boundary
// from the full candidate list `scoreAll` exposes — never from inside a match.

/** @typedef {import('../types.mjs').SkillManifest} SkillManifest */
/** @typedef {import('../types.mjs').MatchResult} MatchResult */

import { morphologicallyMatches } from './trigram.mjs';

/* ------------------------------------------------------------------ */
/* Scoring weights (additive, total capped at 1.0).                    */
/* ------------------------------------------------------------------ */

/** Trigger phrase appears verbatim inside the query. */
const W_TRIGGER_PHRASE = 0.5;
/** Per distinct query token that overlaps any trigger or synonym token. */
const W_TRIGGER_TOKEN = 0.2;
/** Cap for trigger token-overlap contribution. */
const W_TRIGGER_TOKEN_CAP = 0.3;
/** Per matching tag. */
const W_TAG = 0.15;
/** Cap for tag contribution. */
const W_TAG_CAP = 0.3;
/** skillId / filename token appears in the query. */
const W_SKILLID = 0.1;
/** Bonus when a trigger token lands in the first 3 query tokens. */
const W_POSITION_BONUS = 0.05;

/* ------------------------------------------------------------------ */
/* Stemmer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Strip common English suffixes so verb/noun variants map to the same stem.
 * Requires the post-strip remainder to be >= 5 characters to avoid
 * over-stemming short words (e.g. 'failing' must not become 'fail').
 * @param {string} token
 * @returns {string}
 */
function stem(token) {
  const SUFFIXES = ['ations', 'ation', 'tion', 'ness', 'ment', 'ing', 'ers', 'er', 'ed', 'es', 's'];
  for (const suffix of SUFFIXES) {
    if (token.length > suffix.length + 4 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/* ------------------------------------------------------------------ */
/* Query normalization                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalize a query string: lowercase, strip punctuation, split on whitespace,
 * and stem each token. Pure, no I/O.
 * @param {string} query
 * @returns {string[]} Normalized + stemmed tokens.
 */
export function normalizeQuery(query) {
  if (typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(stem);
}

/**
 * Build a Set of normalized+stemmed tokens from a list of phrases.
 * @param {string[]} phrases
 * @returns {Set<string>}
 */
function tokenSet(phrases) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const phrase of phrases) {
    for (const token of normalizeQuery(phrase)) set.add(token);
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* Core scorer                                                          */
/* ------------------------------------------------------------------ */

/**
 * True when `needleTokens` appear as a contiguous run of whole tokens inside
 * the joined query. Whole-token, space-delimited matching means a single-token
 * negative fires when that token is present, while a multi-token negative
 * ('write docs') fires ONLY when the full phrase appears contiguously — so it no
 * longer hard-excludes a skill on a bare shared token ('write'). Padding with
 * spaces prevents partial-token matches ('test' inside 'latest').
 * @param {string} joinedQuery  queryTokens.join(' ').
 * @param {string[]} needleTokens
 * @returns {boolean}
 */
function containsPhrase(joinedQuery, needleTokens) {
  if (needleTokens.length === 0) return false;
  return ` ${joinedQuery} `.includes(` ${needleTokens.join(' ')} `);
}

/**
 * Score a single SkillManifest against normalized query tokens.
 * A fired negative trigger is a hard exclusion (confidence = 0.0). Negatives
 * match at the PHRASE level: a multi-word negative fires only on a contiguous
 * whole-token match, not on any single shared token.
 * @param {SkillManifest} manifest
 * @param {string[]} queryTokens  Pre-normalized + stemmed tokens.
 * @returns {MatchResult}
 */
export function scoreManifest(manifest, queryTokens) {
  const triggers = Array.isArray(manifest.triggers) ? manifest.triggers : [];
  const tags = Array.isArray(manifest.tags) ? manifest.tags : [];
  const negatives = Array.isArray(manifest.negativeTriggers) ? manifest.negativeTriggers : [];
  const synonyms = Array.isArray(manifest.synonyms) ? manifest.synonyms : [];
  const priority = typeof manifest.priority === 'number' ? manifest.priority : 5;

  const querySet = new Set(queryTokens);
  const joinedQuery = queryTokens.join(' ');

  /** @type {MatchResult} */
  const base = {
    skillId: manifest.skillId,
    confidence: 0,
    reason: '',
    triggerFile: manifest.triggerFile,
    refFiles: Array.isArray(manifest.refFiles) ? manifest.refFiles : [],
    negativeTriggered: false,
    priority,
  };

  // --- Negative-trigger check: a negative phrase, matched contiguously as
  // whole tokens, excludes the skill. Multi-word negatives no longer fire on a
  // single shared token (the self-nuke that killed e.g. 'write code' via the
  // 'write docs' negative).
  for (const neg of negatives) {
    if (containsPhrase(joinedQuery, normalizeQuery(neg))) {
      return { ...base, confidence: 0, negativeTriggered: true, reason: `negative-trigger:'${neg}'` };
    }
  }

  let score = 0;
  /** @type {string[]} */
  const reasons = [];

  // --- Trigger exact phrase: normalized trigger phrase is a substring of the joined query.
  for (const trig of triggers) {
    const normTrig = normalizeQuery(trig).join(' ');
    if (normTrig !== '' && joinedQuery.includes(normTrig)) {
      score += W_TRIGGER_PHRASE;
      reasons.push(`trigger:'${trig}'`);
      break;
    }
  }

  // --- Trigger + synonym token overlap: distinct query tokens that match a
  // trigger/synonym token exactly OR morphologically (fails~failing,
  // vulnerabilities~vulnerability), the latter via trigram similarity so
  // inflected forms count without a stemmer.
  const allTriggerTokens = tokenSet([...triggers, ...synonyms]);
  const allTriggerTokensArr = [...allTriggerTokens];
  /** @param {string} qt @returns {boolean} */
  const matchesAnyTrigger = (qt) =>
    allTriggerTokens.has(qt) || allTriggerTokensArr.some((tt) => morphologicallyMatches(qt, tt));
  let overlap = 0;
  /** @type {Set<string>} */
  const counted = new Set();
  for (const t of queryTokens) {
    if (!counted.has(t) && matchesAnyTrigger(t)) {
      counted.add(t);
      overlap += 1;
    }
  }
  if (overlap > 0) {
    const add = Math.min(overlap * W_TRIGGER_TOKEN, W_TRIGGER_TOKEN_CAP);
    score += add;
    reasons.push(`trigger-tokens:${overlap}${synonyms.length > 0 ? '(+synonyms)' : ''}`);
  }

  // --- Position bonus: a trigger token (exact or morphological) appears in the
  // first 3 query tokens.
  if (queryTokens.slice(0, 3).some((t) => matchesAnyTrigger(t))) {
    score += W_POSITION_BONUS;
    reasons.push('position-bonus');
  }

  // --- Tag match: each tag whose normalized form appears in the query.
  let tagHits = 0;
  for (const tag of tags) {
    const tagTokens = normalizeQuery(tag);
    if (tagTokens.length > 0 && tagTokens.every((t) => querySet.has(t))) {
      tagHits += 1;
      reasons.push(`tag:'${tag}'`);
    }
  }
  if (tagHits > 0) score += Math.min(tagHits * W_TAG, W_TAG_CAP);

  // --- skillId / filename token match.
  const idTokens = normalizeQuery(manifest.skillId);
  if (idTokens.some((t) => querySet.has(t))) {
    score += W_SKILLID;
    reasons.push(`skillId:'${manifest.skillId}'`);
  }

  return {
    ...base,
    confidence: Math.min(Math.round(score * 10000) / 10000, 1),
    reason: reasons.join(', '),
    negativeTriggered: false,
    priority,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Score a query against every manifest and return the FULL ranked candidate
 * list — including negatively-triggered (excluded) candidates — sorted by
 * confidence descending, then priority ascending, then skillId. No filtering
 * and no slicing: this is the complete, honest decision surface the hook logs
 * to the decision ledger (so `negativeTriggered` exclusions are visible, not
 * silently dropped). Pure; no I/O.
 *
 * @param {string} query
 * @param {SkillManifest[]} manifests
 * @returns {MatchResult[]}
 */
export function scoreAll(query, manifests) {
  const queryTokens = normalizeQuery(query);
  return manifests
    .map((m) => scoreManifest(m, queryTokens))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (a.priority ?? 5) - (b.priority ?? 5) ||
        a.skillId.localeCompare(b.skillId),
    );
}

/**
 * Apply the operating point to a fully-scored candidate list: drop
 * negatively-triggered candidates, drop those below `minConfidence`, and cap
 * at `topN`. Pure; the inverse of `scoreAll`'s "keep everything".
 *
 * @param {MatchResult[]} scored  Output of `scoreAll` (already sorted).
 * @param {{ topN?: number, minConfidence?: number }} [opts]
 * @returns {MatchResult[]}
 */
export function selectMatches(scored, opts = {}) {
  const topN = typeof opts.topN === 'number' && opts.topN >= 0 ? opts.topN : 5;
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.1;
  return scored
    .filter((r) => !r.negativeTriggered && r.confidence >= minConfidence)
    .slice(0, topN);
}

/**
 * Match a query against all loaded manifests. Returns results sorted by
 * confidence descending (then by priority ascending, then skillId), filtered
 * to confidence >= minConfidence, capped at topN. Pure; no I/O — callers that
 * want telemetry log `scoreAll(...)` to the decision ledger themselves.
 *
 * @param {string} query
 * @param {SkillManifest[]} manifests
 * @param {{ topN?: number, minConfidence?: number }} [opts]
 * @returns {MatchResult[]}
 */
export function matchSkills(query, manifests, opts = {}) {
  return selectMatches(scoreAll(query, manifests), opts);
}
