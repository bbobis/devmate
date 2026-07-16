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

import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { transitionGate } from "../../gate-transitions.mjs";
import { CONFIG_PATH, loadDevmateConfig } from "../../config/devmate-config.mjs";
import { verifyStep, persistVerifyResult } from "../../loop/verify-step.mjs";
import { appendJsonl } from "../../memory/append-jsonl.mjs";
import { writeTaskState } from "../../task-state.mjs";
import {
  resolveWorkspacePaths as resolveWorkspacePathsFor,
  writeScope,
} from "../scope-writer.mjs";
import { matchGlob } from "../../workstream-partitioner.mjs";
import { assertDispatchResult } from "../orchestrator.mjs";

/** @typedef {import('../../types.mjs').TaskState} TaskState */
/** @typedef {import('../../types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../types.mjs').ChoreException} ChoreException */
/** @typedef {import('../../types.mjs').DevmateConfig} DevmateConfig */

/**
 * @typedef {object} ChoreDispatchInput
 * @property {"fullstack"} agent
 * @property {"editor"} persona
 * @property {string} scopePath
 * @property {string} choreDescription
 */

/** @typedef {import('../orchestrator.mjs').DispatchResult} DispatchResult */

/**
 * @typedef {object} ChoreVerifyContext
 * @property {TaskState} state
 * @property {string} choreDescription
 * @property {string} scopePath
 * @property {string} repoRoot
 * @property {string} traceFile
 * @property {readonly string[]} verifyArgv
 */

/**
 * @typedef {object} ChoreLaneResult
 * @property {'verified'|'escalated'|'failed'} status
 * @property {string} summary
 */

/**
 * @typedef {object} RunChoreLaneOpts
 * @property {readonly string[]} [proposedFiles]
 * @property {string} [repoRoot]
 * @property {string} [statePath]
 * @property {string} [transitionsPath]
 * @property {string} [traceFile]
 * @property {readonly string[]} [verifyArgv]
 * @property {(input: ChoreDispatchInput) => Promise<DispatchResult>} [dispatch]
 * @property {(ctx: ChoreVerifyContext) => Promise<{ passed: boolean, summary?: string } | import('../../types.mjs').VerifyResult>} [verify]
 */

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
 * Default loop trace path for in-process verification.
 * @type {string}
 */
const DEFAULT_TRACE_PATH = ".devmate/state/trace.jsonl";

/**
 * Default verification argv when the caller does not inject a verifier.
 * @type {readonly string[]}
 */
const DEFAULT_VERIFY_ARGV = Object.freeze(["npm", "run", "verify"]);

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
    return (
      `Cannot run '${commandName}' — chore plan is approved. ` +
      `Use ${CHORE_CONTINUE_COMMAND} to proceed, or /devmate-escalate to convert to a feature.`
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
 * Return the allowed file entries that intersect any off-limits glob.
 *
 * @param {readonly string[]} allowedFiles
 * @param {readonly string[]} offLimitsGlobs
 * @returns {string[]}
 */
export function detectScopeViolations(allowedFiles, offLimitsGlobs) {
  return allowedFiles.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    return offLimitsGlobs.some((pattern) => matchGlob(pattern, normalized));
  });
}

/**
 * Default dispatch implementation for library-only callers.
 * The real orchestrator should always inject its subagent dispatcher.
 *
 * @returns {Promise<DispatchResult>}
 */
async function defaultDispatch() {
  return {
    status: "error",
    error: "runChoreLane requires opts.dispatch when used outside the orchestrator runtime.",
  };
}

/**
 * Default in-process verifier for chore-lane dispatches.
 *
 * @param {ChoreVerifyContext} ctx
 * @returns {Promise<import('../../types.mjs').VerifyResult>}
 */
async function defaultVerify(ctx) {
  return verifyStep({
    argv: [...ctx.verifyArgv],
    traceFile: ctx.traceFile,
    taskId: ctx.state.taskId,
    attemptId: randomUUID(),
    repoRoot: ctx.repoRoot,
  });
}

/**
 * Normalize an optional summary off the verification result union.
 *
 * @param {import('../../types.mjs').VerifyResult | { passed: boolean, summary?: string }} verifyResult
 * @returns {string|undefined}
 */
function getVerifySummary(verifyResult) {
  return "summary" in verifyResult ? verifyResult.summary : undefined;
}

/**
 * Drive the chore lane end to end without inventing a feature-lane detour.
 *
 * @param {string} choreDescription
 * @param {TaskState} state
 * @param {RunChoreLaneOpts} [opts]
 * @returns {Promise<ChoreLaneResult>}
 */
