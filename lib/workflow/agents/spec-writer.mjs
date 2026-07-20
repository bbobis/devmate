// @ts-check
import { join, resolve } from "node:path";
import { pathExists, readTextFileSync } from "../../fs-safe.mjs";
import {
  SpecWriteError,
  writeSpec as writeSpecFile,
} from "../../spec-writer.mjs";
import { mutateTaskStateUnderLock, STATE_PATH } from "../../task-state.mjs";
import { validatePlannerArtifact } from "./planner.mjs";

/** @typedef {import('../../types.mjs').TaskState} TaskState */
/** @typedef {import('./planner.mjs').PlannerArtifact} PlannerArtifact */

/**
 * @typedef {{ ac: string, tier: 1|2|3, runCommand: string }} TestPlanSeed
 */

/**
 * @typedef {{
 *   planArtifact: PlannerArtifact,
 *   taskState: TaskState
 * }} SpecWriterInputs
 */

/**
 * @typedef {{
 *   storedAt: string,
 *   assumptions: string[],
 *   risks: string[],
 *   specDigest: string
 * }} SpecWriterMetadata
 */

/**
 * @typedef {{
 *   specPath: string,
 *   metadata: SpecWriterMetadata
 * }} SpecWriterResult
 */

/**
 * @typedef {{
 *   claims?: Array<{ fact?: string, path?: string }>,
 *   unverified?: string[]
 * }} DiscoveryArtifact
 */

/**
 * @typedef {{
 *   edgeCases?: string[],
 *   blockingQuestions?: string[],
 *   unverifiedItems?: string[]
 * }} GrillArtifact
 */

/**
 * @typedef {{
 *   repoRoot?: string,
 *   statePath?: string,
 *   testPlanSeed?: TestPlanSeed[],
 *   now?: () => Date
 * }} SpecWriterOptions
 */

/** @type {readonly string[]} */
const ALLOWED_GATES = ["plan-approved", "spec-draft"];

const TASK_HACK_LIMIT = 120;
const SUMMARY_LIMIT = 240;
const DISCOVERY_LIMIT = 3;

/**
 * Typed error for adapter-level validation and projection failures.
 */
export class SpecWriterAgentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SpecWriterAgentError";
  }
}

/**
 * Normalize one non-empty trimmed string list.
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringList(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Deterministic first-line truncation helper.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(1, maxLen - 3)).trimEnd()}...`;
}

/**
 * Resolve an artifact path under one task session directory.
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {string} name
 * @returns {string}
 */
function taskArtifactPath(repoRoot, taskId, name) {
  return resolve(repoRoot, ".devmate", "session", taskId, name);
}

/**
 * Read JSON artifact when present; otherwise return null.
 * @template T
 * @param {string} path
 * @returns {T|null}
 */
function readJsonIfExists(path) {
  if (!pathExists(path)) return null;
  const raw = readTextFileSync(path);
  return /** @type {T} */ (JSON.parse(raw));
}

/**
 * Deduplicate string entries while preserving first-seen order.
 * @param {string[]} items
 * @returns {string[]}
 */
function dedupe(items) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Validate adapter inputs before projection.
 * @param {unknown} inputs
 * @returns {{ ok: true, inputs: SpecWriterInputs } | { ok: false, errors: string[] }}
 */
