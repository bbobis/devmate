// @ts-check
import { dirname } from 'node:path';
import { appendTextFile, ensureDir } from '../fs-safe.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { shouldCompact, compactLedger } from './compact.mjs';

/** @typedef {import('../types.mjs').LockOpts} LockOpts */
/** @typedef {import('../types.mjs').AppendResult} AppendResult */
/** @typedef {import('../types.mjs').CompactOpts} CompactOpts */

/**
 * @typedef {LockOpts & {
 *   autoCompact?: boolean,
 *   compact?: CompactOpts,
 * }} AppendOpts
 */

/**
 * Append a single JSON-serialisable entry to `ledgerPath` under exclusive lock.
 * Creates the ledger file (and any missing parent directories) if they do not exist.
 *
 * After the append (and only after releasing the append lock), the ledger is
 * checked against its size caps. If it exceeds them, `compactLedger` runs under
 * its own lock — bounding ledger growth without caller awareness (E3-5).
 * Pass `opts.autoCompact === false` to disable this behaviour.
 * @param {string}    ledgerPath
 * @param {unknown}   entry
 * @param {AppendOpts} [opts]
 * @returns {Promise<AppendResult>}
 */
export async function appendJsonl(ledgerPath, entry, opts = {}) {
  /** @type {import('../types.mjs').LockHandle | null} */
  let handle = null;
  /** @type {{ event: 'lock_timeout', ledgerPath: string, timeoutMs: number } | null} */
  let timeoutEntry = null;

  try {
    handle = await acquireLock(ledgerPath, opts);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      timeoutEntry = {
        event: 'lock_timeout',
        ledgerPath,
        timeoutMs: err.timeoutMs,
      };
      return { ok: false, ledgerPath, bytesWritten: 0, timeoutEntry };
    }
    throw err;
  }

  // Parent directories are ensured inside acquireLock (the sentinel and the
  // ledger share a directory), so by here the directory already exists.
  const line = JSON.stringify(entry) + '\n';
  try {
    await appendTextFile(ledgerPath, line);
  } finally {
    await releaseLock(handle);
  }

  // Auto-compaction: outside the append lock, under compactLedger's own lock.
  if (opts.autoCompact !== false) {
    const compactOpts = opts.compact ?? {};
    if (await shouldCompact(ledgerPath, compactOpts)) {
      await compactLedger(ledgerPath, compactOpts);
    }
  }

  return { ok: true, ledgerPath, bytesWritten: line.length, timeoutEntry: null };
}

/**
 * Append a single JSON-serialisable entry to `ledgerPath` WITHOUT acquiring a
 * lock. The caller MUST already hold the exclusive lock for `ledgerPath`
 * (e.g. via `acquireLock`). Use this to perform multiple writes atomically
 * within one lock acquisition — for example, staling prior facts and then
 * appending a new fact in a single critical section.
 *
 * Creates the ledger file (and any missing parent directories) if they do not exist.
 * @param {string}  ledgerPath
 * @param {unknown} entry
 * @returns {Promise<AppendResult>}
 */
export async function appendJsonlWithHandle(ledgerPath, entry) {
  const line = JSON.stringify(entry) + '\n';
  await ensureDir(dirname(ledgerPath));
  await appendTextFile(ledgerPath, line);
  return { ok: true, ledgerPath, bytesWritten: line.length, timeoutEntry: null };
}
