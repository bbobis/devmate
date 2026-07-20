// @ts-check

/**
 * E10-3: PostToolUse hook that detects post-approval edits to spec.md and
 * rolls the workflow gate back to spec-draft so the human must re-approve.
 *
 * Treats `spec-approved` as a locked contract:
 *
 *  1. Watches every PostToolUse event for a write to
 *     `.devmate/session/spec.md` (matched by suffix so absolute or
 *     workspace-relative paths both work).
 *  2. Computes the current SHA-256 of spec.md and compares it to the
 *     `specDigest` previously recorded in task.json by spec-writer.
 *  3. When the digest differs AND the workflow gate is `spec-approved`,
 *     advances the gate `spec-approved -> spec-draft` (a legal rollback
 *     in `lib/gatectl.mjs`), updates the recorded digest, appends a
 *     `spec_invalidated` trace event, and prints a stdout warning that
 *     VS Code surfaces in the output panel.
 *
 * Doc reference (PostToolUse event name + stdout capture):
 *   https://code.visualstudio.com/docs/copilot/customization/hooks
 *
 * The hook is best-effort: a missing spec or missing task.json silently
 * returns `no_action` so unrelated tool calls are never blocked.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { isDevmatePayload } from "../lib/hooks/session-marker.mjs";
import { readTextFile } from "../lib/fs-safe.mjs";
import { createTextCapture, writeHookOutput } from "../lib/hooks/output-schema.mjs";
import { firstToolInputPath } from "../lib/hooks/tool-input.mjs";
import { advanceGate } from "../lib/gatectl.mjs";
import {
  mutateTaskStateUnderLock,
  readTaskState,
  STATE_PATH,
} from "../lib/task-state.mjs";
import { appendTraceEvent } from "../lib/trace/append.mjs";
import { digestsEqual } from "../lib/digest-compare.mjs";

/** @typedef {import('../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/** Trace schema version this hook emits. */
const SCHEMA_VERSION = 1;

/** Step id stamped on every trace event written by this hook. */
const STEP_ID = "spec-integrity-guard";

/** Suffix used to identify writes to the human-facing spec artifact. */
export const SPEC_REL_PATH = ".devmate/session/spec.md";

/**
 * The INTERNAL event `handlePostToolUse` takes — a derived shape, not the wire
 * payload. `main()` builds it: the root comes from `resolveHookRoot`, and the
 * written path from the one `tool_input` parser (lib/hooks/tool-input.mjs).
 *
 * These field names are devmate's, and they are deliberately not the host's:
 * VS Code sends `tool_name` and `tool_input.filePath`, and nothing here should
 * read a payload key directly. This docstring used to say the caller flattens
 * `tool_input.path` — a key VS Code has never sent, which is exactly the class
 * of quiet fiction #77 exists to delete.
 *
 * @typedef {Object} PostToolUseEvent
 * @property {string} [toolName]   Derived from the wire's `tool_name` (informational).
 * @property {string} [filePath]   Derived: the file that was written, if any.
 * @property {string} [taskId]     Optional override for the active task id.
 * @property {string} [repoRoot]   Absolute workspace root, from resolveHookRoot.
 * @property {string} [root]       Alias of `repoRoot` (tests inject a tmp dir).
 */

/**
 * Structured result returned by the hook.
 * @typedef {Object} IntegrityGuardResult
 * @property {'no_action'|'rollback'} action
 * @property {string} [reason]    Human-readable reason for the rollback.
 * @property {WorkflowGate} [from]  Gate the rollback came from (for callers).
 * @property {WorkflowGate} [to]    Gate the rollback advanced to.
 */

/**
 * Compute the SHA-256 hex digest of a file's bytes. Returns `null` when the
 * file is missing or unreadable so the caller can treat both as "no spec on
 * disk".
 * @param {string} filePath Absolute path.
 * @returns {Promise<string|null>}
 */
