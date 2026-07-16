// @ts-check
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ensureDir,
  removeFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';

/**
 * Atomically write a JSON-serialisable result object to a state file.
 * Creates parent directories if needed. Never throws — returns ok/error.
 *
 * Strategy: write to a sibling temp file first, then rename (atomic on
 * POSIX; best-effort on Windows where rename over existing is not atomic
 * but is still safer than a partial overwrite).
 *
 * @param {string} filePath  Absolute or workspace-relative path.
 * @param {unknown} data     JSON-serialisable result object.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string }>}
 */
export async function writeResult(filePath, data) {
  const abs = resolve(filePath);
  let serialised;
  try {
    serialised = JSON.stringify(data);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `serialisation failed: ${msg}` };
  }
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await ensureDir(dirname(abs));
    await writeTextFile(tmp, serialised);
    await renamePath(tmp, abs);
    return { ok: true, path: abs };
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort cleanup of the temp file.
    await removeFile(tmp).catch(() => {});
    return { ok: false, error: `write failed: ${msg}` };
  }
}
