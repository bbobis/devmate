// @ts-check
// Lock sentinel files follow the pattern: <ledgerPath>.lock
// Add `*.lock` to .gitignore to avoid committing stale sentinels.
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appendTextFile, ensureDir, removeFile } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').LockHandle} LockHandle */
/** @typedef {import('../types.mjs').LockOpts} LockOpts */

/**
 * Error thrown when acquireLock times out waiting for the sentinel to be freed.
 */
export class LockTimeoutError extends Error {
  /**
   * @param {string} ledgerPath
   * @param {number} timeoutMs
   */
  constructor(ledgerPath, timeoutMs) {
    super(`Lock timeout after ${timeoutMs}ms for ${ledgerPath}`);
    this.name = 'LockTimeoutError';
    this.ledgerPath = ledgerPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Release a previously acquired lock by deleting the sentinel file.
 * Idempotent — safe to call if the sentinel was already cleaned up.
 * @param {LockHandle} handle
 * @returns {Promise<void>}
 */
export async function releaseLock(handle) {
  try {
    await removeFile(handle.lockPath);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      throw err;
    }
    // ENOENT means already removed — idempotent, ignore.
  }
}

/**
 * Acquire an exclusive lock for `ledgerPath` by creating `ledgerPath + ".lock"`
 * with the O_EXCL flag. Polls every `retryIntervalMs` until acquired or timed out.
 * On timeout, writes a structured `lock_timeout` entry to the ledger before rejecting.
 * @param {string}   ledgerPath
 * @param {LockOpts} [opts]
 * @returns {Promise<LockHandle>}
 */
export async function acquireLock(ledgerPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryIntervalMs = opts.retryIntervalMs ?? 50;
  const lockPath = ledgerPath + '.lock';
  const deadline = Date.now() + timeoutMs;

  // The sentinel lives in the same directory as the ledger. Ensure that
  // directory exists before the O_EXCL open below, otherwise the open fails
  // with ENOENT (not EEXIST) for a not-yet-created nested ledger path.
  await ensureDir(dirname(ledgerPath));

  while (true) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- O_EXCL exclusive-create ('wx') IS the lock-acquisition semantics; facade wrappers deliberately do not expose open flags. Lock path is ledgerPath + '.lock' (a caller-trusted ledger path plus a constant suffix).
      const fh = await open(lockPath, 'wx');
      await fh.close();
      break;
    } catch (/** @type {unknown} */ err) {
      const code =
        err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        if (Date.now() >= deadline) {
          // Write a structured timeout entry best-effort (no lock held).
          const entry = {
            event: 'lock_timeout',
            ledgerPath,
            timeoutMs,
            ts: new Date().toISOString(),
          };
          try {
            await appendTextFile(ledgerPath, JSON.stringify(entry) + '\n');
          } catch {
            // best-effort; ignore write failures
          }
          throw new LockTimeoutError(ledgerPath, timeoutMs);
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        continue;
      }
      throw err;
    }
  }

  /** @type {LockHandle} */
  const handle = {
    lockPath,
    release: () => releaseLock(handle),
  };
  return handle;
}
