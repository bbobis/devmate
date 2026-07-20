// @ts-check
import { dirname } from "node:path";
import {
  ensureDirSync,
  readTextFileSync,
  renamePathSync,
  writeTextFileSync,
} from "./fs-safe.mjs";
import { LOCK_SUFFIX, withFileLock } from "./file-lock.mjs";
import { TRANSITIONS } from "./gate-transitions.mjs";
import { getOwn, isNonEmptyString, isPlainRecord } from "./object-utils.mjs";
import { appendTransitionRecord } from "./state-transition-log.mjs";

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
 * #129: gates valid for EVERY lane regardless of the lane's transition table.
 * `no-lane` and `done` bracket the pipeline; `parked` and `abandoned` are the
 * lane-agnostic steering gates (`STEERING` in `lib/gate-transitions.mjs`).
 * @type {readonly WorkflowGate[]}
 */
const LANE_AGNOSTIC_GATES = ["no-lane", "done", "parked", "abandoned"];

/**
 * #129: the set of gates a given lane can legitimately hold, derived from the
 * lane's own transition table — every gate that appears as a row (has exits)
 * or as a target (is entered by some event), unioned with the lane-agnostic
 * gates above. Derivation, not a hand list, so the validator can never drift
 * from `TRANSITIONS`.
 *
 * Deliberately absent: `spec-invalidated`. No runtime writer sets it as a
 * gate value (`hooks/spec-integrity-guard.mjs` rolls back to `spec-draft`
 * and records a trace event instead), and the E2E transition matrix excludes
 * it as a fantasy state (`test/e2e/matrix-generator.mjs`). A state carrying
 * it is hand-edited by definition.
 * @param {Lane} lane
 * @returns {Set<WorkflowGate>}
 */
