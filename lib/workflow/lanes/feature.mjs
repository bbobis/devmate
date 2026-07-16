// @ts-check
// fix(#162): Feature lane orchestration — advance gate to impl-started before
// dispatching fullstack workers.
//
// Root cause of Bug 3 (issue #162): the orchestrator dispatches fullstack persona
// workers while the task state still holds workflowGate === 'plan-approved'.
// gate-guard-core.mjs Rule 3 denies ALL source edits when gate is plan-approved,
// so every fullstack edit attempt returns:
//   "Gate guard: implementation not yet started (gate: plan-approved)."
//
// The fix mirrors the chore lane's continueApprovedChore pattern exactly:
//   1. Assert gate is plan-approved (refuse to re-advance).
//   2. Transition plan-approved → impl-started via shared transitionGate.
//   3. Persist the updated state atomically via writeTaskState.
//   4. Append a gate_transition trace event.
//   5. Announce the plan path to the developer and request confirmation.
//
// Gate model (anti-hallucination): the real WorkflowGate values are defined
// in lib/types.mjs. HITL-2: on the feature lane the only legal move out of
// plan-approved is draft-spec --> spec-draft (the human review gate), and
// start-impl is legal only from spec-approved (lib/gate-transitions.mjs);
// bug/chore keep plan-approved --start-impl--> impl-started.
// No new gate names are invented.

import { readTextFile } from "../../fs-safe.mjs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_PATH, loadDevmateConfig } from "../../config/devmate-config.mjs";
import { transitionGate } from "../../gate-transitions.mjs";
import { appendJsonl } from "../../memory/append-jsonl.mjs";
import { STATE_PATH, writeTaskState } from "../../task-state.mjs";
import { partitionWorkstreams } from "../../workstream-partitioner.mjs";

/** @typedef {import('../../types.mjs').TaskState} TaskState */
/** @typedef {import('../../types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../types.mjs').GateEvent} GateEvent */
/** @typedef {import('../../types.mjs').DispatchMode} DispatchMode */
/** @typedef {import('../../types.mjs').WorkstreamPartition} WorkstreamPartition */

/**
 * @typedef {TaskState & { specFiles?: string[] }} FeatureTaskState
 */

/**
 * @typedef {{ backendFiles: string[], frontendFiles: string[], sharedFiles: string[] }} FeatureWorkstreams
 */

/**
 * The gate a feature task must be in for planning to be considered approved.
 * @type {WorkflowGate}
 */
export const FEATURE_PLAN_APPROVED = "plan-approved";

/**
 * The gate a feature task advances to when implementation begins.
 * @type {WorkflowGate}
 */
export const FEATURE_IMPL_STARTED = "impl-started";

/**
 * The gate-transition event that advances spec-approved → impl-started
 * (HITL-2: on the feature lane start-impl is legal only from spec-approved).
 * @type {GateEvent}
 */
const START_IMPL_EVENT = "start-impl";

/**
 * Default JSONL log for gate-transition trace events.
 * Override with `DEVMATE_TRANSITIONS_PATH`.
 * @type {string}
 */
const DEFAULT_TRANSITIONS_PATH = ".devmate/state/transitions.jsonl";

/**
 * Canonical path for the orchestrator plan, relative to the repo root.
 * This is announced to the developer after planning completes.
 * @type {string}
 */
export const PLAN_PATH = ".devmate/session/plan.md";

/**
 * Canonical path for the spec artifact.
 * @type {string}
 */
export const SPEC_PATH = ".devmate/session/spec.md";

/**
 * Require spec metadata recorded by spec-writer before implementation can start.
 * @param {TaskState} state
 * @returns {void}
 */
function assertSpecMetadataRecorded(state) {
  const specPath = state.artifactHashes.spec;
  const specDigest = state.artifactHashes.specDigest;
  if (!specPath || !specDigest) {
    throw new Error(
      "continueApprovedFeature: missing spec artifact metadata (artifactHashes.spec/specDigest). " +
        "Run spec-writer before starting implementation.",
    );
  }
}

/**
 * Extract file paths from the "## Files that will change" section in spec.md.
 * Accepts Markdown bullets (`-`,`*`,`+`) and keeps paths as written.
 * @param {string} specPath
 * @returns {Promise<string[]>}
 */