export function validateSpecWriterInputs(inputs) {
  /** @type {string[]} */
  const errors = [];

  const candidate = inputs;
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["inputs must be an object"] };
  }

  const record = /** @type {Record<string, unknown>} */ (inputs);
  const planArtifact = record.planArtifact;
  const taskState = record.taskState;

  const planVerdict = validatePlannerArtifact(planArtifact);
  if (!planVerdict.ok) {
    errors.push(...planVerdict.errors.map((e) => `planArtifact: ${e}`));
  }

  if (!taskState || typeof taskState !== "object") {
    errors.push("taskState must be an object");
  } else {
    const state = /** @type {Record<string, unknown>} */ (taskState);
    const taskId = state.taskId;
    const workflowGate = state.workflowGate;
    if (typeof taskId !== "string" || taskId.trim() === "") {
      errors.push("taskState.taskId must be a non-empty string");
    }
    if (typeof workflowGate !== "string" || !ALLOWED_GATES.includes(workflowGate)) {
      errors.push(
        `taskState.workflowGate must be one of ${ALLOWED_GATES.join(", ")}`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    inputs: /** @type {SpecWriterInputs} */ (inputs),
  };
}

/**
 * Build deterministic spec title and summary from planner tasks.
 * @param {PlannerArtifact} plan
 * @param {string} taskId
 * @returns {{ title: string, summary: string }}
 */
function deriveTitleSummary(plan, taskId) {
  const firstDescription =
    plan.tasks[0]?.description?.trim() || `Task ${taskId}`;
  const title = truncateText(firstDescription, TASK_HACK_LIMIT);
  const summary = truncateText(firstDescription, SUMMARY_LIMIT);
  return { title, summary };
}

/**
 * Build current behavior and gap narrative from discovery data.
 * @param {DiscoveryArtifact|null} discovery
 * @param {string[]} fallbackAssumptions
 * @returns {{ currentBehavior: string, gap: string, assumptionsPatch: string[] }}
 */
function deriveDiscoveryNarrative(discovery, fallbackAssumptions) {
  if (!discovery) {
    return {
      currentBehavior: "[UNVERIFIED] no discovery artifact recorded",
      gap: "[UNVERIFIED] no discovery artifact recorded",
      assumptionsPatch: dedupe([
        ...fallbackAssumptions,
        "[UNVERIFIED] no discovery artifact recorded",
      ]),
    };
  }

  const claims = Array.isArray(discovery.claims)
    ? discovery.claims
        .map((c) => {
          const fact = typeof c?.fact === "string" ? c.fact.trim() : "";
          const path = typeof c?.path === "string" ? c.path.trim() : "";
          if (fact.length === 0 || path.length === 0) return "";
          return `${path}: ${fact}`;
        })
        .filter((v) => v.length > 0)
    : [];

  const ordered = [...claims].sort((a, b) => a.localeCompare(b));
  const currentBehavior =
    ordered.length > 0
      ? ordered.slice(0, DISCOVERY_LIMIT).join("; ")
      : "[UNVERIFIED] discovery artifact has no usable claims";

  return {
    currentBehavior,
    gap: "Generate deterministic spec.md from approved plan and upstream artifacts.",
    assumptionsPatch:
      ordered.length > 0
        ? fallbackAssumptions
        : dedupe([
            ...fallbackAssumptions,
            "[UNVERIFIED] discovery artifact has no usable claims",
          ]),
  };
}

/**
 * Flatten plan file ownership into deterministic spec file changes list.
 * @param {PlannerArtifact} plan
 * @returns {{ path: string, reason: string, isNew?: boolean }[]}
 */
function deriveFiles(plan) {
  /** @type {Map<string, string>} */
  const fileReason = new Map();
  for (const task of plan.tasks) {
    const reason = `from plan task: ${truncateText(task.description, 100)}`;
    for (const file of task.files) {
      const clean = file.trim();
      if (clean.length === 0) continue;
      if (!fileReason.has(clean)) {
        fileReason.set(clean, reason);
      }
    }
  }

  return [...fileReason.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, reason]) => ({ path, reason }));
}

/**
 * AC-5: the local→global acceptance-criterion id map. The planner contract
 * labels each task's `ac[]` locally (labels restart at `AC1` per task);
 * global ids are assigned by flattening `plan.tasks[].ac` in task order —
 * the same walk `deriveAcAndTestPlan` performs and `lib/spec-writer.mjs`
 * renders as `AC${index + 1}` in spec.md. Entry `taskIndex` is the task's
 * position in `plan.tasks`; each `acs[]` item carries the GLOBAL 1-based id
 * and the verbatim criterion text. Dispatch builders use this so a
 * workstream's payload names explicit global `targetAcIds` instead of
 * leaving the local→global translation to agent inference.
 * @param {PlannerArtifact} plan
 * @returns {Array<{ taskIndex: number, acs: Array<{ id: number, text: string }> }>}
 */
export function deriveTaskAcAssignments(plan) {
  let globalId = 0;
  return plan.tasks.map((task, taskIndex) => ({
    taskIndex,
    acs: (Array.isArray(task.ac) ? task.ac : []).map((text) => {
      globalId += 1;
      return { id: globalId, text };
    }),
  }));
}

