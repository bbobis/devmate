// @ts-check

/** @typedef {'feature' | 'bug' | 'chore'} Lane */

/** @typedef {object} RouterResult
 * @property {Lane} lane           Classified lane.
 * @property {string} budgetClass  Budget class string from model policy.
 * @property {number} confidence   0–1 confidence score. Below 0.75 = ask human.
 */

/** Minimum router confidence to proceed without human escalation.
 *  @type {number} */
export const MIN_ROUTER_CONFIDENCE = 0.75; // TODO: calibrate after E7-2 routing evals — provisional placeholder

const VALID_LANES = new Set(['feature', 'bug', 'chore']);
const BUDGET_CLASSES = new Set(['tiny', 'standard', 'large']);

/**
 * Parse and validate a raw router subagent result object.
 * Returns { ok: false, error } when required fields are missing or invalid.
 * @param {unknown} raw
 * @returns {{ ok: true, result: RouterResult } | { ok: false, error: string }}
 */
export function parseRouterResult(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: `Router result must be a JSON object, got ${typeof raw}`,
    };
  }

  const result = /** @type {Record<string, unknown>} */ (raw);

  // Validate lane
  const lane = result.lane;
  if (typeof lane !== 'string' || !VALID_LANES.has(lane)) {
    return {
      ok: false,
      error: `Router result lane must be one of "feature", "bug", or "chore", got ${JSON.stringify(lane)}`,
    };
  }

  // Validate budgetClass
  const budgetClass = result.budgetClass;
  if (typeof budgetClass !== 'string' || budgetClass.trim() === '' || !BUDGET_CLASSES.has(budgetClass)) {
    return {
      ok: false,
      error: `Router result budgetClass must be one of ["tiny", "standard", "large"], got ${JSON.stringify(budgetClass)}`,
    };
  }

  // Validate confidence
  const confidence = result.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      ok: false,
      error: `Router result confidence must be a finite number between 0 and 1, got ${JSON.stringify(confidence)}`,
    };
  }

  return {
    ok: true,
    result: {
      lane: /** @type {Lane} */ (lane),
      budgetClass: /** @type {string} */ (budgetClass),
      confidence,
    },
  };
}

/**
 * Classify a task description into a lane using the @router subagent.
 * The router subagent must return a RouterResult JSON object.
 * TODO: calibrate after E7-2 routing evals — 0.75 is a provisional placeholder
 * @param {string} taskDescription
 * @param {{ dispatch?: (agent: string, input: unknown) => Promise<unknown> }} [opts]
 * @returns {Promise<{ ok: true, result: RouterResult } | { ok: false, error: string }>}
 */
export async function classifyLane(taskDescription, opts) {
  if (!opts?.dispatch) {
    return {
      ok: false,
      error: 'classifyLane: no dispatch function provided',
    };
  }

  try {
    const response = await opts.dispatch('router', { task_description: taskDescription });
    return parseRouterResult(response);
  } catch (/** @type {any} */ err) {
    return {
      ok: false,
      error: `classifyLane: dispatch failed — ${err?.message || String(err)}`,
    };
  }
}
