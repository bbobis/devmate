// @ts-check
import { digestsEqual } from '../digest-compare.mjs';

/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */
/** @typedef {import('../types.mjs').LoopAttemptEvent} LoopAttemptEvent */
/** @typedef {import('../types.mjs').NoProgressResult} NoProgressResult */

/**
 * Compare `currentDigest` against the output digests of all prior `loop_attempt`
 * entries in `traceEvents` whose `attemptId !== currentAttemptId`.
 *
 * Returns { noProgress: true } only when an exact digest match exists in a PRIOR entry.
 * A first-ever failure (no prior entries) always returns { noProgress: false }.
 *
 * INVARIANT: callers MUST invoke this function BEFORE appending the current attempt's
 * trace entry. If the current attempt is already written, pass its `attemptId` so it
 * is excluded from comparison. Never compare the current attempt against itself.
 *
 * @param {{
 *   currentAttemptId: string,
 *   currentDigest: string,
 *   traceEvents: AnyLoopEvent[],
 * }} opts
 * @returns {NoProgressResult}
 */
export function detectNoProgress({ currentAttemptId, currentDigest, traceEvents }) {
  const priorAttempts = traceEvents.filter(
    (e) => e.type === 'loop_attempt' && e.attemptId !== currentAttemptId
  );

  for (const event of priorAttempts) {
    const attempt = /** @type {LoopAttemptEvent} */ (event);
    if (digestsEqual(attempt.outputDigest, currentDigest)) {
      return {
        noProgress: true,
        matchedAttemptId: attempt.attemptId,
        currentDigest,
      };
    }
  }

  return {
    noProgress: false,
    matchedAttemptId: null,
    currentDigest,
  };
}
