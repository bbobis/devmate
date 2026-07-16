// @ts-check
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDirEntries, readTextFileSync, statPath } from './fs-safe.mjs';
import { matchGlob } from './gate-guard-core.mjs';

/** @typedef {import('./types.mjs').AllowlistEntry} AllowlistEntry */
/** @typedef {import('./types.mjs').AllowlistResult} AllowlistResult */

/**
 * Default path to the allowlist JSON.
 * @param {string} [allowlistPath]
 * @returns {string}
 */
function resolveAllowlistPath(allowlistPath) {
  if (allowlistPath) return allowlistPath;
  // Resolve relative to the repo root (one level up from lib/).
  // fileURLToPath, never URL.pathname: pathname of file:///C:/... is /C:/...
  // on Windows, which resolve() turns into C:\C:\... (ENOENT).
  const libDir = dirname(fileURLToPath(import.meta.url));
  return join(libDir, '..', 'docs', 'artifact-allowlist.json');
}

/**
 * Load and parse `docs/artifact-allowlist.json`.
 * @param {string} [allowlistPath]  Override path for tests.
 * @returns {AllowlistResult}
 */
export function loadAllowlist(allowlistPath) {
  const filePath = resolveAllowlistPath(allowlistPath);
  let raw;
  try {
    raw = readTextFileSync(filePath);
  } catch (err) {
    throw new Error(`allowlist: cannot read file at ${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`allowlist: malformed JSON in ${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(/** @type {any} */ (parsed).entries) ||
    typeof /** @type {any} */ (parsed).schemaVersion !== 'number'
  ) {
    throw new Error(`allowlist: ${filePath} must have { schemaVersion: number, entries: [] }`);
  }
  return /** @type {AllowlistResult} */ (parsed);
}

/**
 * Check whether a repo-relative file path matches any allowlist entry.
 * @param {string} filePath        Repo-relative path to check.
 * @param {AllowlistEntry[]} entries
 * @returns {boolean}
 */
export function isAllowed(filePath, entries) {
  const normalised = filePath.replace(/\\/g, '/');
  for (const entry of entries) {
    const pattern = entry.path.replace(/\\/g, '/');
    if (matchGlob(pattern, normalised)) return true;
    // Also match if the allowlist entry is a directory prefix
    if (!pattern.includes('*') && normalised.startsWith(pattern + '/')) return true;
  }
  return false;
}

/**
 * Recursively walk a directory and yield all file paths relative to `baseDir`.
 * @param {string} dir      Absolute path to directory to walk.
 * @param {string} baseDir  Absolute repo root used to compute repo-relative paths.
 * @returns {AsyncGenerator<string>}
 */
async function* walkDir(dir, baseDir) {
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, baseDir);
    } else {
      // Compute repo-relative path with forward slashes
      const rel = full.slice(baseDir.length).replace(/\\/g, '/').replace(/^\//, '');
      yield rel;
    }
  }
}

/**
 * Scan `watchedDirs` for files not covered by the allowlist.
 * @param {string[]} watchedDirs   Repo-relative directories to scan.
 * @param {AllowlistEntry[]} entries
 * @param {string} [repoRoot]      Override repo root for tests.
 * @returns {Promise<string[]>}    Unlisted file paths.
 */
export async function findUnlistedFiles(watchedDirs, entries, repoRoot) {
  // fileURLToPath, never URL.pathname (Windows: /C:/... resolves to C:\C:\...).
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

  /** @type {string[]} */
  const unlisted = [];

  for (const dir of watchedDirs) {
    const absDir = join(root, dir);
    let exists = false;
    try {
      const s = await statPath(absDir);
      exists = s.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;

    for await (const relPath of walkDir(absDir, root)) {
      if (!isAllowed(relPath, entries)) {
        unlisted.push(relPath);
      }
    }
  }

  return unlisted;
}