export async function runChoreLane(choreDescription, state, opts = {}) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const statePath = opts.statePath ?? join(repoRoot, ".devmate", "state", "task.json");
  const transitionsPath =
    opts.transitionsPath ?? join(repoRoot, ".devmate", "state", "transitions.jsonl");
  const traceFile =
    opts.traceFile ?? join(repoRoot, DEFAULT_TRACE_PATH);
  const proposedFiles = [...(opts.proposedFiles ?? [])];
  const dispatch = opts.dispatch ?? defaultDispatch;
  const verify = opts.verify ?? defaultVerify;
  const verifyArgv = opts.verifyArgv ?? DEFAULT_VERIFY_ARGV;

  const configResult = loadDevmateConfig(resolve(repoRoot, CONFIG_PATH));
  if (!configResult.ok) {
    return {
      status: "failed",
      summary: `Unable to load editor persona config: ${configResult.error}`,
    };
  }
  const editorPersona = configResult.config.personas.find(
    (entry) => entry.persona === "editor",
  );
  if (!editorPersona) {
    return {
      status: "failed",
      summary: "Unable to run chore lane: editor persona is missing from devmate.config.json.",
    };
  }

  const violations = detectScopeViolations(
    proposedFiles,
    editorPersona.offLimitsGlobs ?? [],
  );
  if (violations.length > 0) {
    await escalateChoreToFeature(state, {
      reason: `Proposed chore files intersect editor off-limits globs: ${violations.join(", ")}`,
      statePath,
      transitionsPath,
    });
    return {
      status: "escalated",
      summary: `Escalated chore to feature: proposed files exceed editor scope (${violations.join(", ")}).`,
    };
  }

  // B5: pass the loaded config so writeChoreScope can resolve workspace paths
  // in multi-root mode.
  const scopePath = await writeChoreScope(state, choreDescription, proposedFiles, {
    repoRoot,
    config: configResult.config,
  });
  await appendJsonl(transitionsPath, {
    event: "chore_scope_written",
    taskId: state.taskId,
    lane: "chore",
    scopePath,
    allowedFiles: proposedFiles,
    ts: Date.now(),
  }).catch(() => {});

  const executingState = await continueApprovedChore(state, {
    statePath,
    transitionsPath,
  });

  const dispatchResult = await dispatch({
    agent: "fullstack",
    persona: "editor",
    scopePath,
    choreDescription,
  });
  const dispatchCheck = assertDispatchResult("fullstack", dispatchResult);
  if (!dispatchCheck.ok) {
    return {
      status: "failed",
      summary: `Chore dispatch failed validation: ${dispatchCheck.error}`,
    };
  }

  if (dispatchResult.status === "escalated") {
    const reason = dispatchResult.reason || dispatchResult.error || "fullstack escalated chore execution";
    await escalateChoreToFeature(executingState, {
      reason,
      statePath,
      transitionsPath,
    });
    return {
      status: "escalated",
      summary: `Escalated chore to feature during execution: ${reason}`,
    };
  }

  if (dispatchResult.status !== "ok") {
    return {
      status: "failed",
      summary: dispatchResult.reason || dispatchResult.error || "Chore dispatch did not complete successfully.",
    };
  }

  const verifyResult = await verify({
    state: executingState,
    choreDescription,
    scopePath,
    repoRoot,
    traceFile,
    verifyArgv,
  });
  if (!verifyResult.passed) {
    return {
      status: "failed",
      summary: getVerifySummary(verifyResult) || "Chore verification failed.",
    };
  }

  // E9-13: persist the evidence for the pass-verification precondition from
  // the verify result this lane just obtained (covers injected verifiers too).
  const stateDir = dirname(resolve(statePath));
  try {
    await persistVerifyResult(
      {
        passed: true,
        digest: /** @type {{ outputDigest?: string }} */ (verifyResult).outputDigest ?? "",
        fullOutputPath: /** @type {{ fullOutputPath?: string }} */ (verifyResult).fullOutputPath ?? "",
      },
      { stateDir },
    );
  } catch {
    // Best-effort; the precondition below reports any gap.
  }

  const passedTransition = await transitionGate(executingState, "pass-verification", { stateDir });
  if (!passedTransition.ok || !passedTransition.state) {
    return {
      status: "failed",
      summary: `Unable to advance chore gate after verification: ${passedTransition.error}`,
    };
  }
  await writeTaskState(passedTransition.state, statePath);
  await appendJsonl(transitionsPath, {
    event: "gate_transition",
    from: passedTransition.from,
    to: passedTransition.to,
    lane: "chore",
    taskId: passedTransition.state.taskId,
    ts: Date.now(),
  }).catch(() => {});

  return {
    status: "verified",
    summary:
      getVerifySummary(verifyResult) ||
      "Chore lane completed and verification passed.",
  };
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
