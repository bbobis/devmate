// @ts-check
// Stale-marker semantics for the JSONL fact ledger (E3-3).
//
// A fact entry is "active" if no later `stale` entry invalidates it. When a
// source changes (or is renamed/deleted, or duplicated within a step), all
// prior active facts for that source are marked stale before the new fact is
// written. Scan + stale-append run under a single exclusive lock so no third
// writer can slip a fact in between the scan and the stale write.
import { resolve, relative, isAbsolute, sep, posix } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { appendJsonlWithHandle } from './append-jsonl.mjs';

/** @typedef {import('../types.mjs').SourceIdentity} SourceIdentity */
/** @typedef {import('../types.mjs').StaleReason} StaleReason */
/** @typedef {import('../types.mjs').StaleEntry} StaleEntry */
/** @typedef {import('../types.mjs').MarkStaleResult} MarkStaleResult */
/** @typedef {import('../types.mjs').HookPayload} HookPayload */
/** @typedef {import('../types.mjs').LockHandle} LockHandle */
/** @typedef {import('./jsonl-lock.mjs').LockOpts} LockOpts */

/**
 * Extract a candidate file path from a hook payload. Mirrors the extraction
 * logic in fact-writer.mjs: `payload.path`, `tool_input.path`, or
 * `tool_input.file_path`.
 * @param {HookPayload} payload
 * @returns {string|undefined}
 */
function extractPath(payload) {
  if (typeof payload.path === 'string' && payload.path.length > 0) {
    return payload.path;
  }
  const ti = payload.tool_input;
  if (ti && typeof ti === 'object') {
    const p = /** @type {Record<string, unknown>} */ (ti)['path'];
    if (typeof p === 'string' && p.length > 0) return p;
    const fp = /** @type {Record<string, unknown>} */ (ti)['file_path'];
    if (typeof fp === 'string' && fp.length > 0) return fp;
  }
  return undefined;
}

/**
 * Normalise a raw path to a workspace-relative, forward-slash path. Returns
 * `null` if the path escapes the workspace root or is the root itself.
 * @param {string} rawPath
 * @param {string} workspaceRoot
 * @returns {string|null}
 */
function canonicalisePath(rawPath, workspaceRoot) {
  const absInput = isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath);
  const rel = relative(workspaceRoot, absInput);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join(posix.sep);
}

/**
 * Derive the canonical SourceIdentity from a hook payload.
 * Returns `null` if the payload does not represent an identifiable file source
 * (e.g. terminal commands) or if the path escapes the workspace root.
 * @param {HookPayload} payload
 * @param {{ workspaceRoot?: string }} [opts]
 * @returns {SourceIdentity | null}
 */
export function resolveSourceIdentity(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const rawPath = extractPath(payload);
  if (!rawPath) return null;
  // `payload.workspaceRoot` used to sit in this chain. No hook event carries it,
  // so it was dead weight that made the fiction look load-bearing; `cwd` is the
  // real field, and the caller's explicit root wins over both (#77).
  const workspaceRoot = opts.workspaceRoot ?? payload.cwd ?? process.cwd();
  const canon = canonicalisePath(rawPath, workspaceRoot);
  if (canon === null) return null;
  return { path: canon };
}

/**
 * Read every line of `ledgerPath` and return the set of `ts` values for facts
 * that are still active for `sourcePath`. A fact is active if no later `stale`
 * entry has a matching `stalledFactTs`. Returns an empty array if the file is
 * missing or has no active facts for the source.
 *
 * Streams the file line-by-line so a large ledger is not fully materialised
 * as parsed objects; only the small set of timestamps is retained.
 * @param {string} ledgerPath
 * @param {string} sourcePath  Workspace-relative normalised path.
 * @returns {Promise<number[]>} Active fact timestamps, in file order.
 */
async function scanActiveFactTimestamps(ledgerPath, sourcePath) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(ledgerPath);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  if (raw.length === 0) return [];

  /** @type {Set<number>} */
  const factTs = new Set();
  /** @type {Set<number>} */
  const staledTs = new Set();

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    /** @type {Record<string, unknown>} */
    let parsed;
    try {
      parsed = /** @type {Record<string, unknown>} */ (JSON.parse(line));
    } catch {
      continue; // skip malformed lines
    }
    const event = parsed['event'];
    if (event === 'fact') {
      // fact-writer.mjs writes `source` as a string path.
      if (parsed['source'] === sourcePath && typeof parsed['ts'] === 'number') {
        factTs.add(parsed['ts']);
      }
    } else if (event === 'stale') {
      const src = parsed['source'];
      const srcPath =
        typeof src === 'string'
          ? src
          : src && typeof src === 'object'
            ? /** @type {Record<string, unknown>} */ (src)['path']
            : undefined;
      if (srcPath === sourcePath && typeof parsed['stalledFactTs'] === 'number') {
        staledTs.add(parsed['stalledFactTs']);
      }
    }
  }

  const active = [];
  for (const ts of factTs) {
    if (!staledTs.has(ts)) active.push(ts);
  }
  active.sort((a, b) => a - b);
  return active;
}

/**
 * Scan `ledgerPath` for active (non-staled) facts matching `sourceIdentity`
 * and append a `StaleEntry` for each. If none are found, returns
 * `{ markedCount: 0, firstEdit: true, entries: [] }` — this is NOT an error.
 *
 * The scan + stale appends happen under one exclusive lock so no new fact for
 * the same source can slip between scan and write. If `opts.handle` is given
 * the caller already holds the lock and this function will NOT acquire or
 * release it (lets a caller share one lock across markStale + fact append).
 * @param {string}         ledgerPath
 * @param {SourceIdentity} sourceIdentity
 * @param {StaleReason}    reason
 * @param {{ lockOpts?: LockOpts, handle?: LockHandle }} [opts]
 * @returns {Promise<MarkStaleResult>}
 */
export async function markStale(ledgerPath, sourceIdentity, reason, opts = {}) {
  const ownsLock = !opts.handle;
  /** @type {LockHandle} */
  let handle;
  if (opts.handle) {
    handle = opts.handle;
  } else {
    handle = await acquireLock(ledgerPath, opts.lockOpts);
  }

  try {
    const activeTs = await scanActiveFactTimestamps(ledgerPath, sourceIdentity.path);
    if (activeTs.length === 0) {
      return { markedCount: 0, firstEdit: true, entries: [] };
    }

    /** @type {StaleEntry[]} */
    const entries = [];
    const now = Date.now();
    for (const ts of activeTs) {
      /** @type {StaleEntry} */
      const entry = {
        event: 'stale',
        source: { path: sourceIdentity.path, ...(sourceIdentity.digest ? { digest: sourceIdentity.digest } : {}) },
        reason,
        stalledFactTs: ts,
        ts: now,
      };
      await appendJsonlWithHandle(ledgerPath, entry);
      entries.push(entry);
    }
    return { markedCount: entries.length, firstEdit: false, entries };
  } finally {
    if (ownsLock) {
      await releaseLock(handle);
    }
  }
}

export { LockTimeoutError };