async function fileDigest(filePath) {
  try {
    // spec.md is a utf8 text artifact; hashing the decoded text re-encoded as
    // utf8 matches how lib/spec-writer.mjs computes the recorded specDigest.
    const text = await readTextFile(filePath);
    return createHash("sha256").update(text, "utf8").digest("hex");
  } catch (/** @type {any} */ err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Resolve the active task id. Prefer an explicit override on the event;
 * otherwise fall back to the value persisted in task.json. Returns `null`
 * when neither source is available so the caller surfaces `no_action`.
 * @param {PostToolUseEvent} event
 * @param {string} repoRoot
 * @returns {string|null}
 */
function resolveTaskId(event, repoRoot) {
  if (typeof event.taskId === "string" && event.taskId.trim() !== "") {
    return event.taskId.trim();
  }
  const result = readTaskState(path.join(repoRoot, STATE_PATH));
  if (!result.ok) return null;
  return result.state.taskId;
}

/**
 * Persist a new gate and refreshed spec digest atomically. Returns the
 * persisted state so callers can read the prior gate without re-loading.
 * @param {WorkflowGate} nextGate
 * @param {string} newDigest
 * @param {string} repoRoot
 * @returns {Promise<TaskState|null>}
 */
async function rollbackState(nextGate, newDigest, repoRoot) {
  const statePath = path.join(repoRoot, STATE_PATH);
  // #189: atomic read-modify-write — the rollback merges onto the FRESH in-lock
  // state, so a concurrent gate advance can no longer be clobbered by (or clobber)
  // this rollback. The merged state is captured for the return; a missing/corrupt
  // state or lock failure yields null, exactly as the prior `!current.ok` did.
  /** @type {TaskState | undefined} */
  let next;
  const outcome = await mutateTaskStateUnderLock(
    (current) => {
      const merged = /** @type {TaskState} */ ({
        ...current,
        workflowGate: nextGate,
        artifactHashes: {
          ...current.artifactHashes,
          specDigest: newDigest,
        },
      });
      next = merged;
      return merged;
    },
    statePath,
    { event: "spec-integrity-rollback" },
  );
  return outcome.ok ? (next ?? null) : null;
}

/**
 * Append the `spec_invalidated` trace event.
 * @param {string} taskId
 * @param {string} reason
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
async function recordSpecInvalidated(taskId, reason, repoRoot) {
  await appendTraceEvent(
    {
      type: "spec_invalidated",
      taskId,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      reason,
    },
    { root: repoRoot },
  );
}

/**
 * Append the companion `gate_transition` event so the trace records the
 * actual gate move alongside the invalidation reason.
 * @param {string} taskId
 * @param {WorkflowGate} from
 * @param {WorkflowGate} to
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
async function recordGateTransition(taskId, from, to, repoRoot) {
  await appendTraceEvent(
    {
      type: "gate_transition",
      taskId,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      from,
      to,
      gate: to,
    },
    { root: repoRoot },
  );
}

/**
 * Decide whether the given file path points at the spec artifact, regardless
 * of whether the caller passed an absolute or workspace-relative path.
 * @param {string|undefined} filePath
 * @returns {boolean}
 */
export function isSpecPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const normalised = filePath.replace(/\\/g, "/");
  return normalised.endsWith(SPEC_REL_PATH);
}

/**
 * PostToolUse hook entry point. Detects post-approval spec edits and rolls
 * the workflow gate back to `spec-draft`.
 *
 * @param {PostToolUseEvent} event Hook event payload from VS Code.
 * @param {{ stdout?: NodeJS.WritableStream }} [opts] Test seam for stdout.
 * @returns {Promise<IntegrityGuardResult>}
 */
export async function handlePostToolUse(event, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const repoRoot = event.repoRoot ?? event.root ?? ".";

  if (!isSpecPath(event.filePath)) return { action: "no_action" };

  const stateResult = readTaskState(path.join(repoRoot, STATE_PATH));
  if (!stateResult.ok) return { action: "no_action" };

  const currentGate = stateResult.state.workflowGate;
  if (currentGate !== "spec-approved") return { action: "no_action" };

  const specAbs = path.join(repoRoot, SPEC_REL_PATH);
  const newDigest = await fileDigest(specAbs);
  if (!newDigest) return { action: "no_action" };

  const recordedDigest = stateResult.state.artifactHashes["specDigest"];
  if (digestsEqual(recordedDigest, newDigest)) {
    return { action: "no_action" };
  }

  const nextGate = advanceGate(currentGate, "spec-draft");
  // #189: mutateTaskStateUnderLock is non-throwing, so a lock/IO failure yields
  // null instead of aborting. Do NOT claim (or trace) a rollback that did not
  // persist — that would be a silent fail-open on the post-approval tamper guard.
  // The PostToolUse spec-digest re-verify is the backstop on the next edit.
  const rolledState = await rollbackState(nextGate, newDigest, repoRoot);
  const persisted = rolledState !== null;

  const taskId = resolveTaskId(event, repoRoot);
  if (taskId !== null && persisted) {
    await recordSpecInvalidated(
      taskId,
      "post-approval edit detected",
      repoRoot,
    );
    await recordGateTransition(taskId, currentGate, nextGate, repoRoot);
  }

  stdout.write(
    persisted
      ? "WARN: spec.md changed after approval. Gate rolled back to spec-draft.\n" +
          "    Run: approve spec   to re-approve the updated spec.\n"
      : "WARN: spec.md changed after approval, but the gate rollback could not be persisted " +
          "(state locked or unreadable). The gate stays spec-approved; it will be re-attempted on the next edit.\n",
  );

  return {
    action: "rollback",
    reason: "spec.md digest mismatch after spec-approved",
    from: currentGate,
    to: nextGate,
  };
}

/**
 * Read all of stdin as UTF-8. Returns '' when stdin is closed or empty, so a
 * hook fired with no payload degrades to a no-op instead of hanging.
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
function readAll(stdin) {
  return new Promise((res, rej) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", rej);
  });
}

/**
 * Translate a VS Code PostToolUse stdin payload into the {@link PostToolUseEvent}
 * this module's handler consumes.
 *
 * The wire payload does NOT carry a repo root — no hook event does — so the root
 * is inferred from `cwd`, climbing out of the workspace's own `.devmate/` folder
 * when the editor made that the cwd (which it does whenever `.devmate` is the
 * first workspace folder). The old handler default of `?? "."` silently anchored
 * on whatever cwd happened to be.
 *
 * The written file is at `tool_input.filePath` — VS Code's key. `path` is
 * accepted only as a fallback for synthetic payloads.
 * @param {unknown} raw  Parsed stdin JSON.
 * @returns {PostToolUseEvent}
 */
export function eventFromPayload(raw) {
  const obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};

  const repoRoot = resolveHookRoot(/** @type {{ cwd?: string }} */ (obj));

  /** @type {Record<string, unknown>} */
  const ti =
    obj["tool_input"] !== null &&
    typeof obj["tool_input"] === "object" &&
    !Array.isArray(obj["tool_input"])
      ? /** @type {Record<string, unknown>} */ (obj["tool_input"])
      : {};

  const filePath = firstToolInputPath(ti);

  /** @type {PostToolUseEvent} */
  const event = { repoRoot };
  if (filePath !== undefined) event.filePath = filePath;
  if (typeof obj["tool_name"] === "string") event.toolName = obj["tool_name"];
  return event;
}

