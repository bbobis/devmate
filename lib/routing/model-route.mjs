// @ts-check
// E16-6 (R6): cost-based cheap-vs-powerful model tiering.
//
// devmate already routes lanes (@router), turns (P14), and skills (P19-P22), and
// route-model (E9-11) surfaces an advisory budget-class → model-id hint. What was
// missing is the specific idea from Huyen (AI Engineering, ch10): route by
// COST/DIFFICULTY — a cheap model for easy work, a powerful model for hard work.
// This is the deterministic tier decision; the gateway seam (model-gateway.mjs) is
// the single place a future provider-failover implementation replaces.
//
// The tier is ADVISORY metadata: whether the plugin surface lets devmate actually
// select or fail over between models is platform-dependent and unverified, so this
// never forces a model switch — it produces the recommendation only. [UNVERIFIED]

import { MIN_ROUTER_CONFIDENCE } from './router.mjs';

/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */

/**
 * Difficulty at or above which the tier escalates to `powerful`, regardless of
 * budget class. Reuses the router's escalation convention
 * (`MIN_ROUTER_CONFIDENCE`, 0.75) rather than re-declaring the number — the same
 * shared-threshold pattern turn-intent follows (lib/routing/turn-intent.mjs:72) —
 * so there is one threshold, not two that can drift.
 * TODO: calibrate — provisional; from E14-2 telemetry mining of routing outcomes.
 * @type {number}
 */
export const DIFFICULTY_ESCALATION_THRESHOLD = MIN_ROUTER_CONFIDENCE;

/**
 * Choose a cost tier for a model call from routing signals. Deterministic: the
 * `large` budget class (heavy, multi-source work) or a difficulty at/above the
 * escalation threshold selects `powerful`; everything else selects `cheap`.
 * @param {{ budgetClass: 'tiny'|'standard'|'large', difficulty: number, lane: string }} signals
 * @returns {{ tier: 'cheap'|'powerful', reason: string }}
 */
export function chooseModelTier(signals) {
  const budgetClass = signals && typeof signals.budgetClass === 'string' ? signals.budgetClass : 'standard';
  const difficulty =
    signals && typeof signals.difficulty === 'number' && Number.isFinite(signals.difficulty)
      ? signals.difficulty
      : 0;
  const lane = signals && typeof signals.lane === 'string' && signals.lane !== '' ? signals.lane : 'unknown';

  if (budgetClass === 'large') {
    return { tier: 'powerful', reason: `large budget class (${lane}) → powerful` };
  }
  if (difficulty >= DIFFICULTY_ESCALATION_THRESHOLD) {
    return {
      tier: 'powerful',
      reason: `difficulty ${difficulty.toFixed(2)} ≥ ${DIFFICULTY_ESCALATION_THRESHOLD} → powerful`,
    };
  }
  return {
    tier: 'cheap',
    reason: `${budgetClass} class, difficulty ${difficulty.toFixed(2)} < ${DIFFICULTY_ESCALATION_THRESHOLD} → cheap`,
  };
}

/**
 * A budget-class → difficulty proxy, the FALLBACK used only when no real
 * difficulty signal is available yet (e.g. before the spec's acceptance criteria
 * are persisted): `large` is hard, `tiny` is easy. Prefer {@link deriveDifficulty}
 * when an AC count is on hand.
 * TODO: calibrate — provisional proxy.
 * @param {BudgetClass} budgetClass
 * @returns {number}
 */
export function difficultyFromBudgetClass(budgetClass) {
  if (budgetClass === 'large') return 0.9;
  if (budgetClass === 'tiny') return 0.1;
  return 0.5; // standard / unknown
}

/**
 * Acceptance-criterion count at which difficulty saturates to 1.0. With the
 * shared 0.75 escalation threshold this means ~6 ACs push any lane to `powerful`
 * regardless of budget class — a real, budget-class-independent difficulty
 * signal (more criteria = a harder task), unlike the budget-class proxy.
 * TODO: calibrate — provisional; set from E14-2 telemetry on AC count vs outcome.
 * @type {number}
 */
export const AC_DIFFICULTY_SATURATION = 8;

/**
 * Derive a difficulty in [0,1] from the real signals route-model has at dispatch.
 * The acceptance-criterion count is the primary signal (it varies within a budget
 * class and independently escalates the tier); when it is unavailable (`acCount`
 * 0 — the caller found no plan/spec ACs) it falls back to the budget-class proxy
 * so the tier is still populated. The caller owns where the count comes from
 * (route-model reads the approved plan at plan-approved; see readPlanAcCount).
 * @param {BudgetClass} budgetClass
 * @param {number} acCount  Number of acceptance criteria available at dispatch.
 * @returns {number}
 */
export function deriveDifficulty(budgetClass, acCount) {
  const count = typeof acCount === 'number' && Number.isFinite(acCount) && acCount > 0 ? acCount : 0;
  if (count === 0) return difficultyFromBudgetClass(budgetClass);
  return Math.min(1, count / AC_DIFFICULTY_SATURATION);
}
