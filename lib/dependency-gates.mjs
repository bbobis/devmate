// @ts-check
import { dirname } from "node:path";
import {
  appendTextFileSync,
  ensureDirSync,
  readTextFileSync,
  renamePathSync,
  writeTextFileSync,
} from "./fs-safe.mjs";
import { LOCK_SUFFIX, withFileLock } from "./file-lock.mjs";
import { getOwn } from "./object-utils.mjs";

/** @typedef {import('./types.mjs').DepGateName} DepGateName */
/** @typedef {import('./types.mjs').DepGateStatus} DepGateStatus */
/** @typedef {import('./types.mjs').DepGateEntry} DepGateEntry */
/** @typedef {import('./types.mjs').DepGates} DepGates */
/** @typedef {import('./types.mjs').OrderViolationEntry} OrderViolationEntry */

/**
 * Canonical named dependency gates.
 * @type {Readonly<Set<DepGateName>>}
 */
export const DEP_GATES = Object.freeze(
  new Set(
    /** @type {DepGateName[]} */ ([
      "backend-unit-pass",
      "backend-ready",
      "frontend-unit-pass",
      "all-tests-pass",
    ]),
  ),
);

/**
 * Prerequisite map: each gate lists the gates that must be `pass` before it can be set to `pass`.
 * Empty array = no prerequisites; can always be set to pass.
 * @type {Readonly<Record<DepGateName, DepGateName[]>>}
 */
export const DEP_GATE_PREREQUISITES = Object.freeze(
  /** @type {Record<DepGateName, DepGateName[]>} */ ({
    "backend-unit-pass": [],
    "backend-ready": ["backend-unit-pass"],
    "frontend-unit-pass": [],
    "all-tests-pass": [
      "backend-unit-pass",
      "frontend-unit-pass",
      "backend-ready",
    ],
  }),
);

/** @type {readonly DepGateStatus[]} */
const VALID_STATUSES = ["pending", "pass", "fail", "skipped"];

/** @type {string} */
const DEFAULT_STATE_PATH = ".devmate/state/gates.json";

/** @type {string} */
const DEFAULT_VIOLATIONS_PATH = ".devmate/state/gate-violations.jsonl";

/**
 * Check whether all prerequisites for `name` are `pass` in `gates`.
 * Pure function; no I/O.
 * @param {DepGateName} name
 * @param {Record<string, DepGateEntry>} gates
 * @returns {{ ok: boolean, missing: DepGateName[] }}
 */
export function checkPrerequisites(name, gates) {
  const prereqs = getOwn(DEP_GATE_PREREQUISITES, name);
  if (!prereqs || prereqs.length === 0) {
    return { ok: true, missing: [] };
  }
  /** @type {DepGateName[]} */
  const missing = [];
  for (const prereq of prereqs) {
    const entry = getOwn(gates, prereq);
    if (!entry || entry.status !== "pass") {
      missing.push(prereq);
    }
  }
  return missing.length === 0
    ? { ok: true, missing: [] }
    : { ok: false, missing };
}

/**
 * Thrown when a prerequisite is not satisfied and no --force override given.
 */
export class OrderViolationError extends Error {
  /**
   * @param {Object} entry
   * @param {DepGateName} entry.gate
   * @param {DepGateName[]} entry.missing
   */
  constructor(entry) {
    super(
      `Order violation: cannot set ${entry.gate} to pass; missing: ${entry.missing.join(", ")}`,
    );
    this.name = "OrderViolationError";
  }
}

/**
 * Validate the raw gates object. Returns an error string or null.
 * Exported for use by tests and E1-4 integration.
 * @param {unknown} raw
 * @param {string} [statePath]  For error messages.
 * @returns {string|null}  null = valid; string = error message.
 */
export function validateDepGates(raw, statePath) {
  const path = statePath ?? DEFAULT_STATE_PATH;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `gates.json is corrupt: root must be an object. File preserved at ${path}.`;
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(obj)) {
    if (!DEP_GATES.has(/** @type {DepGateName} */ (key))) {
      return `gates.json is corrupt: unknown gate name "${key}" (canonical names: ${[...DEP_GATES].join(", ")}). File preserved at ${path}.`;
    }
    const entry = obj[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `gates.json is corrupt: entry for "${key}" must be an object. File preserved at ${path}.`;
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (
      !VALID_STATUSES.includes(
        /** @type {DepGateStatus} */ (/** @type {string} */ (e["status"])),
      )
    ) {
      return `gates.json is corrupt: entry for "${key}" has invalid status "${String(e["status"])}" (valid: ${VALID_STATUSES.join(", ")}). File preserved at ${path}.`;
    }
    if (typeof e["updatedAt"] !== "string") {
      return `gates.json is corrupt: entry for "${key}" missing updatedAt string. File preserved at ${path}.`;
    }
  }
  return null;
}

