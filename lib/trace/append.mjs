// @ts-check

/**
 * E6-1: Single trace append utility.
 *
 * `appendTraceEvent` validates an event (via `validateTraceEvent`), then
 * appends one JSONL line to `.devmate/state/trace/<taskId>.jsonl`. It is the
 * one path every other E6 issue reads from / writes through.
 *
 * Concurrency: the read-modify-write (count existing lines, then append) is
 * serialized per file path via E6-4's withAppendLock so concurrent in-process
 * appends to the same trace file cannot interleave or share a line number.
 */

import path from "node:path";
import { appendTextFile, ensureDir, readTextFile } from "../fs-safe.mjs";
import { withAppendLock } from "./lock.mjs";
import {
  isKnownTraceEventType,
  UnknownTraceEventError,
  validateTraceEvent,
} from "./schema.mjs";

/** @typedef {import('../types.mjs').TraceEvent} TraceEvent */

/** Directory (cwd-relative) holding per-task trace files. */
export const TRACE_DIR = ".devmate/state/trace";

/**
 * Resolve the trace file path for a task.
 *
 * `root` is REQUIRED. It used to default to `"."` — process cwd — and none of
 * the 11 hook call sites passed one, so whenever the host set cwd to the
 * workspace's own `.devmate/` folder (which VS Code does when `.devmate` is
 * workspaceFolders[0]), every trace landed in `.devmate/.devmate/state/trace/`.
 * A required parameter turns a forgotten root into a typecheck error instead of
 * a wrong write in production (#76).
 * @param {string} taskId
 * @param {string} root  Absolute workspace root (from resolveHookRoot) or a test tmp dir.
 * @returns {string}
 */
export function traceFilePath(taskId, root) {
  return path.join(root, TRACE_DIR, `${taskId}.jsonl`);
}

/**
 * Count the lines already in a trace file (0 if it does not exist).
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countLines(filePath) {
  try {
    const contents = await readTextFile(filePath);
    if (contents.length === 0) return 0;
    // Trailing newline produces one empty trailing segment — drop it.
    const lines = contents.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  } catch (/** @type {any} */ err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Append one validated trace event to the task trace file.
 * Path: `<root>/.devmate/state/trace/<taskId>.jsonl`.
 *
 * `opts.root` is REQUIRED (see {@link traceFilePath} for why the cwd default
 * was removed). A call without it returns `{ ok: false }` naming the missing
 * root — a trace write is diagnostics, so it degrades loudly rather than
 * throwing through a hook.
 * @param {TraceEvent} event
 * @param {{ root: string }} opts  Absolute workspace root (resolveHookRoot) or a test tmp dir.
 * @returns {Promise<{ ok: boolean, lineNumber: number, errors?: string[] }>}
 */
export async function appendTraceEvent(event, opts) {
  // E11-3: An unknown `type` is a programmer error (e.g. typo / removed event
  // kind), not data-validation noise, so it throws rather than returning a
  // soft failure. Known types with malformed fields still flow through the
  // `{ ok: false, errors }` result path below.
  const evType = /** @type {{ type?: unknown }} */ (event ?? {}).type;
  if (typeof evType === "string" && !isKnownTraceEventType(evType)) {
    throw new UnknownTraceEventError(evType);
  }

  const { ok, errors } = validateTraceEvent(event);
  if (!ok) {
    return { ok: false, lineNumber: 0, errors };
  }

  const root = opts?.root;
  if (typeof root !== "string" || root === "") {
    return {
      ok: false,
      lineNumber: 0,
      errors: ["appendTraceEvent requires opts.root (resolve it with resolveHookRoot)"],
    };
  }
  const filePath = traceFilePath(event.taskId, root);
  const dir = path.dirname(filePath);
  const line = JSON.stringify(event) + "\n";

  // Serialize the count-then-append per file path so concurrent in-process
  // callers each get a distinct, monotonic line number.
  return withAppendLock(filePath, async () => {
    await ensureDir(dir);

    const before = await countLines(filePath);

    // appendTextFile is byte-equivalent to the previous open("a") + write +
    // close sequence: fs.appendFile opens with the "a" flag internally.
    await appendTextFile(filePath, line);

    return { ok: true, lineNumber: before + 1 };
  });
}
