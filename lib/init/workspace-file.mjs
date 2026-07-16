// @ts-check
import { dirname, resolve, sep } from 'node:path';
import { listDir, readTextFile } from '../fs-safe.mjs';

/**
 * Parsed entry from the `folders` array of a `.code-workspace` file.
 * @typedef {Object} WorkspaceFolder
 * @property {string} path  Absolute resolved path to the folder root.
 * @property {string} [name]
 */

/**
 * Walk up from `dir` looking for the first `*.code-workspace` file.
 * Returns `null` if none found before the filesystem root.
 * @param {string} dir  Starting directory (absolute).
 * @returns {Promise<string|null>} Absolute path to the `.code-workspace` file, or null.
 */
export async function findCodeWorkspaceFile(dir) {
  let current = resolve(dir);
  while (true) {
    /** @type {string[]} */
    let entries;
    try {
      entries = await listDir(current);
    } catch {
      entries = [];
    }
    const found = entries.find((e) => e.endsWith('.code-workspace'));
    if (found) {
      return resolve(current, found);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Parse the `folders` array from a `.code-workspace` file, resolving each
 * `path` entry relative to the workspace file's own directory.
 * Entries with a `uri` key (remote/container folders) are skipped.
 * Returns an empty array on any parse error.
 * @param {string} wsFilePath  Absolute path to the `.code-workspace` file.
 * @returns {Promise<WorkspaceFolder[]>}
 */
export async function parseWorkspaceFolders(wsFilePath) {
  try {
    const raw = await readTextFile(wsFilePath);
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray(/** @type {Record<string,unknown>} */ (parsed)['folders'])
    ) {
      return [];
    }
    const wsDir = dirname(wsFilePath);
    /** @type {WorkspaceFolder[]} */
    const result = [];
    const folders = /** @type {unknown[]} */ (/** @type {Record<string,unknown>} */ (parsed)['folders']);
    for (const entry of folders) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = /** @type {Record<string, unknown>} */ (entry);
      if ('uri' in rec) continue; // remote/container folder — skip
      if (typeof rec['path'] !== 'string') continue;
      /** @type {WorkspaceFolder} */
      const folder = { path: resolve(wsDir, rec['path']) };
      if (typeof rec['name'] === 'string') folder.name = rec['name'];
      result.push(folder);
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Find the workspace folder whose resolved path is an ancestor of (or equal
 * to) `cwd`. Returns `null` if no folder matches.
 * @param {WorkspaceFolder[]} folders
 * @param {string} cwd  The directory to match (absolute).
 * @returns {string|null} Matched folder path, or null.
 */
export function matchFolderForCwd(folders, cwd) {
  const normalCwd = resolve(cwd);
  for (const folder of folders) {
    const f = resolve(folder.path);
    if (normalCwd === f || normalCwd.startsWith(f + sep)) {
      return f;
    }
  }
  return null;
}
