// @ts-check
// DN-2: lexical task→domain matching. Ranks the configured business domains
// (DN-1's `domains` section of devmate.config.json) against a task's text and
// its known seed files, so the hook boundary can advertise which domains a
// task touches via `.devmate/state/domain-context.json` (pointers, not
// payloads — TCM-3). Imitates the additive-prior scoring style of
// lib/skills/context-rank.mjs and reuses the semantic-matcher's normalization
// plus the trigram morphological matcher — never forks that logic.
//
// This module is pure and I/O-free: no fs, no Date, no randomness. Timestamps
// are injected by the hook-boundary caller (repo determinism rule).

import { normalizeQuery } from '../skills/semantic-matcher.mjs';
import { morphologicallyMatches } from '../skills/trigram.mjs';
import { matchGlob } from '../gate-guard-core.mjs';

/** @typedef {import('../types.mjs').DomainConfig} DomainConfig */
/** @typedef {import('../types.mjs').DomainMatch} DomainMatch */

/* ------------------------------------------------------------------ */
/* Operating point                                                      */
/* ------------------------------------------------------------------ */

/** Maximum number of domain matches surfaced per task. */
// TODO: calibrate after the first month of real domain configs — provisional placeholder
export const DOMAIN_MATCH_TOP_N = 2;

/**
 * Minimum score a domain must reach to be surfaced (mirrors
 * SKILL_MATCH_MIN_CONFIDENCE, lib/skills/operating-point.mjs).
 */
// TODO: calibrate after the first month of real domain configs — provisional placeholder
export const DOMAIN_MATCH_MIN_SCORE = 0.25;

/* ------------------------------------------------------------------ */
/* Scoring weights (additive, total capped at 1.0)                      */
/* ------------------------------------------------------------------ */

/** Per config keyword that hits the task text (exact or morphological). */
// TODO: calibrate after DN-5 eval fixtures exist — provisional placeholder
const KEYWORD_WEIGHT = 0.2;

/** Cap for the keyword-hit contribution. */
// TODO: calibrate after DN-5 eval fixtures exist — provisional placeholder
const KEYWORD_WEIGHT_CAP = 0.5;

/** Any seed file matching one of the domain's globs. */
// TODO: calibrate after DN-5 eval fixtures exist — provisional placeholder
const GLOB_WEIGHT = 0.4;

/** The domain id appears verbatim in the task text. */
// TODO: calibrate after DN-5 eval fixtures exist — provisional placeholder
const ID_WEIGHT = 0.2;

/** @param {number} n @returns {number} */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * True when every token of `needleTokens` matches a task token — exact set
 * membership or morphological (fails~failing, invoices~invoice) via the
 * trigram matcher.
 * @param {string[]} needleTokens  Normalized tokens of one keyword.
 * @param {Set<string>} taskTokenSet
 * @param {string[]} taskTokens
 * @returns {boolean}
 */
function keywordHits(needleTokens, taskTokenSet, taskTokens) {
  if (needleTokens.length === 0) return false;
  return needleTokens.every(
    (nt) => taskTokenSet.has(nt) || taskTokens.some((tt) => morphologicallyMatches(tt, nt)),
  );
}

/**
 * Rank configured domains against a task.
 * Deterministic and pure: no fs, no Date, no randomness.
 *
 * Scoring (additive, capped at 1.0):
 *  - keyword token overlap with taskText (exact or morphological via existing
 *    trigram matcher), weight per hit KEYWORD_WEIGHT, capped
 *  - seedFile glob hit: any seed file matching a domain glob, weight GLOB_WEIGHT
 *  - domain id token appears verbatim in taskText: ID_WEIGHT
 *
 * @param {Object} input
 * @param {string} input.taskText     User prompt / task statement.
 * @param {string[]} input.seedFiles  Repo-relative paths already known relevant (may be []).
 * @param {import('../types.mjs').DomainConfig[]} input.domains  From devmate.config.json.
 * @returns {DomainMatch[]}  Sorted desc by score, filtered to score >= DOMAIN_MATCH_MIN_SCORE,
 *                           capped at DOMAIN_MATCH_TOP_N. [] when domains is empty.
 */
export function resolveActiveDomains(input) {
  const taskText = typeof input.taskText === 'string' ? input.taskText : '';
  const seedFiles = Array.isArray(input.seedFiles) ? input.seedFiles : [];
  const domains = Array.isArray(input.domains) ? input.domains : [];
  if (domains.length === 0) return [];

  const taskTokens = normalizeQuery(taskText);
  const taskTokenSet = new Set(taskTokens);
  const joinedTask = taskTokens.join(' ');
  // matchGlob normalizes path separators on both arguments itself
  // (lib/gate-guard-core.mjs), so Windows-separated seed paths match
  // without pre-normalization here.
  const seeds = seedFiles.filter((f) => typeof f === 'string');

  /** @type {DomainMatch[]} */
  const scored = [];
  for (const domain of domains) {
    const keywords = Array.isArray(domain.keywords) ? domain.keywords : [];
    const globs = Array.isArray(domain.globs) ? domain.globs : [];

    let score = 0;

    /** @type {string[]} */
    const matchedKeywords = [];
    for (const keyword of keywords) {
      if (keywordHits(normalizeQuery(keyword), taskTokenSet, taskTokens)) {
        matchedKeywords.push(keyword);
      }
    }
    if (matchedKeywords.length > 0) {
      score += Math.min(matchedKeywords.length * KEYWORD_WEIGHT, KEYWORD_WEIGHT_CAP);
    }

    /** @type {string[]} */
    const matchedGlobs = [];
    for (const glob of globs) {
      if (seeds.some((f) => matchGlob(glob, f))) matchedGlobs.push(glob);
    }
    if (matchedGlobs.length > 0) score += GLOB_WEIGHT;

    // Verbatim id match: the normalized id tokens appear as a contiguous
    // whole-token run in the task text (space padding prevents partial-token
    // hits, mirroring the semantic-matcher's phrase check).
    const idTokens = normalizeQuery(domain.domain);
    if (idTokens.length > 0 && ` ${joinedTask} `.includes(` ${idTokens.join(' ')} `)) {
      score += ID_WEIGHT;
    }

    scored.push({
      domain: domain.domain,
      score: round4(Math.min(score, 1)),
      matchedKeywords,
      matchedGlobs,
      contextFile: domain.contextFile ?? null,
      relatedDomains: Array.isArray(domain.relatedDomains) ? domain.relatedDomains : [],
    });
  }

  return scored
    .filter((m) => m.score >= DOMAIN_MATCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
    .slice(0, DOMAIN_MATCH_TOP_N);
}
