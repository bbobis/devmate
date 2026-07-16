// @ts-check
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ensureDirSync,
  listDirEntries,
  readTextFileSync,
  removeFile,
  renamePath,
  writeTextFileSync,
} from '../fs-safe.mjs';

/**
 * The single canonical memory file path, relative to the repo root.
 * @type {string}
 */
export const MEMORY_PATH = '.devmate/MEMORY.md';

/**
 * Canonical relative directory containing per-task fact ledgers.
 * @type {string}
 */
export const TASK_LEDGER_DIR = '.devmate/memory/tasks';

/**
 * Canonical relative path of the shared repo ledger.
 * @type {string}
 */
export const REPO_LEDGER_REL = '.devmate/state/repo/repo.jsonl';

/**
 * Allowed task-id shape for filesystem-safe ledger naming.
 * @type {RegExp}
 */
export const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Known non-canonical memory paths to migrate from and to flag in CI.
 * @type {string[]}
 */
export const OLD_MEMORY_PATHS = [
  'MEMORY.md',
  'state/MEMORY.md',
  '.copilot/MEMORY.md',
];

/**
 * Repo-relative paths excluded from the non-canonical reference scan.
 * @type {string[]}
 */
export const SCAN_EXCLUDED_FILES = [
  'lib/memory/paths.mjs',
  'scripts/migrate-memory-path.mjs',
  'scripts/check-memory-path-refs.mjs',
  'scripts/migrate-devmate-dir.mjs',
  'docs/memory.md',
  'CHANGELOG.md',
  'lib/init/devmate-init.mjs',
];

/**
 * Directory names excluded from the non-canonical reference scan.
 * @type {string[]}
 */
export const SCAN_EXCLUDED_DIRS = ['node_modules', '.git', 'test'];

/**
 * @typedef {Object} MigrationResult
 * @property {string[]} moved
 * @property {string[]} skipped
 * @property {string[]} errors
 */

/**
 * @typedef {Object} PathRefViolation
 * @property {string} file
 * @property {number} line
 * @property {string} match
 */

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function memoryMdPath(repoRoot) {
  return join(repoRoot, MEMORY_PATH);
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoLedgerPath(repoRoot) {
  return join(repoRoot, REPO_LEDGER_REL);
}

/**
 * @param {string} taskId
 * @returns {void}
 */
export function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError(
      `taskId must be a non-empty string; got ${JSON.stringify(taskId)}`,
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new TypeError(
      `taskId must match ${String(TASK_ID_RE)}; got ${JSON.stringify(taskId)}`,
    );
  }
}

/**
 * @param {string} repoRoot
 * @param {string} taskId
 * @returns {string}
 */
export function taskLedgerPath(repoRoot, taskId) {
  validateTaskId(taskId);
  return join(repoRoot, TASK_LEDGER_DIR, `${taskId}.jsonl`);
}

/**
 * Backward-compatible alias used by existing migration tests/scripts.
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveMemoryPath(repoRoot) {
  return memoryMdPath(repoRoot);
}

/**
 * @returns {string}
 */
function pointerStub() {
  return `> Moved to \`${MEMORY_PATH}\`. This file is a pointer; see docs/memory.md.\n`;
}

/**
 * @param {string} repoRoot
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<MigrationResult>}
 */
