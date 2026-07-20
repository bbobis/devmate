// @ts-check
// E5-2: Chore lane orchestration — make chore continuation a non-reset action.
//
// After a chore reaches the `plan-approved` gate, the orchestrator must continue
// execution WITHOUT discarding the approved plan. The legacy advice was to run
// `/quick-task`, which state-control treats as a new-task reset, silently wiping
// the approved plan and all prior context. This module replaces that with a
// dedicated, non-reset continuation (`continueApprovedChore`) plus a guard
// (`guardChoreReset`) that aborts any reset command while a chore plan is approved.
//
// Reconciliation note (anti-hallucination): the autonomous spec's `ChoreGate`
// union (`plan-approved|executing|complete|escalated`) does NOT match the live
// codebase. The real workflow gates are defined in `lib/types.mjs` as
// `WorkflowGate` (`plan-approved|impl-started|verification-passed|pr-ready|done`)
// and the only legal post-approval transition for the chore lane is
// `plan-approved --start-impl--> impl-started` (see `lib/gate-transitions.mjs`).
// We therefore continue an approved chore to `impl-started` — the real
// "executing" gate — using the shared `transitionGate` utility (E1-2 #12) and
// the shared atomic state writer (E1-1 #11). No new gate names are invented.

import { resolve } from "node:path";
import { transitionGate } from "../../gate-transitions.mjs";
import { appendJsonl } from "../../memory/append-jsonl.mjs";
import { writeTaskState } from "../../task-state.mjs";
import {
  resolveWorkspacePaths as resolveWorkspacePathsFor,
  writeScope,
} from "../scope-writer.mjs";

/** @typedef {import('../../types.mjs').TaskState} TaskState */
/** @typedef {import('../../types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../types.mjs').ChoreException} ChoreException */
/** @typedef {import('../../types.mjs').DevmateConfig} DevmateConfig */

/**
 * The live "approved, ready to execute" gate for the chore lane.
 * @type {WorkflowGate}
 */
export const CHORE_PLAN_APPROVED = "plan-approved";

/**
 * The live gate a chore advances to when execution begins. This is the real
 * codebase equivalent of the spec's `executing` ChoreGate.
 * @type {WorkflowGate}
 */
export const CHORE_EXECUTING = "impl-started";

/**
 * The gate-transition event that advances `plan-approved` -> `impl-started`.
 * @type {import('../../types.mjs').GateEvent}
 */
const START_IMPL_EVENT = "start-impl";

/**
 * Default JSONL log for gate-transition trace events. Decoupled from the loop
 * trace schema (KNOWN_TYPES) on purpose — a `gate_transition` event is plain
 * JSONL appended via the shared `appendJsonl` writer, mirroring #27/#29.
 * Override with `DEVMATE_TRANSITIONS_PATH`.
 * @type {string}
 */
const DEFAULT_TRANSITIONS_PATH = ".devmate/state/transitions.jsonl";

/**
 * The canonical, non-reset command the orchestrator must recommend after a
 * chore reaches `plan-approved`. Never recommend a reset command here.
 * @type {string}
 */
export const CHORE_CONTINUE_COMMAND = "/devmate-chore-continue";

/**
 * List of command names that trigger a full task reset.
 * `guardChoreReset` blocks these when a chore is `plan-approved`.
 * Single source of truth — tests assert completeness against this export.
 * @type {readonly string[]}
 */
export const RESET_COMMANDS = /** @type {const} */ ([
  "/quick-task",
  "new-task",
  "/devmate-new",
  "reset-state",
]);

/**
 * Guard: if `state.lane === 'chore'` and `state.workflowGate === 'plan-approved'`
 * and `commandName` is a reset command, block the action and return a
 * human-readable reason. Returns `null` to allow (proceed).
 *
 * Hook point: state-control dispatch must call this BEFORE running any command,
 * aborting when a non-null string is returned.
 * // TODO(E1-2 #12): wire this into the state-control dispatch path.
 *
 * @param {TaskState} state
 * @param {string} commandName   The command or action being attempted.
 * @returns {string|null}        Null = proceed; string = block reason.
 */