export async function extractSpecFilesFromMarkdown(specPath) {
  let body = "";
  try {
    body = await readTextFile(specPath);
  } catch {
    return [];
  }

  const lines = body.split(/\r?\n/);
  /** @type {string[]} */
  const files = [];
  let inSection = false;

  for (const line of lines) {
    if (!inSection) {
      if (/^##\s+Files that will change\s*$/i.test(line.trim())) {
        inSection = true;
      }
      continue;
    }

    if (/^##\s+/.test(line.trim())) {
      break;
    }

    const trimmed = line.trimStart();
    if (trimmed.length < 3) continue;
    const marker = trimmed[0];
    if (marker !== '-' && marker !== '*' && marker !== '+') continue;
    if (trimmed[1] !== ' ') continue;
    const value = trimmed.slice(2).trim();
    if (value.length === 0) continue;

    // The bullet `lib/spec-writer.mjs` actually writes is
    //   - `path/to/file.mjs` (new) — reason
    // and this took the WHOLE rest of the line as the path (#92), yielding
    // "`path/to/file.mjs` (new) — reason". As a scope.md allowedPaths entry that
    // matches nothing, so Rule 6 would have denied every edit; as a workstream
    // input it is not a path at all. Take the backticked path when there is one.
    const backticked = /^`([^`]+)`/.exec(value);
    files.push(backticked ? backticked[1].trim() : value);
  }

  return files;
}

/**
 * Read the spec file list from task state (when available from future writers).
 * @param {TaskState} state
 * @returns {string[]}
 */
function readSpecFilesFromState(state) {
  const featureState = /** @type {FeatureTaskState} */ (state);
  if (!Array.isArray(featureState.specFiles)) return [];
  return featureState.specFiles.filter(
    (entry) => typeof entry === "string" && entry.trim() !== "",
  );
}

/**
 * Compute partition and dispatch mode using configured personas.
 *
 * FO-8: the config's `maxConcurrentAgents` (the sub-agent budget guard's
 * runtime ceiling) is passed through as the partitioner's `maxParallel` bound,
 * so what the lane proposes can never exceed what the guard would allow. An
 * absent or invalid config value falls back to the partitioner's own default
 * ceiling, exactly as before.
 * @param {string[]} specFiles
 * @param {string} configPath
 * @returns {{ mode: DispatchMode, workstreams: FeatureWorkstreams }}
 */
function computeWorkstreams(specFiles, configPath) {
  const configResult = loadDevmateConfig(configPath);
  if (!configResult.ok || configResult.config.personas.length === 0) {
    throw new Error(
      "continueApprovedFeature: cannot partition workstreams — devmate.config.json missing or invalid.",
    );
  }

  const mca = configResult.config.maxConcurrentAgents;
  const partition = /** @type {WorkstreamPartition} */ (
    partitionWorkstreams(
      specFiles,
      configResult.config.personas,
      Number.isInteger(mca) && /** @type {number} */ (mca) >= 1
        ? { maxParallel: mca }
        : undefined,
    )
  );
  const { mode, backendFiles, frontendFiles, sharedFiles } = partition;
  return { mode, workstreams: { backendFiles, frontendFiles, sharedFiles } };
}


/**
 * Advance an approved feature task into the implementation phase.
 *
 * Call this BEFORE dispatching fullstack persona workers. After this returns,
 * task.json holds workflowGate === 'impl-started' and gate-guard Rule 3 will
 * no longer block source edits.
 *
 * Steps:
 *  1. Assert the gate is `spec-approved` (HITL-2: a written-but-never-approved
 *     spec at plan-approved may not reach implementation; refuse to re-advance).
 *  2. Transition spec-approved → impl-started via the shared pure utility.
 *  3. Persist the updated state atomically (shared file-locked writer).
 *  4. Append a `gate_transition` trace event.
 *  5. Return the advanced state and the absolute plan path for announcement.
 *
 * @param {TaskState} state
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]         Absolute repo root (for plan path announcement).
 * @param {string} [opts.statePath]        Override TaskState path (tests).
 * @param {string} [opts.transitionsPath]  Override transitions log path (tests).
 * @param {string} [opts.configPath]       Override devmate config path (tests).
 * @param {string} [opts.specPath]         Override spec path (tests).
 * @returns {Promise<{
 *   state: TaskState,
 *   planPath: string,
 *   gate: 'impl-started',
 *   workstreams: FeatureWorkstreams,
 *   mode: DispatchMode
 * }>}
 */
export async function continueApprovedFeature(state, opts = {}) {
  assertSpecMetadataRecorded(state);

  if (state.workflowGate !== "spec-approved") {
    throw new Error(
      `continueApprovedFeature: gate must be 'spec-approved', got ` +
        `'${state.workflowGate}'. Refusing to re-advance.`,
    );
  }

  const repoRoot = opts.repoRoot ?? process.cwd();
  const statePath = opts.statePath ?? resolve(repoRoot, STATE_PATH);

  // Point the target gate's precondition at THIS task's state dir (not the
  // process CWD) so the impl-started spec-artifact check reads the same
  // task.json being transitioned.
  const result = await transitionGate(state, START_IMPL_EVENT, {
    stateDir: dirname(statePath),
  });
  if (!result.ok || !result.state) {
    throw new Error(
      `continueApprovedFeature: gate transition failed — ${result.error}`,
    );
  }
  const next = result.state;
  const transitionsPathRaw =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  const transitionsPath = isAbsolute(transitionsPathRaw)
    ? transitionsPathRaw
    : resolve(repoRoot, transitionsPathRaw);

  let specFiles = readSpecFilesFromState(state);
  if (specFiles.length === 0) {
    // TODO(P1-4): remove fallback once spec-writer persists specFiles into task state.
    const specPath = opts.specPath ?? join(repoRoot, SPEC_PATH);
    specFiles = await extractSpecFilesFromMarkdown(specPath);
    await appendJsonl(transitionsPath, {
      event: "warn_spec_files_fallback",
      taskId: next.taskId,
      ts: Date.now(),
      reason:
        "specFiles missing from task state; parsed from spec.md as fallback",
    }).catch(() => {});
  }

  if (specFiles.length === 0) {
    throw new Error(
      'continueApprovedFeature: specFiles is empty after fallback. Ensure spec.md contains a "## Files that will change" section or that spec-writer has persisted specFiles into task state.',
    );
  }

  const configPath =
    opts.configPath ?? resolve(repoRoot, CONFIG_PATH);
  const { mode, workstreams } = computeWorkstreams(specFiles, configPath);

  // scope.md is NOT written here (#92). The `gate-advance` hook authors it from
  // the planner's typed return — a real file list — the moment the plan lands,
  // which is well before this point.
  //
  // This used to write it from `specFiles`, and that was actively harmful: the
  // only source of specFiles in a real session is the markdown fallback above
  // (nothing ever populates `state.specFiles`), and the fallback used to yield
  // "`path` (new) — reason" rather than a path. Those entries became
  // `allowedPaths`, matched nothing, and Rule 6 denies an edit outside
  // allowedPaths — so a working feature lane would have blocked every edit it
  // then tried to make. One writer, from typed evidence, or none.
  //
  // `impl-started` now REQUIRES a valid scope.md (lib/gate-preconditions.mjs),
  // so a transition reaching this line has already proven the contract exists.

  const nextWithMetadata = {
    ...next,
    artifactHashes: {
      ...next.artifactHashes,
      plan_stored_at: statePath,
      handoff_at: join(repoRoot, ".devmate", "state", "handoff", next.taskId),
    },
  };

  await writeTaskState(nextWithMetadata, statePath);

  await appendJsonl(transitionsPath, {
    event: "gate_transition",
    from: result.from,
    to: result.to,
    lane: "feature",
    taskId: nextWithMetadata.taskId,
    mode,
    workstreams: {
      backend: workstreams.backendFiles.length,
      frontend: workstreams.frontendFiles.length,
      shared: workstreams.sharedFiles.length,
    },
    ts: Date.now(),
  }).catch(() => {});

  const planPath = join(repoRoot, PLAN_PATH);
  if (nextWithMetadata.workflowGate !== FEATURE_IMPL_STARTED) {
    throw new Error(
      `continueApprovedFeature: expected gate '${FEATURE_IMPL_STARTED}', got '${nextWithMetadata.workflowGate}'.`,
    );
  }

  return {
    state: nextWithMetadata,
    planPath,
    gate: "impl-started",
    workstreams,
    mode,
  };
}

/**
 * Steering events the feature lane accepts while implementation is in
 * progress (E10-05): a mid-build scope change re-enters the spec loop
 * (revise-scope), an approach change re-enters planning (re-plan).
 * @type {readonly GateEvent[]}
 */
export const FEATURE_STEERING_EVENTS = Object.freeze(
  /** @type {GateEvent[]} */ (["revise-scope", "re-plan"]),
);

/**
 * Steer an in-flight feature implementation backward without restarting
 * (E10-05). On revise-scope the task re-enters the spec loop; on re-plan it
 * re-enters planning. Both continue the SAME task \u2014 the chore-lane
 * "continue with the preserved taskId, never restart" precedent
 * (docs/workflow.md, chore step 9) applied to steering.
 *
 * Mirrors continueApprovedFeature's shape: shared transitionGate, atomic
 * state persist, then a gate_transition trace event. Everything already
 * produced is preserved, never reset: transitionGate spreads the input
 * state, so taskId, artifactHashes (including spec metadata), the persisted
 * specFiles list, budget, and preImplStash all carry over unchanged, and the
 * completed-workstream evidence on disk (dependency gates, handoff
 * artifacts) is not touched. Only workflowGate and currentStep change.
 *
 * Each steering event is gated by its precondition (lib/gate-preconditions.mjs):
 * revise-scope requires a captured scope-change note in the state dir, and
 * re-plan re-checks the plan-done critique-result precondition.
 *
 * @param {TaskState} state  Current task state; gate must be impl-started.
 * @param {GateEvent} event  One of FEATURE_STEERING_EVENTS.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]         Absolute repo root.
 * @param {string} [opts.statePath]        Override TaskState path (tests).
 * @param {string} [opts.stateDir]         Override precondition-artifact dir (tests).
 * @param {string} [opts.transitionsPath]  Override transitions log path (tests).
 * @returns {Promise<{ state: TaskState, gate: WorkflowGate, from: WorkflowGate }>}
 */
export async function steerFeature(state, event, opts = {}) {
  if (!FEATURE_STEERING_EVENTS.includes(event)) {
    throw new Error(
      `steerFeature: unsupported steering event '${event}'. Supported: ${FEATURE_STEERING_EVENTS.join(", ")}.`,
    );
  }
  if (state.workflowGate !== FEATURE_IMPL_STARTED) {
    throw new Error(
      `steerFeature: gate must be '${FEATURE_IMPL_STARTED}', got '${state.workflowGate}'. ` +
        "Steering edges start from an in-flight implementation.",
    );
  }

  const repoRoot = opts.repoRoot ?? process.cwd();
  const statePath = opts.statePath ?? resolve(repoRoot, STATE_PATH);
  const stateDir = opts.stateDir ?? dirname(statePath);

  const result = await transitionGate(state, event, { stateDir });
  if (!result.ok || !result.state || !result.from || !result.to) {
    throw new Error(`steerFeature: gate transition failed \u2014 ${result.error}`);
  }
  const next = result.state;

  await writeTaskState(next, statePath);

  const transitionsPathRaw =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  const transitionsPath = isAbsolute(transitionsPathRaw)
    ? transitionsPathRaw
    : resolve(repoRoot, transitionsPathRaw);
  await appendJsonl(transitionsPath, {
    event: "gate_transition",
    from: result.from,
    to: result.to,
    lane: "feature",
    taskId: next.taskId,
    steeringEvent: event,
    ts: Date.now(),
  }).catch(() => {});

  return { state: next, gate: result.to, from: result.from };
}

/**
 * Format the plan announcement message shown to the developer after the
 * orchestrator planner subagent writes the plan. Call this after the planner
 * returns and before calling continueApprovedFeature.
 *
 * @param {string} planPath  Absolute path to the plan file.
 * @returns {string}
 */
export function formatPlanAnnouncement(planPath) {
  return (
    `\u2705 Plan written to ${planPath}\n` +
    "Review it and confirm to proceed to implementation."
  );
}
