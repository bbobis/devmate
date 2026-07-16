// @ts-check
import { estimateTokens } from '../context/estimate-tokens.mjs';

/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */
/** @typedef {import('../types.mjs').LoopAttemptEvent} LoopAttemptEvent */
/** @typedef {import('../types.mjs').CostSummary} CostSummary */

/**
 * Estimate the token cost for one loop attempt based on output size.
 * Delegates to the shared canonical estimator (UTF-8 bytes / 4, E9-09).
 * Returns 0 if outputBytes is not provided or is 0.
 * This is an estimate only — not a billing number.
 * @param {{ outputBytes: number }} opts
 * @returns {number}
 */
export function estimateAttemptTokens({ outputBytes }) {
  if (!outputBytes || outputBytes <= 0) return 0;
  return estimateTokens(outputBytes);
}

/**
 * Sum `tokenEstimate` across all `loop_attempt` entries in `traceEvents`.
 * Entries that lack `tokenEstimate` contribute 0.
 * When `opts.capLimit` is provided, sets `capExceeded = total >= capLimit`.
 * When `opts.capLimit` is undefined, `capExceeded` is always false and `capLimit`
 * is omitted from the result — the cost check is disabled.
 * @param {AnyLoopEvent[]} traceEvents
 * @param {{ capLimit?: number }} [opts]
 * @returns {CostSummary}
 */
export function sumCumulativeCost(traceEvents, opts) {
  const attempts = traceEvents.filter((e) => e.type === 'loop_attempt');

  let total = 0;
  for (const event of attempts) {
    const attempt = /** @type {LoopAttemptEvent} */ (event);
    total += attempt.tokenEstimate ?? 0;
  }

  const capLimit = opts?.capLimit;
  const capExceeded = capLimit != null ? total >= capLimit : false;

  /** @type {CostSummary} */
  const summary = {
    totalEstimatedTokens: total,
    attemptCount: attempts.length,
    capExceeded,
  };

  if (capLimit != null) {
    summary.capLimit = capLimit;
  }

  return summary;
}
