// @ts-check
import { dirname, join } from "node:path";
import { appendTextFileSync, ensureDirSync } from "./fs-safe.mjs";

/** @typedef {import('./types.mjs').StateTransitionRecord} StateTransitionRecord */
/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */

/**
 * Safe-filename shape for a taskId, mirroring `TASK_ID_RE` in
 * `lib/memory/paths.mjs`: it must start with an alphanumeric and contain only
 * `[a-z0-9._-]`. That rejects a path separator or a leading `.` — so a tampered
 * `task.json` carrying `../` or an absolute-ish taskId cannot make the log write
 * escape the `transitions/` directory. `validateTaskState` only checks that
 * taskId is a non-empty string, so this filename guard is enforced here.
 */
const SAFE_TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * @param {string} taskId
 * @returns {boolean}
 */
export function isSafeTaskId(taskId) {
  return typeof taskId === "string" && SAFE_TASK_ID_RE.test(taskId);
}

/**
 * #112: the append-only per-task transition log lives beside `task.json` in a
 * `transitions/` sibling directory, one JSONL file per task id. Deriving it from
 * the state file's own directory (rather than a hardcoded repo path) keeps the
 * log self-contained under a caller-supplied temp `statePath` — the same
 * discipline `mutateTaskStateUnderLock` follows for the state file itself.
 * @param {string} statePath  Path to the `task.json` being mutated.
 * @param {string} taskId
 * @returns {string}  Absolute-or-relative path to `<stateDir>/transitions/<taskId>.jsonl`.
 */
export function transitionLogPath(statePath, taskId) {
  return join(dirname(statePath), "transitions", `${taskId}.jsonl`);
}

/**
 * Append one {@link StateTransitionRecord} as a JSONL line. Synchronous so it
 * commits inside the same lock body as the state write it records — the log line
 * and the version bump it describes are ordered together, never interleaved with
 * a concurrent writer's pair.
 *
 * The record is built here (not by the caller) so `toVersion` can never drift
 * from `fromVersion + 1` and `branchId` stays pinned to `taskId` until forked
 * branching (#113) supplies a real branch key.
 * @param {string} statePath
 * @param {{ taskId: string, fromVersion: number, toVersion: number, event: string, fromGate: WorkflowGate, toGate: WorkflowGate, ts: string }} fields
 * @returns {void}
 */
export function appendTransitionRecord(statePath, fields) {
  // Fail-closed on an unsafe taskId: the log is best-effort, so a tampered id
  // that could escape the transitions directory is dropped, never written.
  if (!isSafeTaskId(fields.taskId)) return;

  /** @type {StateTransitionRecord} */
  const record = {
    taskId: fields.taskId,
    branchId: fields.taskId,
    fromVersion: fields.fromVersion,
    toVersion: fields.toVersion,
    event: fields.event,
    fromGate: fields.fromGate,
    toGate: fields.toGate,
    ts: fields.ts,
  };
  const logPath = transitionLogPath(statePath, fields.taskId);
  ensureDirSync(dirname(logPath));
  appendTextFileSync(logPath, JSON.stringify(record) + "\n");
}