export function guardChoreReset(state, commandName) {
  if (
    state.lane === "chore" &&
    state.workflowGate === CHORE_PLAN_APPROVED &&
    RESET_COMMANDS.includes(commandName)
  ) {
    // #130: name the REAL runtime moves — the approval-listener phrases —
    // not the phantom slash commands this message used to advertise (nothing
    // could run them; see docs/chore-escalation.md).
    return (
      `Cannot run '${commandName}' — chore plan is approved. ` +
      `Reply "approve plan" to proceed, or "escalate chore to feature: <reason>" to convert to a feature.`
    );
  }
  return null;
}

/**
 * Advance an approved chore into the executing phase without resetting state.
 *
 * Steps:
 *  1. Assert the gate is `plan-approved` (refuse to re-advance).
 *  2. Transition `plan-approved -> impl-started` via the shared pure utility.
 *  3. Persist the updated state atomically (shared file-locked writer).
 *  4. Append a `gate_transition` trace event (plain JSONL, decoupled schema).
 *
 * @param {TaskState} state
 * @param {object} [opts]
 * @param {string} [opts.statePath]        Override TaskState path (tests).
 * @param {string} [opts.transitionsPath]  Override transitions log path (tests).
 * @returns {Promise<TaskState>}           The persisted, advanced state.
 */
export async function continueApprovedChore(state, opts = {}) {
  if (state.workflowGate !== CHORE_PLAN_APPROVED) {
    throw new Error(
      `continueApprovedChore: gate must be '${CHORE_PLAN_APPROVED}', got ` +
        `'${state.workflowGate}'. Refusing to re-advance.`,
    );
  }

  const result = await transitionGate(state, START_IMPL_EVENT);
  if (!result.ok || !result.state) {
    throw new Error(`continueApprovedChore: ${result.error}`);
  }
  const next = result.state;

  await writeTaskState(next, opts.statePath);

  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "gate_transition",
    from: result.from,
    to: result.to,
    lane: "chore",
    taskId: next.taskId,
    ts: Date.now(),
  }).catch(() => {});

  return next;
}

// ---- E5-3: chore escalation + scoped exceptions ----
//
// User-facing phrases (parsed by the orchestrator):
//   "escalate chore to feature"            -> escalateChoreToFeature()
//   "approved exception: <desc> for <path>" -> approveChoreException()
//
// Anti-hallucination reconciliation: the spec's escalation target gate
// 'tech-design' is NOT a real WorkflowGate. The live union is
// plan-approved|impl-started|verification-passed|pr-ready|done. A chore
// escalating to the feature lane re-enters at the real feature start gate
// 'plan-approved' (a fresh plan must be approved for the wider feature scope).

/** Required prefix for a valid exception approval phrase. */
export const EXCEPTION_APPROVAL_PREFIX = "approved exception:";

/**
 * B5: Resolve workspace-relative paths for multi-root workspaces.
 *
 * In multi-root mode each persona targets a specific repo subdirectory
 * (e.g. `api/` or `web/`). The proposedFiles list arriving from the
 * orchestrator is repo-relative (e.g. `src/index.ts`). The gate-guard,
 * however, compares against the tool's workspace-relative path
 * (e.g. `api/src/index.ts`). Without this prefix the gate-guard denies
 * every edit in multi-root chore tasks.
 *
 * When `config.mode === 'multi-root'` and the editor persona has a `repo`
 * field, every path is prefixed with `<repo>/`. Single-root configs are
 * unaffected (prefix is an empty string).
 *
 * @param {readonly string[]} files   Repo-relative proposed file paths.
 * @param {DevmateConfig} config      Loaded devmate config.
 * @returns {string[]}                Workspace-relative file paths.
 */
export function resolveWorkspacePaths(files, config) {
  // Delegates to the shared implementation (#92); the chore lane always resolves
  // against the `editor` persona's repo dir.
  return resolveWorkspacePathsFor(files, config, "editor");
}

/**
 * Write the chore lane scope artifact in the unified scope.md schema.
 *
 * Emits `lane: chore` frontmatter, an `## Allowed paths` section listing
 * every proposed file, and an empty `## Allowed globs` section (chore lane
 * does not produce globs). The description is intentionally omitted — it
 * belongs in trace events and commit messages, not in the scope contract.
 *
 * B5: In multi-root mode the allowed paths are written as workspace-relative
 * paths (i.e. prefixed with the editor persona's `repo` subdirectory) so
 * that the gate-guard can match them against tool-reported workspace-relative
 * file paths without any additional translation.
 *
 * @param {TaskState} state
 * @param {string} _choreDescription  Unused; retained for call-site compatibility.
 * @param {readonly string[]} allowedFiles
 * @param {{ repoRoot?: string, config?: DevmateConfig }} [opts]
 * @returns {Promise<string>}
 */