/**
 * Derive acceptance criteria and test plan from planner tasks. Global AC ids
 * come from `deriveTaskAcAssignments` — the single source of truth for the
 * local→global mapping — so spec.md numbering and dispatch `targetAcIds`
 * can never drift apart.
 * @param {PlannerArtifact} plan
 * @param {string} taskId
 * @param {TestPlanSeed[]} testPlanSeed
 * @returns {{ acceptanceCriteria: string[], testPlan: Array<{ id: string, description: string, tier: 1|2|3, testFile: string, runCommand: string }> }}
 */
function deriveAcAndTestPlan(plan, taskId, testPlanSeed) {
  /** @type {string[]} */
  const acceptanceCriteria = [];
  /** @type {Array<{ id: string, description: string, tier: 1|2|3, testFile: string, runCommand: string }>} */
  const testPlan = [];

  const assignments = deriveTaskAcAssignments(plan);
  for (const [taskIndex, task] of plan.tasks.entries()) {
    const firstTestFile =
      task.files.find((file) => file.endsWith(".test.mjs")) ||
      `test/${taskId}.test.mjs`;

    for (const { id, text } of assignments.at(taskIndex)?.acs ?? []) {
      const seed = testPlanSeed.at(id - 1);
      if (!seed || typeof seed.runCommand !== "string" || seed.runCommand.trim() === "") {
        throw new SpecWriterAgentError(
          `spec-writer: missing testPlanSeed.runCommand for scenario ${id}`,
        );
      }
      if (!seed || (seed.tier !== 1 && seed.tier !== 2 && seed.tier !== 3)) {
        throw new SpecWriterAgentError(
          `spec-writer: missing testPlanSeed.tier for scenario ${id}`,
        );
      }

      acceptanceCriteria.push(text);
      testPlan.push({
        id: `TC-${String(id).padStart(3, "0")}`,
        description: truncateText(task.tddApproach, 90),
        tier: seed.tier,
        testFile: firstTestFile,
        runCommand: seed.runCommand.trim(),
      });
    }
  }

  return { acceptanceCriteria, testPlan };
}

/**
 * Build one deterministic SpecContent payload from adapter inputs.
 * @param {SpecWriterInputs} inputs
 * @param {string} repoRoot
 * @param {TestPlanSeed[]} testPlanSeed
 * @returns {{
 *   content: import('../../spec-writer.mjs').SpecContent,
 *   specFiles: string[]
 * }}
 */
function buildSpecContent(inputs, repoRoot, testPlanSeed) {
  const { planArtifact, taskState } = inputs;
  const taskId = taskState.taskId;
  const { title, summary } = deriveTitleSummary(planArtifact, taskId);

  const discoveryPath = taskArtifactPath(repoRoot, taskId, "discovery.json");
  const grillPath = resolve(repoRoot, ".devmate", "state", "grill-result.json");

  const discovery = readJsonIfExists(/** @type {string} */ (discoveryPath));
  const grill = readJsonIfExists(/** @type {string} */ (grillPath));

  const assumptionsBase = toStringList(planArtifact.assumptions);
  const risks = toStringList(planArtifact.openRisks);
  const discoveryNarrative = deriveDiscoveryNarrative(
    /** @type {DiscoveryArtifact|null} */ (discovery),
    assumptionsBase,
  );

  const edgeCases = dedupe([
    ...toStringList((/** @type {GrillArtifact|null} */ (grill))?.edgeCases),
    ...toStringList((/** @type {GrillArtifact|null} */ (grill))?.blockingQuestions),
  ]);

  const assumptions = dedupe([
    ...discoveryNarrative.assumptionsPatch,
    ...toStringList((/** @type {GrillArtifact|null} */ (grill))?.unverifiedItems),
  ]);

  if (!grill) {
    assumptions.push("[UNVERIFIED] no grill artifact recorded");
  }

  const files = deriveFiles(planArtifact);
  const specFiles = files.map((f) => f.path);
  const acAndTdd = deriveAcAndTestPlan(
    planArtifact,
    taskId,
    testPlanSeed,
  );

  return {
    content: {
      title,
      summary,
      currentBehavior: discoveryNarrative.currentBehavior,
      gap: discoveryNarrative.gap,
      edgeCases,
      assumptions,
      files,
      acceptanceCriteria: acAndTdd.acceptanceCriteria,
      testPlan: acAndTdd.testPlan,
      risks,
      outOfScope: [],
    },
    specFiles,
  };
}

