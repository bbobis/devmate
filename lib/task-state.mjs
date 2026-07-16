// @ts-check
import { dirname } from "node:path";
import {
  ensureDirSync,
  readTextFileSync,
  renamePathSync,
  writeTextFileSync,
} from "./fs-safe.mjs";
import { LOCK_SUFFIX, withFileLock } from "./file-lock.mjs";
import { isNonEmptyString, isPlainRecord } from "./object-utils.mjs";

/** @typedef {import('./types.mjs').TaskState} TaskState */
/** @typedef {import('./types.mjs').StateResult} StateResult */
/** @typedef {import('./types.mjs').Lane} Lane */
/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */

/**
 * The canonical path for the task state file, relative to the repo root.
 * @type {string}
 */
export const STATE_PATH = ".devmate/state/task.json";

/** @type {readonly Lane[]} */
const VALID_LANES = ["feature", "bug", "chore"];

/**
 * Full set of workflow gates persistable to task.json. Mirrors the
 * `WorkflowGate` union in `lib/types.mjs` and the keys of
 * `LEGAL_TRANSITIONS` in `lib/gatectl.mjs`.
 *
 * The earlier short list (plan-approved..done) predated the spec-artifact
 * pipeline added in E10-4. Keeping the validator in lockstep with the
 * type union prevents `writeTaskState` from rejecting valid gate values
 * such as `spec-draft` and `spec-approved` once the human or the
 * orchestrator drives a task through them — and, since E10-05, the steering
 * gates `parked` and `abandoned`.
 * @type {readonly WorkflowGate[]}
 */
const VALID_GATES = [
  "no-lane",
  "lane-set",
  "discovery-done",
  "grill-done",
  "plan-done",
  "plan-approved",
  "spec-draft",
  "spec-approved",
  "spec-invalidated",
  "impl-started",
  "verification-passed",
  "pr-ready",
  "done",
  "parked",
  "abandoned",
];

/**
 * Validate a raw parsed object as TaskState. Pure function, no I/O.
 * @param {unknown} raw
 * @returns {StateResult}
 */
