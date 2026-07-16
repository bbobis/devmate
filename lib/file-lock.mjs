// @ts-check
import { openSync, closeSync } from 'node:fs';
import { removeFileSync, writeTextFileSync } from './fs-safe.mjs';

/** @typedef {import('./types.mjs').LockOpts} LockOpts */
/** @typedef {import('./types.mjs').LockResult} LockResult */

/**
 * Suffix appended to a state-file path to form its lock-file path.
 * Exported so tests and CI can enumerate and clean up stale lock files.
 * @type {string}
 */
export const LOCK_SUFFIX = '.lock';

/**
 * Acquire an exclusive file lock at `lockPath`, run `fn`, then release the lock.
 * Uses O_EXCL (exclusive creation) for cross-platform mutual exclusion.
 * @param {string} lockPath
 * @param {() => unknown | Promise<unknown>} fn
 * @param {LockOpts} [opts]
 * @returns {Promise<LockResult>}
 */
export async function withFileLock(lockPath, fn, opts) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const retryIntervalMs = opts?.retryIntervalMs ?? 50;
  const owner = opts?.owner ?? String(process.pid);

  const deadline = Date.now() + timeoutMs;
  let fd = -1;

  // Attempt to acquire the lock by exclusive file creation.
  while (true) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- O_EXCL exclusive-create IS the lock-acquisition semantics; the facade deliberately does not expose open flags. lockPath is a caller-supplied state-file path plus the constant LOCK_SUFFIX ('.lock'), e.g. .devmate/state/task.json.lock.
      fd = openSync(lockPath, 'wx');
      break; // acquired
    } catch (/** @type {unknown} */ err) {
      const code = err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        if (Date.now() >= deadline) {
          return {
            acquired: false,
            error: `Lock timeout after ${timeoutMs}ms: ${lockPath}`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        continue;
      }
      return {
        acquired: false,
        error: `Lock acquire error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Write owner + timestamp into lock file for diagnostics.
  try {
    writeTextFileSync(lockPath, JSON.stringify({ owner, ts: new Date().toISOString() }) + '\n');
  } catch {
    // Non-fatal diagnostics write.
  }

  // Close the fd; we only needed exclusive creation via O_EXCL.
  try {
    closeSync(fd);
  } catch {
    // ignore
  }

  // Run fn; capture error so we can release the lock before re-throwing.
  let fnError = /** @type {unknown} */ (null);
  let result = /** @type {unknown} */ (undefined);
  try {
    result = await fn();
  } catch (/** @type {unknown} */ err) {
    fnError = err;
  }

  // Release lock file.
  try {
    removeFileSync(lockPath);
  } catch (/** @type {unknown} */ unlinkErr) {
    process.stderr.write(
      `[devmate] Warning: failed to unlink lock file ${lockPath}: ${
        unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
      }\n`
    );
  }

  if (fnError !== null) {
    throw fnError;
  }

  return { acquired: true, value: result };
}
