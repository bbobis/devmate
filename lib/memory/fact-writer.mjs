// @ts-check
import { resolve, relative, isAbsolute, sep, posix, extname } from 'node:path';
import { pathExists } from '../fs-safe.mjs';
import { createHash } from 'node:crypto';
import { appendJsonlWithHandle } from './append-jsonl.mjs';
import { normalizeForDigest } from './digest-normalize.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { markStale } from './stale-marker.mjs';
import { readTaskState, STATE_PATH } from '../task-state.mjs';
import { KNOWN_SOURCE_EDIT_TOOLS } from '../gate-guard-core.mjs';
import { firstToolInputPath } from '../hooks/tool-input.mjs';

/** @typedef {import('../types.mjs').HookPayload} HookPayload */
/** @typedef {import('../types.mjs').FactEntry} FactEntry */
/** @typedef {import('../types.mjs').FactWriteResult} FactWriteResult */
/** @typedef {import('../types.mjs').TaskState} TaskState */

/**
 * Edit-class tool names whose output triggers a fact write.
 *
 * This list used to be its own hand-maintained set — `str_replace_editor`,
 * `write_file`, `insert_content_into_file` — three names VS Code has never sent.
 * Together with an `extractPath` that read `tool_input.path` / `.file_path`
 * (also never sent), it meant stage 1 of the memory pipeline **collected nothing
 * from a source edit, ever**: every edit either failed the tool-name check or
 * skipped with `'missing path'`. The ledger looked healthy because the hook ran
 * and exited 0.
 *
 * It is now derived from the gate guard's vocabulary, so there is exactly one
 * list of "tools that write source" in the repo and it cannot drift out of sync
 * with the guard that gates them.
 * @type {ReadonlySet<string>}
 */
export const EDIT_CLASS_TOOLS = new Set(KNOWN_SOURCE_EDIT_TOOLS);

const MAX_SUMMARY_LEN = 120;
const MAX_CONTENT_DIGEST_LEN = 256;

/**
 * The file this edit targets. `payload.path` is devmate's own normalized field
 * (set by callers that already resolved it); everything else comes from the one
 * `tool_input` parser.
 * @param {HookPayload} payload
 * @returns {string|undefined}
 */
function extractPath(payload) {
  if (typeof payload.path === 'string' && payload.path.length > 0) {
    return payload.path;
  }
  return firstToolInputPath(payload.tool_input);
}

/**
 * Normalise a path to forward-slash separators and reject anything that
 * escapes the workspace root.
 *
 * Returns the workspace-relative path on success, or an `Error` instance on
 * rejection. Returning Error keeps the function pure (no throw) so the caller
 * decides how to surface it.
 * @param {string} rawPath
 * @param {string} workspaceRoot  Absolute path to the workspace root.
 * @returns {string | Error}
 */
function canonicaliseSource(rawPath, workspaceRoot) {
  const absInput = isAbsolute(rawPath)
    ? rawPath
    : resolve(workspaceRoot, rawPath);
  const rel = relative(workspaceRoot, absInput);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return new Error(`path escapes workspace root: ${rawPath}`);
  }
  return rel.split(sep).join(posix.sep);
}

/**
 * Derive tag list from a workspace-relative source path. Tags are stable and
 * cheap: extension (e.g. `ext:mjs`) and top-level directory segment
 * (e.g. `dir:lib`). Returns at most 2 tags.
 * Exported so every fact writer (edit facts here, discovery facts in
 * `discovery-facts.mjs`) tags identically and queries never fork on tag shape.
 * @param {string} relSource
 * @returns {string[]}
 */
export function deriveTags(relSource) {
  /** @type {string[]} */
  const tags = [];
  const ext = extname(relSource);
  if (ext.length > 1) tags.push(`ext:${ext.slice(1)}`);
  const top = relSource.split(posix.sep)[0];
  if (top && top !== relSource) tags.push(`dir:${top}`);
  return tags;
}

/**
 * Build a short, human-readable summary. Capped at 120 chars.
 * @param {string} tool
 * @param {string} relSource
 * @returns {string}
 */
function buildSummary(tool, relSource) {
  const last = relSource.split(posix.sep).pop() ?? relSource;
  const raw = `${tool} edited ${last}`;
  return raw.length > MAX_SUMMARY_LEN ? raw.slice(0, MAX_SUMMARY_LEN) : raw;
}

/**
 * Read TaskState if present; return `{ lane: 'unknown', stepId: 'none' }` if
 * the state file is absent, missing, or malformed.
 * @param {string|undefined} stateDir
 * @returns {{ lane: string, stepId: string }}
 */