/**
 * Persist metadata that must exist before gate advancement.
 * @param {string} repoRoot
 * @param {TaskState} taskState
 * @param {string} specPath
 * @param {string[]} specFiles
 * @param {string[]} acceptanceCriteria
 * @param {Date} now
 * @param {string|undefined} explicitStatePath
 * @returns {Promise<void>}
 */
async function writeMetadata(
  repoRoot,
  taskState,
  specPath,
  specFiles,
  acceptanceCriteria,
  now,
  explicitStatePath,
) {
  const statePath = explicitStatePath ?? join(repoRoot, STATE_PATH);

  // #112: atomic read-modify-write so the spec metadata cannot be lost to a
  // concurrent gate advance. The merged state is captured for the post-write
  // invariant check below — the mutator runs exactly once on success.
  /** @type {TaskState | undefined} */
  let updated;
  const outcome = await mutateTaskStateUnderLock(
    (liveState) => {
      const merged = /** @type {TaskState} */ ({
        ...liveState,
        artifactHashes: {
          ...liveState.artifactHashes,
          plan_stored_at: statePath,
          handoff_at: join(repoRoot, ".devmate", "state", "handoff", taskState.taskId),
          specStoredAt: now.toISOString(),
        },
        specFiles,
        // Persist the ordered AC list so per-AC progress ids (`impl-AC{n}`) are
        // stable across sessions and resume can report done-vs-remaining.
        ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      });
      updated = merged;
      return merged;
    },
    statePath,
    { event: "spec-metadata" },
  );
  if (!outcome.ok) {
    throw new SpecWriterAgentError(
      `spec-writer: cannot update task state: ${outcome.error}`,
    );
  }

  // Keep adapter assumptions explicit: runtime state should still point to the latest spec path.
  const recordedSpecPath = updated === undefined ? undefined : updated.artifactHashes.spec;
  if (recordedSpecPath !== specPath) {
    throw new SpecWriterAgentError(
      "spec-writer: state.artifactHashes.spec does not match written spec path",
    );
  }
}

/**
 * Generate `.devmate/session/spec.md` from one approved plan artifact and
 * record metadata to task state before gate advancement.
 * @param {SpecWriterInputs} inputs
 * @param {SpecWriterOptions} [opts]
 * @returns {Promise<SpecWriterResult>}
 */
export async function writeSpec(inputs, opts = {}) {
  const validation = validateSpecWriterInputs(inputs);
  if (!validation.ok) {
    throw new SpecWriterAgentError(
      `spec-writer: invalid inputs: ${validation.errors.join("; ")}`,
    );
  }

  const now = opts.now ?? (() => new Date());
  const repoRoot = opts.repoRoot ?? process.cwd();
  const testPlanSeed = opts.testPlanSeed;
  if (!Array.isArray(testPlanSeed) || testPlanSeed.length === 0) {
    throw new SpecWriterAgentError(
      "spec-writer: options.testPlanSeed must be a non-empty array",
    );
  }
  const plannerAssumptions = toStringList(validation.inputs.planArtifact.assumptions);
  const plannerRisks = toStringList(validation.inputs.planArtifact.openRisks);
  const { content, specFiles } = buildSpecContent(
    validation.inputs,
    repoRoot,
    testPlanSeed,
  );

  let writeResult;
  try {
    writeResult = await writeSpecFile(repoRoot, content);
  } catch (err) {
    if (err instanceof SpecWriteError) {
      throw new SpecWriterAgentError(`spec-writer: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new SpecWriterAgentError(`spec-writer: failed to write spec: ${message}`);
  }

  await writeMetadata(
    repoRoot,
    validation.inputs.taskState,
    writeResult.specPath,
    specFiles,
    content.acceptanceCriteria,
    now(),
    opts.statePath,
  );

  return {
    specPath: writeResult.specPath,
    metadata: {
      storedAt: writeResult.specPath,
      assumptions: plannerAssumptions,
      risks: plannerRisks,
      specDigest: writeResult.specDigest,
    },
  };
}