// @ts-check
// E16-7 (R7): bias guards for any LLM-as-judge / comparative-scoring path.
//
// Huyen (AI Engineering, ch3) catalogs reproducible judge failure modes:
// position/first-answer bias, verbosity bias, self-bias, and non-reproducibility.
// Her guidance — supplement a judge with exact/human eval, keep FUNCTIONAL
// CORRECTNESS (tests pass) as the anchor, never trust a judge as the sole gate.
// devmate already centers exact eval (the `verification-passed` tests-green gate)
// and every current eval scorer is deterministic — there is no LLM judge in-tree
// today. This is the REUSABLE harness any future judge-based eval routes through.
//
// Deterministic by construction: the presentation-order shuffle is seeded by the
// case index (no `Math.random`), so a debiased comparison is reproducible.

/**
 * Provisional verbosity length-penalty coefficient. A longer answer must be
 * *better*, not merely *bigger*, to win: its score is reduced in proportion to
 * how much longer it is than its rival.
 * TODO: calibrate — provisional; set from a measured judge run's verbosity effect size.
 * @type {number}
 */
export const VERBOSITY_NORMALIZATION_ALPHA = 0.1;

/**
 * A cheap deterministic per-index bit (splitmix-style hash), so the swap pattern
 * is not a trivial parity yet is fully reproducible — no `Math.random`.
 * @param {number} index
 * @returns {boolean} true → present this case's pair swapped
 */
function shouldSwap(index) {
  let x = (index + 1) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x & 1) === 1;
}

/**
 * Randomize the presentation order of paired judge inputs (position-bias guard)
 * and return the per-case swap flags needed to map verdicts back to the original
 * `a`/`b` identity. Deterministic: the same `cases` always shuffle the same way.
 * @param {Array<{ a: unknown, b: unknown }>} cases
 * @returns {{ presented: Array<{ first: unknown, second: unknown }>, undo: number[] }}
 *   `undo[i]` is 1 when case `i` was presented swapped (presented.first is the
 *   original `b`), else 0. Pair it with {@link resolveWinner}.
 */
export function debiasComparison(cases) {
  const list = Array.isArray(cases) ? cases : [];
  /** @type {Array<{ first: unknown, second: unknown }>} */
  const presented = [];
  /** @type {number[]} */
  const undo = [];
  list.forEach((pair, index) => {
    if (shouldSwap(index)) {
      presented.push({ first: pair.b, second: pair.a });
      undo.push(1);
    } else {
      presented.push({ first: pair.a, second: pair.b });
      undo.push(0);
    }
  });
  return { presented, undo };
}

/**
 * Map a judge verdict on a PRESENTED pair back to the original `a`/`b` identity,
 * so a flipped presentation order never changes the resolved winner.
 * @param {'first'|'second'} verdict  Which presented side the judge picked.
 * @param {number|boolean} swapped  The `undo[i]` flag from {@link debiasComparison}
 *   (`0`/`1`); a boolean is also accepted so a caller can't silently misread it.
 * @returns {'a'|'b'}
 */
export function resolveWinner(verdict, swapped) {
  const wasSwapped = Boolean(swapped);
  if (verdict === 'first') return wasSwapped ? 'b' : 'a';
  return wasSwapped ? 'a' : 'b';
}

/**
 * Verbosity-bias guard: penalize the longer answer's score in proportion to its
 * length excess over the rival, so a longer answer must score higher on merit to
 * still win. Pure; returns adjusted copies, never mutates.
 * @param {number} scoreA
 * @param {number} scoreB
 * @param {number} lenA  Length of answer A (chars/tokens — the caller's unit).
 * @param {number} lenB
 * @param {number} [alpha]  Penalty coefficient; defaults to VERBOSITY_NORMALIZATION_ALPHA.
 * @returns {{ scoreA: number, scoreB: number }}
 */
export function normalizeForLength(scoreA, scoreB, lenA, lenB, alpha = VERBOSITY_NORMALIZATION_ALPHA) {
  const a = Number.isFinite(scoreA) ? scoreA : 0;
  const b = Number.isFinite(scoreB) ? scoreB : 0;
  const la = Number.isFinite(lenA) && lenA > 0 ? lenA : 0;
  const lb = Number.isFinite(lenB) && lenB > 0 ? lenB : 0;
  const k = Number.isFinite(alpha) && alpha > 0 ? alpha : 0;
  const denom = Math.max(la, lb, 1);
  const excessA = Math.max(0, (la - lb) / denom); // >0 only when A is the longer one
  const excessB = Math.max(0, (lb - la) / denom);
  return { scoreA: a - k * excessA, scoreB: b - k * excessB };
}

/**
 * @typedef {Object} PinnedJudge
 * @property {string} model    The judge model id (e.g. 'claude-sonnet-5').
 * @property {string} version  The judge model version/date, for reproducibility.
 * @property {string|null} pinnedAt  Injected timestamp (no Date.now in a snapshotted path).
 * @property {string} anchor   A standing reminder that the judge is a supplement, not the gate.
 */

/**
 * Self-bias / non-reproducibility guard: record the exact judge model id + version
 * with each judged run so a score stays interpretable when the judge is later
 * re-versioned, and restate that a judge NEVER overrides functional correctness.
 * @param {{ model?: string, version?: string, pinnedAt?: string }} [config]
 * @returns {PinnedJudge}
 */
export function pinJudge(config = {}) {
  return {
    model: typeof config.model === 'string' && config.model !== '' ? config.model : 'unknown',
    version: typeof config.version === 'string' && config.version !== '' ? config.version : 'unknown',
    pinnedAt: typeof config.pinnedAt === 'string' && config.pinnedAt !== '' ? config.pinnedAt : null,
    anchor:
      'A judge is a supplement, never the sole gate; functional correctness ' +
      '(tests pass) is the anchor and overrides a judge verdict for a code artifact.',
  };
}

/**
 * Functional-correctness tie-breaker: when a CODE artifact is under judgment and
 * exactly one side passes its tests, that side wins regardless of the judge. Only
 * when both pass or both fail does the (debiased) judge verdict stand.
 * @param {'a'|'b'} judgeWinner  The judge's mapped winner.
 * @param {boolean} aPasses  Whether artifact A passes functional tests.
 * @param {boolean} bPasses
 * @returns {'a'|'b'}
 */
export function functionalTieBreak(judgeWinner, aPasses, bPasses) {
  if (aPasses && !bPasses) return 'a';
  if (bPasses && !aPasses) return 'b';
  return judgeWinner;
}