function readLaneAndStep(stateDir) {
  const statePath = stateDir ? `${stateDir}/task.json` : STATE_PATH;
  if (!pathExists(statePath)) return { lane: 'unknown', stepId: 'none' };
  try {
    const result = readTaskState(statePath);
    if (!result.ok) return { lane: 'unknown', stepId: 'none' };
    return {
      lane: result.state.lane,
      stepId: String(result.state.currentStep),
    };
  } catch {
    return { lane: 'unknown', stepId: 'none' };
  }
}

/**
 * Compute a content digest from a payload `content` field, if any. Returns at
 * most 256 hex characters (SHA-256 is 64 hex). Never writes the raw content.
 * @param {string|undefined} content
 * @returns {string|undefined}
 */
function contentDigest(content) {
  if (typeof content !== 'string' || content.length === 0) return undefined;
  // #148: hash checkout-invariant (line-ending-normalized) content so the digest
  // is a function of logical content, not the checkout's CR/LF.
  const hex = createHash('sha256').update(normalizeForDigest(content), 'utf8').digest('hex');
  return hex.slice(0, MAX_CONTENT_DIGEST_LEN);
}

/**
 * Derive and write a fact entry from a hook payload.
 *
 * Behaviour:
 *  - Non-edit tools return `{ ok: true, fact: null, skipReason: 'non-edit tool' }`.
 *  - Payloads missing a `path` return `{ ok: true, fact: null, skipReason: 'missing path' }`.
 *  - Paths escaping the workspace return `{ ok: false, skipReason: 'path_escape', ... }`.
 *  - Lock timeouts return `{ ok: false, skipReason: 'lock_timeout', ... }`.
 *
 * @param {HookPayload} payload
 * @param {string}      ledgerPath   Absolute path to the task fact ledger (JSONL).
 * @param {{ stateDir?: string, workspaceRoot?: string }} [opts]
 * @returns {Promise<FactWriteResult>}
 */
export async function writeFact(payload, ledgerPath, opts = {}) {
  if (!payload || typeof payload !== 'object' || typeof payload.tool_name !== 'string') {
    return { ok: false, fact: null, skipReason: 'invalid payload', ledgerPath };
  }

  const tool = payload.tool_name;
  if (!EDIT_CLASS_TOOLS.has(tool)) {
    return { ok: true, fact: null, skipReason: 'non-edit tool', ledgerPath };
  }

  const rawPath = extractPath(payload);
  if (!rawPath) {
    return { ok: true, fact: null, skipReason: 'missing path', ledgerPath };
  }

  // `payload.workspaceRoot` is gone from this chain: no hook event sends it, so
  // it could only ever be undefined here. `cwd` is the real field (#77).
  const workspaceRoot = opts.workspaceRoot ?? payload.cwd ?? process.cwd();
  const canon = canonicaliseSource(rawPath, workspaceRoot);
  if (canon instanceof Error) {
    return { ok: false, fact: null, skipReason: `path_escape: ${canon.message}`, ledgerPath };
  }

  const { lane, stepId } = readLaneAndStep(opts.stateDir);
  const digest = contentDigest(payload.content);

  // Acquire the ledger lock once; markStale (scan + stale appends) and the new
  // fact append all run inside this single critical section so no third writer
  // can insert a fact for the same source between the scan and the writes.
  /** @type {import('../types.mjs').LockHandle | null} */
  let handle = null;
  try {
    handle = await acquireLock(ledgerPath);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return { ok: false, fact: null, skipReason: 'lock_timeout', ledgerPath };
    }
    throw err;
  }

  try {
    // Stale any prior active facts for this source; `firstEdit` is derived from
    // whether markStale found a prior active fact.
    const staleResult = await markStale(
      ledgerPath,
      { path: canon, ...(digest ? { digest } : {}) },
      'changed',
      { handle },
    );
    const firstEdit = staleResult.firstEdit;

    const ts = Date.now();
    const key = digest ? `${canon}:${digest.slice(0, 8)}` : `${canon}:${ts}`;

    /** @type {FactEntry} */
    const fact = {
      event: 'fact',
      key,
      source: canon,
      tool,
      lane,
      tags: deriveTags(canon),
      summary: buildSummary(tool, canon),
      confidence: 0.8,
      ts,
      stepId,
      firstEdit,
      ...(digest ? { contentDigest: digest } : {}),
    };

    await appendJsonlWithHandle(ledgerPath, fact);
    return { ok: true, fact, skipReason: null, ledgerPath };
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return { ok: false, fact: null, skipReason: 'lock_timeout', ledgerPath };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, fact: null, skipReason: `append_failed: ${msg}`, ledgerPath };
  } finally {
    await releaseLock(handle);
  }
}
