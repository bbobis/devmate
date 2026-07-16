// @ts-check
// E5-1 (with E10 re-spec #90): bug-lane fixer handoff.
//
// After @diagnose runs, this module turns its typed output (DiagnosisResult)
// into a deterministic dispatch to the SINGLE generic fixer agent
// (`agents/fullstack.agent.md`). The persona that should perform the
// fix is carried as dispatch INPUT (a string from devmate.config.json), not
// encoded in an agent name.
//
// E10 reconciliation (anti-hallucination):
//  - `BugScope` is an open, config-sourced persona string (+ 'unknown'), NOT a
//    fixed backend|frontend|editor enum.
//  - There is ONE fixer target: '@fullstack'. selectFixer returns
//    { target: '@fullstack', persona, reason }.
//  - Edit-scope enforcement is handled uniformly by the gate-guard reading
//    .devmate/session/{taskId}/scope.md — the unified P06 contract. The
//    previous `enforceBugScope` predicate has been removed; use enforceScope
//    from lib/workflow/scope.mjs or the gate-guard's evaluateGuard directly.
//  - The bug lane uses the real WorkflowGate values; no diagnosis-complete /
//    fixer-dispatched gates are invented. The handoff is a dispatch record +
//    trace event, persisted into TaskState alongside the existing gates.

import { appendJsonl } from "../memory/append-jsonl.mjs";
import { writeTaskState } from "../task-state.mjs";
import { validateDiagnosisResult } from "./contracts.mjs";

/** @typedef {import('../types.mjs').DiagnosisResult} DiagnosisResult */
/** @typedef {import('../types.mjs').FixerTarget} FixerTarget */
/** @typedef {import('../types.mjs').FixerSelection} FixerSelection */
/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */

/** The single, generic fixer agent dispatched N times with a persona input. */
export const FIXER_TARGET = /** @type {FixerTarget} */ ("@fullstack");

/** The literal scope value used when diagnosis cannot pin a persona. */
export const UNKNOWN_SCOPE = "unknown";

/**
 * Default JSONL log for bug-handoff trace events. Plain JSONL via the shared
 * appendJsonl writer (decoupled from loop-trace KNOWN_TYPES). Override with
 * DEVMATE_TRANSITIONS_PATH.
 * @type {string}
 */
const DEFAULT_TRANSITIONS_PATH = ".devmate/state/transitions.jsonl";

// Shared non-throwing validator surface.
export { validateDiagnosisResult } from "./contracts.mjs";

/**
 * Backward-compat adapter for callers that rely on throw-on-invalid behavior.
 * @param {unknown} obj
 * @returns {DiagnosisResult}
 */
export function assertDiagnosisResult(obj) {
  const { ok, errors } = validateDiagnosisResult(obj);
  if (!ok) {
    throw new TypeError(
      `DiagnosisResult missing required field(s): ${errors.join(", ")}.`,
    );
  }
  return /** @type {DiagnosisResult} */ (obj);
}

/**
 * Select the fixer agent from a validated DiagnosisResult.
 *
 * There is exactly one agent ('@fullstack'); the diagnosed persona is returned
 * as a separate field so the orchestrator dispatches the generic agent with
 * that persona pre-filled. An 'unknown' scope still routes to '@fullstack' but
 * the reason flags that a human must confirm the persona before editing.
 *
 * @param {DiagnosisResult} diagnosis
 * @returns {FixerSelection}
 */
export function selectFixer(diagnosis) {
  const persona = diagnosis.bugScope;
  if (persona === UNKNOWN_SCOPE) {
    return {
      target: FIXER_TARGET,
      persona: UNKNOWN_SCOPE,
      reason:
        "Diagnosis could not pin a persona; dispatching @fullstack with " +
        "'unknown' scope. Human confirmation of the persona is required before edits.",
    };
  }
  return {
    target: FIXER_TARGET,
    persona,
    reason: `Dispatching @fullstack as persona '${persona}' from diagnosis.`,
  };
}

/**
 * Persist diagnosis to TaskState and emit a handoff trace record.
 *
 * Writes `bugScope` and `fixerTarget` onto the state (extra keys are preserved
 * by validateTaskState), persists atomically via the shared writer, and appends
 * a compact `bug_handoff` trace event. Never embeds full diagnosis prose in the
 * trace — only a pointer (taskId) and the routing fields.
 *
 * @param {DiagnosisResult} diagnosis
 * @param {TaskState} state
 * @param {object} [opts]
 * @param {string} [opts.statePath]
 * @param {string} [opts.transitionsPath]
 * @returns {Promise<{ target: FixerTarget, persona: string, stateUpdated: boolean }>}
 */
export async function dispatchFixer(diagnosis, state, opts = {}) {
  const validated = assertDiagnosisResult(diagnosis);
  const selection = selectFixer(validated);

  /** @type {TaskState & { bugScope?: string, fixerTarget?: string }} */
  const next = {
    ...state,
    bugScope: validated.bugScope,
    fixerTarget: selection.target,
  };
  await writeTaskState(next, opts.statePath);

  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "bug_handoff",
    taskId: validated.taskId,
    bugScope: validated.bugScope,
    target: selection.target,
    persona: selection.persona,
    ts: Date.now(),
  }).catch(() => {});

  return {
    target: selection.target,
    persona: selection.persona,
    stateUpdated: true,
  };
}