/**
 * Entrypoint: read the PostToolUse payload from stdin and run the handler.
 * Follows CONTRIBUTING §6.
 *
 * Without this, the hook was **registered in hooks.json and did nothing**: node
 * loaded the module, defined these functions, and exited 0 having read no stdin
 * and taken no action. The spec-approval gate — devmate's one human checkpoint —
 * was therefore unprotected against a silent post-approval edit to spec.md, and
 * nothing else in the system re-hashes the file (#75).
 * @param {string[]} _args  CLI args (hook input arrives on stdin).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  let raw;
  try {
    raw = await readAll(process.stdin);
  } catch (/** @type {any} */ err) {
    process.stderr.write(
      `[spec-integrity-guard] failed to read stdin: ${err?.message ?? err}\n`,
    );
    return 0; // never block a tool call on a hook I/O fault
  }

  if (raw.trim() === "") return 0;

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {any} */ err) {
    process.stderr.write(
      `[spec-integrity-guard] malformed stdin JSON: ${err?.message ?? err}\n`,
    );
    return 0;
  }

  // Runtime scope: plugin-level hooks fire in EVERY Copilot session. Act only
  // inside a marked devmate session (lib/hooks/session-marker.mjs); otherwise
  // exit silently — no gate rollback, no state writes.
  if (!isDevmatePayload(parsed)) return 0;

  // The handler prints its rollback notice as human text. On exit 0 VS Code
  // parses stdout as JSON, so raw text is not "a message the model might miss" —
  // it is a parse failure, and the host drops the whole output. Capture what the
  // handler writes and hand the host the one envelope it reads (#77).
  const capture = createTextCapture();
  try {
    await handlePostToolUse(eventFromPayload(parsed), { stdout: capture.stream });
  } catch (/** @type {any} */ err) {
    // Best-effort by design (see the module header): a rollback failure must not
    // break the user's tool call. It IS reported, so it cannot fail silently the
    // way the missing entrypoint did.
    process.stderr.write(
      `[spec-integrity-guard] ${err?.message ?? err}\n`,
    );
  }
  return writeHookOutput('PostToolUse', capture.text(), 0);
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