function gatesValidForLane(lane) {
  /** @type {Set<WorkflowGate>} */
  const valid = new Set(LANE_AGNOSTIC_GATES);
  const laneTable = getOwn(TRANSITIONS, lane);
  if (laneTable === undefined) return valid;
  // @bounded-alloc — iterates the frozen per-lane table (a dozen gates).
  for (const [gate, gateTable] of Object.entries(laneTable)) {
    valid.add(/** @type {WorkflowGate} */ (gate));
    for (const target of Object.values(gateTable)) valid.add(target);
  }
  return valid;
}

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

  // #129: cross-validate the (lane, workflowGate) PAIR against the lane's own
  // transition table — only once both enum checks above passed, so an invalid
  // enum value gets one clear error, not a compounded pair message. Without
  // this, a hand-edited state like lane "bug" + gate "discovery-done" (both
  // independently valid enum members) passes the read boundary cleanly and
  // fails much later — and much less clearly — deep inside `transitionGate`,
  // or not at all when the gate happens to have a lane-agnostic STEERING row.
  if (
    VALID_LANES.includes(/** @type {Lane} */ (obj["lane"])) &&
    VALID_GATES.includes(/** @type {WorkflowGate} */ (obj["workflowGate"]))
  ) {
    const lane = /** @type {Lane} */ (obj["lane"]);
    const gate = /** @type {WorkflowGate} */ (obj["workflowGate"]);
    if (!gatesValidForLane(lane).has(gate)) {
      errors.push(
        `workflowGate "${gate}" has no transitions defined for lane "${lane}" — this state was likely hand-edited or corrupted`,
      );
    }
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

  // #112: stateVersion is optional (absent on legacy/bootstrap state, read as 0);
  // when present it must be a non-negative integer — it is the optimistic-
  // concurrency token, so a malformed value must fail the read rather than let a
  // conflict check compare against garbage.
  if (obj["stateVersion"] !== undefined) {
    const sv = obj["stateVersion"];
    if (typeof sv !== "number" || !Number.isInteger(sv) || sv < 0) {
      errors.push("stateVersion must be a non-negative integer when present");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, state: /** @type {TaskState} */ (raw) };
}

/**
 * #112: read the optimistic-concurrency version off a state, treating an absent
 * field as 0. Single source of the "absent means 0" convention so a snapshot
 * comparison and the increment on write can never disagree about the base value.
 * @param {TaskState} state
 * @returns {number}
 */
export function stateVersionOf(state) {
  return typeof state.stateVersion === "number" ? state.stateVersion : 0;
}

/**
 * Prefix of the error readTaskState emits when the state FILE is absent (as
 * opposed to present-but-corrupt). Exported so {@link isStateFileMissing} and any
 * caller that must tell "no task yet" from "corrupt task" cannot drift from the
 * exact string produced here.
 * @type {string}
 */
export const STATE_FILE_NOT_FOUND_PREFIX = 'State file not found:';

/**
 * True when a failed StateResult means the state file is genuinely ABSENT
 * (ENOENT) — a legitimate pre-task session — as opposed to present-but-unreadable
 * (EACCES/EISDIR/IO), malformed, or shape-invalid. readTaskState reserves the
 * not-found prefix for ENOENT alone, so this predicate stays true ONLY for a
 * truly-missing file; callers that surface corruption to the model (the #171
 * state anchors) stay a silent no-op for this case and report every other failure
 * verbatim.
 * @param {{ errors: string[] }} failed  A `{ ok: false }` StateResult.
 * @returns {boolean}
 */
export function isStateFileMissing(failed) {
  return (failed.errors[0] ?? '').startsWith(STATE_FILE_NOT_FOUND_PREFIX);
}

/**
 * Prefix of the error readTaskState emits when the state file is PRESENT but
 * cannot be read (EACCES/EISDIR/IO) — as opposed to absent, or present-but-corrupt.
 * @type {string}
 */
export const STATE_FILE_UNREADABLE_PREFIX = 'State file unreadable:';

/**
 * True when a failed StateResult means the state file is present but CORRUPT —
 * malformed JSON or shape-invalid — as opposed to genuinely absent (ENOENT) or
 * present-but-unreadable (EACCES/EISDIR/IO). #191 keys the `reset task` recovery
 * off this: a corrupt file is safe to quarantine and start fresh, whereas an
 * unreadable one might be live and must not be touched.
 * @param {{ errors: string[] }} failed  A `{ ok: false }` StateResult.
 * @returns {boolean}
 */
export function isStateCorrupt(failed) {
  const first = failed.errors[0] ?? '';
  return (
    !first.startsWith(STATE_FILE_NOT_FOUND_PREFIX) &&
    !first.startsWith(STATE_FILE_UNREADABLE_PREFIX)
  );
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
  } catch (/** @type {unknown} */ err) {
    // Discriminate ENOENT (a legitimately-absent file — a pre-task session) from
    // every OTHER read failure (EACCES, EISDIR, a transient IO error), which mean
    // the file is PRESENT but unreadable — a real fault the #171 anchors must
    // surface and the fail-closed consumers must NOT treat as "no task yet". Only
    // ENOENT gets the not-found prefix isStateFileMissing keys off.
    const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined;
    if (code === 'ENOENT') {
      return { ok: false, errors: [`${STATE_FILE_NOT_FOUND_PREFIX} ${path}`] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`${STATE_FILE_UNREADABLE_PREFIX} ${path} (${msg})`] };
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
 * Transient rename failures worth a short retry. On Windows a concurrent process
 * holding `task.json` open for an UNLOCKED read (another chat session's
 * `emitStateAnchor` / `recordDomainContext`) across the atomic rename raises a
 * sharing-violation — EPERM/EACCES/EBUSY — which clears in milliseconds once that
 * reader closes. On POSIX these same codes indicate a GENUINE (non-transient)
 * permission/busy condition, not a passing sharing-violation, so the retry just
 * rethrows after the bounded attempts — the transient case it absorbs is
 * Windows-specific.
 * @type {ReadonlySet<string>}
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Commit the atomic tmp→final rename with a short bounded retry on the transient
 * Windows sharing-violation codes.
 *
 * `writeTaskState` holds the write lock, so no other WRITER can race — but the
 * lock does not stop an unlocked READER (best-effort side reads on other paths,
 * or another session's anchor) from holding the file open across the rename,
 * which on Windows fails the rename with EPERM. Without a retry that surfaced as
 * a lost "approve plan" write the human had to retype (#174). The rename and
 * sleep are injectable so the retry is deterministically testable.
 *
 * @param {string} fromPath
 * @param {string} toPath
 * @param {{ attempts?: number, delayMs?: number, rename?: (from: string, to: string) => void, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<void>}
 */
export async function commitRenameWithRetry(fromPath, toPath, opts = {}) {
  // Normalize against a caller passing attempts: 0 / NaN / negative — which would
  // make the loop below a SILENT no-op (no rename, tmp left behind, "success"
  // returned). Always try at least once; fall back to the defaults on garbage.
  const attempts = Number.isInteger(opts.attempts) && Number(opts.attempts) >= 1 ? Number(opts.attempts) : 5;
  const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : 20;
  const rename = opts.rename ?? renamePathSync;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rename(fromPath, toPath);
      return;
    } catch (/** @type {unknown} */ err) {
      const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined;
      const transient = code !== undefined && TRANSIENT_RENAME_CODES.has(code);
      // Rethrow immediately on a non-transient error (ENOSPC, ENOENT, …) or once
      // the last attempt is spent — never swallow a genuine write failure.
      if (!transient || attempt === attempts - 1) throw err;
      await sleep(delayMs);
    }
  }
}

/**
 * Commit a state object to disk atomically: write to `.tmp` then rename (with the
 * transient-sharing-violation retry, #174). The CALLER must already hold the
 * write lock — this is the shared write step of {@link writeTaskState} and
 * {@link mutateTaskStateUnderLock}, factored out so both use identical mechanics.
 * @param {string} path
 * @param {TaskState} state
 * @returns {Promise<void>}
 */
async function commitStateWrite(path, state) {
  const tmpPath = path + ".tmp";
  writeTextFileSync(tmpPath, JSON.stringify(state, null, 2));
  await commitRenameWithRetry(tmpPath, path);
}

/**
 * Validate and write TaskState to disk atomically (write to .tmp then rename).
 * Acquires an exclusive file lock for the duration of the write, and retries the
 * final rename on a transient Windows sharing-violation (#174).
 *
 * This is a BLIND write — it overwrites whatever is on disk with `state`, and
 * does NOT read first (it must be able to bootstrap over a missing/corrupt file).
 * A read-modify-write that must not lose a concurrent update belongs in
 * {@link mutateTaskStateUnderLock}, which reads the fresh state INSIDE the lock.
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
  const lockResult = await withFileLock(lockPath, () => commitStateWrite(path, state));

  if (!lockResult.acquired) {
    throw new Error(`writeTaskState lock failed: ${lockResult.error}`);
  }
}

/**
 * Serialize a read-modify-write of task.json under the SAME lock
 * {@link writeTaskState} uses, so the whole read→mutate→write is atomic: a
 * concurrent gate advance can no longer interleave between an unlocked read and a
 * later write and be silently clobbered by a stale merge (#175). The mutator runs
 * on the FRESH state read INSIDE the lock and returns the next state, or `null` to
 * skip the write when nothing changed (so the file is not churned).
 *
 * #112: every committed write bumps `stateVersion` (`fresh + 1`) — stamped HERE,
 * so a mutator can never forget it — and appends a {@link StateTransitionRecord}
 * to the per-task transition log. When the caller pins `opts.expectedVersion`,
 * the fresh in-lock version is compared FIRST: a mismatch returns a deterministic
 * `conflict` result and writes nothing, so a writer holding a stale snapshot
 * cannot overwrite newer state. (The mutator itself reads fresh, so the pin is
 * belt-and-suspenders for callers that computed their candidate outside the lock.)
 *
 * Non-throwing — for best-effort callers. A missing/corrupt current state (no
 * active task), a mutator result that fails validation, a stale-version conflict,
 * or a lock failure is reported in the result, never thrown.
 * @param {(state: TaskState) => TaskState | null} mutate
 * @param {string} [statePath]
 * @param {{ expectedVersion?: number, event?: string, ts?: string }} [opts]
 * @returns {Promise<import('./types.mjs').MutateResult>}
 */
export async function mutateTaskStateUnderLock(mutate, statePath, opts = {}) {
  const path = statePath ?? STATE_PATH;
  // Keep the whole call genuinely non-throwing (the doc promise best-effort
  // callers rely on): a failing ensureDirSync — e.g. EACCES/EROFS creating the
  // parent — becomes an { ok: false } outcome instead of a throw that would
  // crash a hook that intentionally does not wrap this call.
  try {
    ensureDirSync(dirname(path));
  } catch (/** @type {unknown} */ err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const lockPath = path + LOCK_SUFFIX;
  /** @type {import('./types.mjs').MutateResult} */
  let outcome = { ok: false, error: "lock body did not run" };
  const lockResult = await withFileLock(lockPath, async () => {
    // The body is fully guarded so this stays genuinely non-throwing: a throwing
    // `mutate` or a `commitStateWrite` failure becomes an `{ ok: false }` outcome
    // rather than a rejection withFileLock would re-throw at a best-effort caller.
    try {
      // Read the fresh state INSIDE the lock — this is the whole point: the value
      // the mutator merges onto cannot be stale relative to a write already
      // committed under this same lock.
      const current = readTaskState(path);
      if (!current.ok) {
        outcome = { ok: false, error: current.errors.join("; ") };
        return;
      }
      const fromVersion = stateVersionOf(current.state);

      // Optimistic concurrency: refuse a pinned writer whose snapshot is stale
      // BEFORE running the mutator, so no work is done and nothing is written.
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== fromVersion) {
        outcome = {
          ok: false,
          error: `stale write: expected version ${opts.expectedVersion}, on-disk version is ${fromVersion}`,
          conflict: true,
          currentVersion: fromVersion,
          expectedVersion: opts.expectedVersion,
        };
        return;
      }

      const next = mutate(current.state);
      if (next === null) {
        outcome = { ok: true, written: false, version: fromVersion };
        return;
      }
      // Stamp the incremented version onto the mutator's result so the bump is
      // authoritative here and a mutator cannot set (or forget) its own.
      const toVersion = fromVersion + 1;
      const versioned = /** @type {TaskState} */ ({ ...next, stateVersion: toVersion });
      const validation = validateTaskState(versioned);
      if (!validation.ok) {
        outcome = { ok: false, error: `mutator produced invalid state: ${validation.errors.join("; ")}` };
        return;
      }
      await commitStateWrite(path, versioned);
      outcome = { ok: true, written: true, version: toVersion };

      // Audit the committed transition. Best-effort: a log-append failure must not
      // undo (or fail) the write that already landed. Emitted inside the lock so
      // the record and the version it describes are ordered with the write.
      try {
        appendTransitionRecord(path, {
          taskId: versioned.taskId,
          fromVersion,
          toVersion,
          event: opts.event ?? "mutate",
          fromGate: current.state.workflowGate,
          toGate: versioned.workflowGate,
          ts: opts.ts ?? new Date().toISOString(),
        });
      } catch (/** @type {unknown} */ _logErr) {
        // swallow — the transition log is an audit trail, not the source of truth.
      }
    } catch (/** @type {unknown} */ err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  if (!lockResult.acquired) {
    return { ok: false, error: lockResult.error ?? "lock failed" };
  }
  return outcome;
}

/**
 * #112: bounded-retry optimistic CAS over {@link mutateTaskStateUnderLock}, for
 * the pattern where the candidate is computed from a snapshot read OUTSIDE the
 * lock (an expensive derivation you do not want to run while holding it). Each
 * attempt: read a snapshot + its version, run `produce(snapshot, version)` to
 * build the candidate, then commit it ONLY if the on-disk version still matches
 * the snapshot. If a competing writer moved the version in between, the commit is
 * refused as a conflict and `produce` re-runs against the fresher snapshot.
 * Retries are explicit and bounded — after `attempts` conflicts the last conflict
 * result is returned rather than looping forever.
 *
 * Callers whose mutation is a pure merge on the fresh state do NOT need this —
 * plain {@link mutateTaskStateUnderLock} (no `expectedVersion`) is already
 * conflict-free because its mutator reads fresh. This exists only when the
 * candidate depends on a snapshot computed before the lock was held.
 * @param {(state: TaskState, version: number) => TaskState | null} produce
 * @param {string} [statePath]
 * @param {{ attempts?: number, event?: string, ts?: string }} [opts]
 * @returns {Promise<import('./types.mjs').MutateResult>}
 */
export async function mutateTaskStateWithRetry(produce, statePath, opts = {}) {
  const path = statePath ?? STATE_PATH;
  const attempts = Number.isInteger(opts.attempts) && Number(opts.attempts) >= 1 ? Number(opts.attempts) : 3;

  /** @type {import('./types.mjs').MutateResult} */
  let last = { ok: false, error: "no attempt ran" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Read the snapshot + version OUTSIDE the lock and derive the candidate here.
    const snapshot = readTaskState(path);
    if (!snapshot.ok) return { ok: false, error: snapshot.errors.join("; ") };
    const pinned = stateVersionOf(snapshot.state);
    const candidate = produce(snapshot.state, pinned);
    if (candidate === null) return { ok: true, written: false, version: pinned };

    // Commit the precomputed candidate only if the version is unchanged. The
    // mutator ignores the fresh state deliberately: the `expectedVersion` pin
    // guarantees fresh === snapshot, so the candidate is consistent with disk.
    last = await mutateTaskStateUnderLock(() => candidate, path, {
      expectedVersion: pinned,
      event: opts.event,
      ts: opts.ts,
    });
    if (last.ok || !("conflict" in last && last.conflict)) return last;
  }
  return last;
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
  const key = name.trim();

  // #112: route the read-modify-write through the atomic mutation API so a
  // concurrent gate advance cannot clobber this hash write (or vice versa). The
  // mutator merges onto the FRESH in-lock state, so a hash recorded here survives
  // a version bump that lands between two artifact writes.
  const outcome = await mutateTaskStateUnderLock(
    (state) =>
      /** @type {TaskState} */ ({
        ...state,
        artifactHashes: {
          ...state.artifactHashes,
          [key]: path,
          [`${key}Digest`]: digest,
        },
      }),
    targetStatePath,
    { event: "record-artifact-hash" },
  );

  if (!outcome.ok) {
    // A genuinely-absent state is not a task yet — same no-op as before. Every
    // other failure (corrupt state, lock failure) is surfaced, not swallowed.
    if (outcome.error.startsWith(STATE_FILE_NOT_FOUND_PREFIX)) {
      return;
    }
    throw new Error(
      `Cannot record artifact hash in ${targetStatePath}: ${outcome.error}`,
    );
  }
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
    // #112: preserve a valid pre-existing version; otherwise seed at 0. Migration
    // never advances the workflow gate, so it never counts as a mutation — the
    // first real write through `mutateTaskStateUnderLock` bumps it to 1.
    stateVersion:
      typeof obj["stateVersion"] === "number" &&
      Number.isInteger(obj["stateVersion"]) &&
      obj["stateVersion"] >= 0
        ? obj["stateVersion"]
        : 0,
    schemaVersion: 1,
  };

  return migrated;
}
