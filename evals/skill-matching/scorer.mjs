// @ts-check
/**
 * Skill-matching eval scorer (pure, no I/O). Mirrors the gate-robustness /
 * issue-quality convention: a pure function returning a typed result.
 *
 * Grades the matcher against a labelled corpus of phrasings, each tagged with
 * the skill it should (or must not) surface and a defect bucket. It reports the
 * three numbers the redesign is measured on:
 *   - recall     — of the phrasings that SHOULD load a skill, how many did
 *   - precision  — of the phrasings that must NOT load a skill, how many stayed out
 *   - suppressRate — of the "should load" phrasings, how many produced ZERO
 *                    matches (the safety failure: a zero-match prompt triggers
 *                    the suppressive "do not preload" hint). neverFalseSuppress
 *                    is the target property (suppressRate === 0).
 *
 * The scorer is agnostic to the operating point: the caller supplies a `run`
 * closure that already applies it, so the suite measures the exact production
 * topN / minConfidence from lib/skills/operating-point.mjs.
 */

/** @typedef {import('../../lib/types.mjs').MatchResult} MatchResult */

/**
 * @typedef {Object} SkillMatchingCase
 * @property {string} phrasing  A realistic user prompt.
 * @property {string} skillId   The skill this case is about.
 * @property {'match'|'no-match'} expect  Whether `skillId` should be surfaced.
 * @property {string} bucket    Defect bucket (morphology, substring, stopword, negative, paraphrase, state-rescue, ...).
 * @property {import('../../lib/types.mjs').MatchContext} [context]  Optional workflow state for Stage-2 re-rank cases.
 */

/**
 * @typedef {Object} BucketScore
 * @property {number|null} recall       matchPassed / matchTotal, or null when matchTotal is 0.
 * @property {number|null} precision    noMatchPassed / noMatchTotal, or null when noMatchTotal is 0.
 * @property {number} matchTotal
 * @property {number} noMatchTotal
 */

/**
 * @typedef {Object} SkillMatchingScore
 * @property {number} recall               Over all expect:'match' cases.
 * @property {number} precision            Over all expect:'no-match' cases.
 * @property {number} suppressRate         Fraction of expect:'match' cases returning zero results.
 * @property {boolean} neverFalseSuppress  True iff suppressRate === 0.
 * @property {Record<string, BucketScore>} perBucket
 * @property {Array<{ phrasing: string, skillId: string, expect: string, bucket: string, passed: boolean, suppressed: boolean }>} perCase
 */

/**
 * Round to 4dp — repo house style, and stops float noise from breaking the CI gate.
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Score a labelled corpus against a matcher closure.
 * @param {SkillMatchingCase[]} cases
 * @param {(phrasing: string, context?: import('../../lib/types.mjs').MatchContext) => MatchResult[]} run  Returns the operating-point-filtered matches.
 * @returns {SkillMatchingScore}
 */
export function scoreSkillMatching(cases, run) {
  let matchTotal = 0;
  let matchPassed = 0;
  let noMatchTotal = 0;
  let noMatchPassed = 0;
  let suppressed = 0;

  /** @type {Map<string, { matchTotal: number, matchPassed: number, noMatchTotal: number, noMatchPassed: number }>} */
  const buckets = new Map();
  /** @type {SkillMatchingScore['perCase']} */
  const perCase = [];

  for (const c of cases) {
    const ids = run(c.phrasing, c.context).map((r) => r.skillId);
    const present = ids.includes(c.skillId);
    let b = buckets.get(c.bucket);
    if (b === undefined) {
      b = { matchTotal: 0, matchPassed: 0, noMatchTotal: 0, noMatchPassed: 0 };
      buckets.set(c.bucket, b);
    }

    let passed;
    let isSuppressed = false;
    if (c.expect === 'match') {
      passed = present;
      isSuppressed = ids.length === 0;
      matchTotal += 1;
      b.matchTotal += 1;
      if (passed) {
        matchPassed += 1;
        b.matchPassed += 1;
      }
      if (isSuppressed) suppressed += 1;
    } else {
      passed = !present;
      noMatchTotal += 1;
      b.noMatchTotal += 1;
      if (passed) {
        noMatchPassed += 1;
        b.noMatchPassed += 1;
      }
    }

    perCase.push({ phrasing: c.phrasing, skillId: c.skillId, expect: c.expect, bucket: c.bucket, passed, suppressed: isSuppressed });
  }

  /** @type {Record<string, BucketScore>} */
  const perBucket = Object.fromEntries(
    [...buckets.entries()].map(([name, b]) => [
      name,
      {
        recall: b.matchTotal === 0 ? null : round4(b.matchPassed / b.matchTotal),
        precision: b.noMatchTotal === 0 ? null : round4(b.noMatchPassed / b.noMatchTotal),
        matchTotal: b.matchTotal,
        noMatchTotal: b.noMatchTotal,
      },
    ]),
  );

  const suppressRate = matchTotal === 0 ? 0 : round4(suppressed / matchTotal);
  return {
    recall: matchTotal === 0 ? 1 : round4(matchPassed / matchTotal),
    precision: noMatchTotal === 0 ? 1 : round4(noMatchPassed / noMatchTotal),
    suppressRate,
    neverFalseSuppress: suppressRate === 0,
    perBucket,
    perCase,
  };
}
