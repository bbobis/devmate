// @ts-check
// Pure staleness evaluation for the in-flight workflow (Fix B).
//
// A task left mid-flow (e.g. stuck at `impl-started` for days) should not force
// a Park / Abandon / Continue interrogation when the user brings an unrelated
// new task. This module decides whether the current task counts as "stale"
// given how long its state file has been idle. Age is measured from the
// `.devmate/state/task.json` mtime by callers — that directory is gitignored,
// so its mtime reliably reflects the last state mutation and is never reset by
// a VCS checkout. Pure: no I/O, no clock; the caller injects `mtimeMs`/`nowMs`.

/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */

/** Milliseconds per hour. */
const MS_PER_HOUR = 3_600_000;

/**
 * Gates that are NOT in-flight and therefore can never be stale: there is no
 * lane yet (`no-lane`) or the workflow already reached a terminal gate.
 * Everything else — including `parked` — is a resumable in-flight state whose
 * age is meaningful.
 * @type {ReadonlySet<WorkflowGate>}
 */
const NON_INFLIGHT_GATES = new Set(
  /** @type {WorkflowGate[]} */ (['no-lane', 'done', 'abandoned']),
);

/**
 * @typedef {Object} Staleness
 * @property {boolean} stale      True when the task is in-flight and idle past the threshold.
 * @property {number}  idleHours  Hours since the last state mutation (>= 0).
 */

/**
 * Evaluate whether the current in-flight task is stale.
 * @param {{ workflowGate: WorkflowGate, mtimeMs: number, nowMs: number, staleHours: number }} args
 * @returns {Staleness}
 */
export function evaluateStaleness({ workflowGate, mtimeMs, nowMs, staleHours }) {
  const idleHours = Math.max(0, (nowMs - mtimeMs) / MS_PER_HOUR);
  if (NON_INFLIGHT_GATES.has(workflowGate)) return { stale: false, idleHours };
  const threshold = typeof staleHours === 'number' && staleHours > 0 ? staleHours : Infinity;
  return { stale: idleHours >= threshold, idleHours };
}