export function validateTaskState(raw) {
  const errors = [];

  if (raw === null || typeof raw !== "object") {
    return { ok: false, errors: ["State must be a non-null object"] };
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);

  if (typeof obj["taskId"] !== "string" || obj["taskId"].trim() === "") {
    errors.push("taskId must be a non-empty string");
  }

  if (!VALID_LANES.includes(/** @type {Lane} */ (obj["lane"]))) {
    errors.push(
      `lane must be one of: ${VALID_LANES.join(", ")} (got: ${JSON.stringify(obj["lane"])})`,
    );
  }

  if (
    !VALID_GATES.includes(/** @type {WorkflowGate} */ (obj["workflowGate"]))
  ) {
    errors.push(
      `workflowGate must be one of: ${VALID_GATES.join(", ")} (got: ${JSON.stringify(obj["workflowGate"])})`,
    );
  }

  if (!isPlainRecord(obj["artifactHashes"])) {
    errors.push("artifactHashes must be a string-to-string record object");
  } else {
    const hashes = /** @type {Record<string, unknown>} */ (
      obj["artifactHashes"]
    );
    for (const [k, v] of Object.entries(hashes)) {
      if (typeof v !== "string") {
        errors.push(
          `artifactHashes["${k}"] must be a string (got: ${typeof v})`,
        );
      }
    }
  }

  if (obj["preImplStash"] !== null && typeof obj["preImplStash"] !== "string") {
    errors.push("preImplStash must be a string or null");
  }

  if (
    typeof obj["currentStep"] !== "number" ||
    !Number.isInteger(obj["currentStep"]) ||
    obj["currentStep"] < 0
  ) {
    errors.push("currentStep must be a non-negative integer");
  }

  if (
    typeof obj["budget"] !== "number" ||
    !Number.isInteger(obj["budget"]) ||
    obj["budget"] < 0
  ) {
    errors.push("budget must be a non-negative integer");
  }

  if (obj["schemaVersion"] !== 1) {
    errors.push(
      `schemaVersion must equal 1 (got: ${JSON.stringify(obj["schemaVersion"])})`,
    );
  }

  // E13-4: activeSubagents is optional; when present, must be a non-negative integer.
  if (obj["activeSubagents"] !== undefined) {
    const av = obj["activeSubagents"];
    if (typeof av !== "number" || !Number.isInteger(av) || av < 0) {
      errors.push(
        "activeSubagents must be a non-negative integer when present",
      );
    }
  }

  // #93: activeAgents is optional; when present, every entry must carry the two
  // host-supplied identity fields. This roster is what the gate-guard reads to
  // decide who may write a session artifact, so a malformed entry must fail the
  // state read (and thus fail closed) rather than resolve to a silent no-identity.
  if (obj["activeAgents"] !== undefined) {
    const roster = obj["activeAgents"];
    if (!Array.isArray(roster)) {
      errors.push("activeAgents must be an array when present");
    } else {
      for (let i = 0; i < roster.length; i += 1) {
        const entry = roster[i];
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`activeAgents[${i}] must be an object`);
          continue;
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (typeof e["agentName"] !== "string" || e["agentName"].trim() === "") {
          errors.push(`activeAgents[${i}].agentName must be a non-empty string`);
        }
        if (typeof e["agentId"] !== "string") {
          errors.push(`activeAgents[${i}].agentId must be a string`);
        }
      }
    }
  }

  // E11/P1-4: specFiles is optional; when present, must be a non-empty string array.
  if (obj["specFiles"] !== undefined) {
    const sv = obj["specFiles"];
    if (!Array.isArray(sv)) {
      errors.push("specFiles must be an array when present");
    } else {
      for (let i = 0; i < sv.length; i += 1) {
        const item = sv[i];
        if (typeof item !== "string" || item.trim() === "") {
          errors.push(`specFiles[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // Ordered acceptance-criteria list is optional; when present, must be a
  // non-empty string array (mirrors specFiles). Index+1 is the stable per-AC id.
  if (obj["acceptanceCriteria"] !== undefined) {
    const ac = obj["acceptanceCriteria"];
    if (!Array.isArray(ac)) {
      errors.push("acceptanceCriteria must be an array when present");
    } else {
      for (let i = 0; i < ac.length; i += 1) {
        const item = ac[i];
        if (typeof item !== "string" || item.trim() === "") {
          errors.push(`acceptanceCriteria[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // E12-2: tddGuard is optional; when present, validate shape.
  if (obj["tddGuard"] !== undefined) {
    const g = obj["tddGuard"];
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      errors.push("tddGuard must be an object when present");
    } else {
      const gg = /** @type {Record<string, unknown>} */ (g);
      if (typeof gg["testFileWritten"] !== "boolean") {
        errors.push("tddGuard.testFileWritten must be a boolean");
      }
      if (
        typeof gg["consecutiveNonTestWrites"] !== "number" ||
        !Number.isInteger(gg["consecutiveNonTestWrites"]) ||
        gg["consecutiveNonTestWrites"] < 0
      ) {
        errors.push(
          "tddGuard.consecutiveNonTestWrites must be a non-negative integer",
        );
      }
      if (typeof gg["overrideGranted"] !== "boolean") {
        errors.push("tddGuard.overrideGranted must be a boolean");
      }
      if (
        gg["overrideReason"] !== undefined &&
        typeof gg["overrideReason"] !== "string"
      ) {
        errors.push("tddGuard.overrideReason must be a string when present");
      }
    }
  }

  // #111: continuationError is optional; when present, validate shape.
  if (obj["continuationError"] !== undefined) {
    const ce = obj["continuationError"];
    if (ce === null || typeof ce !== "object" || Array.isArray(ce)) {
      errors.push("continuationError must be an object when present");
    } else {
      const ceo = /** @type {Record<string, unknown>} */ (ce);
      if (typeof ceo["at"] !== "string") {
        errors.push("continuationError.at must be a string");
      }
      if (typeof ceo["message"] !== "string") {
        errors.push("continuationError.message must be a string");
      }
      if (typeof ceo["ts"] !== "string") {
        errors.push("continuationError.ts must be a string");
      }
      if (typeof ceo["recovery"] !== "string") {
        errors.push("continuationError.recovery must be a string");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, state: /** @type {TaskState} */ (raw) };
}

/**
 * Read and validate TaskState from disk.
 * @param {string} [statePath]  Defaults to STATE_PATH.
 * @returns {StateResult}
 */
export function readTaskState(statePath) {
  const path = statePath ?? STATE_PATH;
  let raw;
  try {
    raw = readTextFileSync(path);
  } catch (/** @type {unknown} */ _err) {
    return { ok: false, errors: [`State file not found: ${path}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`Malformed JSON: ${msg}`] };
  }
  return validateTaskState(parsed);
}

/**
 * Validate and write TaskState to disk atomically (write to .tmp then rename).
 * Acquires an exclusive file lock for the duration of the write.
 * @param {TaskState} state
 * @param {string} [statePath]
 * @returns {Promise<void>}
 */
export async function writeTaskState(state, statePath) {
  const path = statePath ?? STATE_PATH;
  const result = validateTaskState(state);
  if (!result.ok) {
    throw new Error(
      `Cannot write invalid TaskState: ${result.errors.join("; ")}`,
    );
  }

  // Ensure the lock file parent exists before lock acquisition.
  ensureDirSync(dirname(path));

  const lockPath = path + LOCK_SUFFIX;
  const lockResult = await withFileLock(lockPath, () => {
    const tmpPath = path + ".tmp";
    writeTextFileSync(tmpPath, JSON.stringify(state, null, 2));
    renamePathSync(tmpPath, path);
  });

  if (!lockResult.acquired) {
    throw new Error(`writeTaskState lock failed: ${lockResult.error}`);
  }
}

/**
 * Record an artifact path and digest in task state under artifactHashes.
 * Writes keys `<name>` and `<name>Digest`.
 * If task state does not exist yet, this function is a no-op.
 * @param {string} name
 * @param {string} digest
 * @param {string} path
 * @param {{ statePath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function recordArtifactHash(name, digest, path, opts = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("name must be a non-empty string");
  }
  if (!isNonEmptyString(digest)) {
    throw new TypeError("digest must be a non-empty string");
  }
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("path must be a non-empty string");
  }

  const targetStatePath = opts.statePath ?? STATE_PATH;
  const stateResult = readTaskState(targetStatePath);
  if (!stateResult.ok) {
    const first = stateResult.errors[0] ?? "";
    if (first.startsWith("State file not found:")) {
      return;
    }
    throw new Error(
      `Cannot record artifact hash in ${targetStatePath}: ${stateResult.errors.join("; ")}`,
    );
  }

  const key = name.trim();
  const updated = /** @type {TaskState} */ ({
    ...stateResult.state,
    artifactHashes: {
      ...stateResult.state.artifactHashes,
      [key]: path,
      [`${key}Digest`]: digest,
    },
  });
  await writeTaskState(updated, targetStatePath);
}

/**
 * Migrate a pre-v1 state object to the current schema. Returns original if already v1.
 * @param {unknown} raw
 * @returns {TaskState}
 */
export function migrateTaskState(raw) {
  const obj =
    raw !== null && typeof raw === "object"
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};

  if (obj["schemaVersion"] === 1) {
    const result = validateTaskState(raw);
    if (result.ok) return result.state;
  }

  process.stderr.write("[devmate] Migrating task state to schemaVersion 1\n");

  /** @type {TaskState} */
  const migrated = {
    taskId:
      typeof obj["taskId"] === "string" && obj["taskId"].trim() !== ""
        ? /** @type {string} */ (obj["taskId"])
        : "unknown",
    lane: /** @type {import('./types.mjs').Lane[]} */ ([
      "feature",
      "bug",
      "chore",
    ]).includes(/** @type {any} */ (obj["lane"]))
      ? /** @type {import('./types.mjs').Lane} */ (obj["lane"])
      : "feature",
    workflowGate: VALID_GATES.includes(/** @type {any} */ (obj["workflowGate"]))
      ? /** @type {import('./types.mjs').WorkflowGate} */ (obj["workflowGate"])
      : "plan-approved",
    artifactHashes: isPlainRecord(obj["artifactHashes"])
      ? /** @type {Record<string, string>} */ (obj["artifactHashes"])
      : {},
    preImplStash:
      typeof obj["preImplStash"] === "string" ? obj["preImplStash"] : null,
    currentStep:
      typeof obj["currentStep"] === "number" &&
      Number.isInteger(obj["currentStep"]) &&
      obj["currentStep"] >= 0
        ? obj["currentStep"]
        : 0,
    budget:
      typeof obj["budget"] === "number" &&
      Number.isInteger(obj["budget"]) &&
      obj["budget"] >= 0
        ? obj["budget"]
        : 10,
    specFiles:
      Array.isArray(obj["specFiles"]) &&
      obj["specFiles"].every(
        (v) => typeof v === "string" && v.trim() !== "",
      )
        ? /** @type {string[]} */ (obj["specFiles"])
        : undefined,
    acceptanceCriteria:
      Array.isArray(obj["acceptanceCriteria"]) &&
      obj["acceptanceCriteria"].every(
        (v) => typeof v === "string" && v.trim() !== "",
      )
        ? /** @type {string[]} */ (obj["acceptanceCriteria"])
        : undefined,
    schemaVersion: 1,
  };

  return migrated;
}