export async function writeChoreScope(
  state,
  _choreDescription,
  allowedFiles,
  opts = {},
) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());

  // #92: the serializer lives in lib/workflow/scope-writer.mjs — one
  // implementation, shared with the hook that now authors scope.md from the
  // planner's return. `parseScope` is unforgiving (only `- ` bullets, only `## `
  // headings), so three hand-rolled writers were three chances to emit a file
  // that parses to an EMPTY contract — which Rule 6 reads as "deny every edit".
  //
  // B5: prefix paths with the persona repo dir when in multi-root mode.
  const workspaceFiles = opts.config
    ? resolveWorkspacePaths(allowedFiles, opts.config)
    : [...allowedFiles];

  const result = await writeScope(repoRoot, {
    taskId: state.taskId,
    lane: "chore",
    allowedPaths: workspaceFiles,
    allowedGlobs: [],
  });
  if (!result.ok) throw new Error(`writeChoreScope: ${result.reason}`);
  return result.path;
}

/**
 * Escalate an approved chore to the feature lane, preserving recovery-critical
 * state. Appends a `lane_transition` trace event.
 *
 * @param {TaskState} state
 * @param {{ reason: string, statePath?: string, transitionsPath?: string }} opts
 * @returns {Promise<TaskState>}  State with lane='feature', gate='plan-approved'.
 */
export async function escalateChoreToFeature(state, opts) {
  if (state.lane !== "chore") {
    throw new Error(
      `escalateChoreToFeature: lane must be 'chore', got '${state.lane}'.`,
    );
  }
  /** @type {TaskState} */
  const next = {
    ...state,
    lane: "feature",
    workflowGate: /** @type {WorkflowGate} */ ("plan-approved"),
  };
  await writeTaskState(next, opts.statePath);

  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "lane_transition",
    from: "chore",
    to: "feature",
    reason: opts.reason,
    taskId: next.taskId,
    ts: Date.now(),
  }).catch(() => {});

  return next;
}

/**
 * Grant a narrow source-code exception for the current chore. Appends to
 * `state.approvedExceptions` and writes an `exception_granted` trace event.
 *
 * @param {TaskState} state
 * @param {ChoreException} exception
 * @param {{ statePath?: string, transitionsPath?: string }} [opts]
 * @returns {Promise<TaskState>}
 */
export async function approveChoreException(state, exception, opts = {}) {
  if (typeof exception.path !== "string" || exception.path.trim() === "") {
    throw new Error(
      "approveChoreException: exception.path must be a non-empty string.",
    );
  }
  if (
    typeof exception.approvedBy !== "string" ||
    !exception.approvedBy.toLowerCase().startsWith(EXCEPTION_APPROVAL_PREFIX)
  ) {
    throw new Error(
      `approveChoreException: approvedBy must start with '${EXCEPTION_APPROVAL_PREFIX}'.`,
    );
  }
  const existing = Array.isArray(state.approvedExceptions)
    ? state.approvedExceptions
    : [];
  /** @type {TaskState} */
  const next = { ...state, approvedExceptions: [...existing, exception] };
  await writeTaskState(next, opts.statePath);

  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "exception_granted",
    path: exception.path,
    description: exception.description,
    taskId: next.taskId,
    ts: Date.now(),
  }).catch(() => {});

  return next;
}

/**
 * Guard: is an edit path covered by an approved chore exception? Returns null
 * (allow) for non-chore lanes or matching exceptions, else a block string.
 *
 * @param {TaskState} state
 * @param {string} editPath
 * @returns {string|null}
 */
export function checkChoreExceptionGuard(state, editPath) {
  if (state.lane !== "chore") return null;
  const normalized = editPath.replace(/\\/g, "/");
  const exceptions = Array.isArray(state.approvedExceptions)
    ? state.approvedExceptions
    : [];
  const covered = exceptions.some((ex) => {
    const p = ex.path.replace(/\\/g, "/");
    return (
      normalized === p || normalized.startsWith(p.endsWith("/") ? p : p + "/")
    );
  });
  if (covered) return null;
  return (
    `Gate guard: chore lane cannot make source-code logic changes to '${editPath}'. ` +
    `Say "escalate chore to feature" to widen scope, or ` +
    `"approved exception: <description> for ${editPath}" to grant a narrow exception.`
  );
}