/**
 * Read the current gates map from disk.
 * Returns {} on missing file; throws with "corrupt" message on malformed JSON or invalid shape.
 * @param {string} [statePath]
 * @returns {Record<string, DepGateEntry>}
 */
function readGates(statePath) {
  const path = statePath ?? DEFAULT_STATE_PATH;
  let raw;
  try {
    raw = readTextFileSync(path);
  } catch (/** @type {unknown} */ _err) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gates.json is corrupt: JSON parse error: ${msg}. File preserved at ${path}.`,
    );
  }
  const validationError = validateDepGates(parsed, path);
  if (validationError !== null) {
    throw new Error(validationError);
  }
  return /** @type {Record<string, DepGateEntry>} */ (parsed);
}

/**
 * Write the gates map to disk atomically (write .tmp, then rename).
 * @param {Record<string, DepGateEntry>} gates
 * @param {string} [statePath]
 * @returns {void}
 */
function writeGates(gates, statePath) {
  const path = statePath ?? DEFAULT_STATE_PATH;
  const tmpPath = path + ".tmp";
  ensureDirSync(dirname(path));
  writeTextFileSync(tmpPath, JSON.stringify(gates, null, 2));
  renamePathSync(tmpPath, path);
}

/**
 * Append a forced-violation entry to gate-violations.jsonl.
 * @param {DepGateName} gate
 * @param {DepGateName[]} missing
 * @param {string} [violationsPath]
 * @returns {void}
 */
function appendViolation(gate, missing, violationsPath) {
  const path = violationsPath ?? DEFAULT_VIOLATIONS_PATH;
  ensureDirSync(dirname(path));
  /** @type {OrderViolationEntry} */
  const entry = {
    gate,
    missing,
    timestamp: new Date().toISOString(),
    forced: true,
  };
  appendTextFileSync(path, JSON.stringify(entry) + "\n");
}

/**
 * Write a dependency gate status. Validates name and status before writing.
 * Acquires an exclusive file lock for the duration of the read-modify-write.
 * When status === 'pass', prerequisite order is enforced unless opts.force === true.
 * @param {DepGateName} name
 * @param {DepGateStatus} status
 * @param {string} [statePath]  Path to gates.json; defaults to `.devmate/state/gates.json`.
 * @param {{ force?: boolean, violationsPath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function setDependencyGate(name, status, statePath, opts) {
  if (!DEP_GATES.has(name)) {
    throw new Error(
      `Unknown dependency gate "${name}". Canonical names: ${[...DEP_GATES].join(", ")}.`,
    );
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(
      `Unknown status "${status}". Valid statuses: ${VALID_STATUSES.join(", ")}.`,
    );
  }

  const path = statePath ?? DEFAULT_STATE_PATH;
  const lockPath = path + LOCK_SUFFIX;
  const force = opts?.force === true;
  const violationsPath = opts?.violationsPath;

  const lockResult = await withFileLock(lockPath, () => {
    const gates = readGates(path);

    if (status === "pass") {
      const check = checkPrerequisites(name, gates);
      if (!check.ok) {
        if (!force) {
          throw new OrderViolationError({ gate: name, missing: check.missing });
        }
        appendViolation(name, check.missing, violationsPath);
      }
    }

    /** @type {DepGateEntry} */
    const entry = {
      name,
      status,
      updatedAt: new Date().toISOString(),
    };
    writeGates({ ...gates, [name]: entry }, path);
  });

  if (!lockResult.acquired) {
    throw new Error(`setDependencyGate lock failed: ${lockResult.error}`);
  }
}

/**
 * Read a single dependency gate entry.
 * @param {DepGateName} name
 * @param {string} [statePath]
 * @returns {DepGateEntry|null}
 */
export function getDependencyGate(name, statePath) {
  const gates = readGates(statePath);
  return getOwn(gates, name) ?? null;
}

/**
 * Return all dependency gate entries.
 * @param {string} [statePath]
 * @returns {DepGates}
 */
export function listDependencyGates(statePath) {
  return /** @type {DepGates} */ (readGates(statePath));
}