export async function migrateMemoryPaths(repoRoot, opts = {}) {
  const dryRun = opts.dryRun ?? false;
  const canonicalAbs = resolveMemoryPath(repoRoot);

  /** @type {MigrationResult} */
  const result = { moved: [], skipped: [], errors: [] };

  for (const oldRel of OLD_MEMORY_PATHS) {
    if (oldRel === MEMORY_PATH) {
      result.skipped.push(oldRel);
      continue;
    }

    const oldAbs = join(repoRoot, oldRel);
    /** @type {string} */
    let content;
    try {
      content = readTextFileSync(oldAbs);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        result.skipped.push(oldRel);
        continue;
      }
      result.errors.push(`${oldRel}: ${/** @type {Error} */ (err).message}`);
      continue;
    }

    if (dryRun) {
      result.moved.push(oldRel);
      continue;
    }

    try {
      ensureDirSync(dirname(canonicalAbs));

      try {
        const existing = readTextFileSync(canonicalAbs);
        const separator = existing.endsWith('\n') ? '' : '\n';
        writeTextFileSync(canonicalAbs, existing + separator + content);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
          throw err;
        }
        writeTextFileSync(canonicalAbs, content);
      }

      writeTextFileSync(oldAbs, pointerStub());
      result.moved.push(oldRel);
    } catch (err) {
      result.errors.push(`${oldRel}: ${/** @type {Error} */ (err).message}`);
    }
  }

  return result;
}

/**
 * @returns {{ label: string }[]}
 */
function buildMatchers() {
  return OLD_MEMORY_PATHS.map((p) => ({ label: p }));
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isPathTokenChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  return (
    isUpper ||
    isLower ||
    isDigit ||
    ch === '_' ||
    ch === '.' ||
    ch === '/' ||
    ch === '\\' ||
    ch === '-'
  );
}

/**
 * @param {string} line
 * @param {string} needle
 * @returns {string[]}
 */
function findStandaloneOccurrences(line, needle) {
  /** @type {string[]} */
  const out = [];
  let from = 0;
  while (true) {
    const idx = line.indexOf(needle, from);
    if (idx === -1) break;
    const prev = idx === 0 ? '' : line[idx - 1];
    const nextIdx = idx + needle.length;
    const next = nextIdx >= line.length ? '' : line.charAt(nextIdx);
    if (!isPathTokenChar(prev) && !isPathTokenChar(next)) {
      out.push(needle);
    }
    from = idx + needle.length;
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_DIRS.includes(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

/**
 * @param {string} repoRoot
 * @param {string[]} [extensions]
 * @returns {Promise<PathRefViolation[]>}
 */
export async function findNonCanonicalRefs(
  repoRoot,
  extensions = ['.mjs', '.md', '.json'],
) {
  const matchers = buildMatchers();
  /** @type {PathRefViolation[]} */
  const violations = [];

  for await (const abs of walk(repoRoot)) {
    if (!extensions.some((ext) => abs.endsWith(ext))) continue;

    const rel = resolve(abs)
      .slice(resolve(repoRoot).length)
      .split('\\')
      .join('/')
      .replace(/^\//, '');
    if (SCAN_EXCLUDED_FILES.includes(rel)) continue;

    let text;
    try {
      text = readTextFileSync(abs);
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const { label } of matchers) {
        const matches = findStandaloneOccurrences(line, label);
        for (const match of matches) {
          violations.push({ file: rel, line: i + 1, match });
        }
      }
    }
  }

  return violations;
}

/**
 * Move `fromPath` to `toPath` preserving data. Cross-device moves fall back to
 * copy+unlink so migration remains deterministic.
 * @param {string} fromPath
 * @param {string} toPath
 * @returns {Promise<boolean>} true when moved, false when source missing.
 */
export async function moveFileIfPresent(fromPath, toPath) {
  let content;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate raw Buffer read (no encoding) so the EXDEV copy fallback preserves bytes exactly; the utf8-only facade wrappers would round-trip through a string. Paths are trusted repo-local migration sources.
    content = readFileSync(fromPath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  ensureDirSync(dirname(toPath));
  try {
    await renamePath(fromPath, toPath);
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EXDEV') {
      // If destination exists, keep destination and leave source untouched.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate raw write of the Buffer read above (byte-exact EXDEV copy); facade writers are utf8-string-only. Paths are trusted repo-local migration targets.
  writeFileSync(toPath, content);
  await removeFile(fromPath);
  return true;
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export async function listLegacyTaskLedgers(repoRoot) {
  const legacyDir = join(repoRoot, '.devmate/state/tasks');
  let entries;
  try {
    entries = await listDirEntries(legacyDir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(legacyDir, basename(entry.name)));
}