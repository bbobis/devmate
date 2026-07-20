// @ts-check
// CI guard (#112): every direct `writeTaskState(` caller under lib/, scripts/,
// hooks/ must be a justified exception in docs/state-writer-allowlist.json.
// mutateTaskStateUnderLock is the canonical atomic mutation API; a new blind
// caller is the lost-update read-modify-write the versioned state exists to end.
// Thin I/O wrapper around lib/state-writer-lint.mjs. Exits 1 on any unlisted
// caller or any stale (migrated-away) allowlist entry.
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { listDirEntries, readTextFile } from '../lib/fs-safe.mjs';
import { findWriteTaskStateCallers, computeStateWriterViolations } from '../lib/state-writer-lint.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Directories whose `.mjs` may legitimately touch task.json. */
const SCAN_DIRS = ['lib', 'scripts', 'hooks'];
const ALLOWLIST_REL = 'docs/state-writer-allowlist.json';

/**
 * Recursively collect `*.mjs` files under a directory (absolute paths).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectMjs(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMjs(full)));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * CI entrypoint. Exits 0 when the allowlist exactly covers the observed direct
 * writeTaskState callers, 1 otherwise.
 * @param {string[]} _args  CLI args (unused).
 * @param {{ rootOverride?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;

  /** @type {Record<string, string>} */
  let allowed;
  try {
    const raw = JSON.parse(await readTextFile(resolve(root, ALLOWLIST_REL)));
    allowed = raw && typeof raw.allowed === 'object' && raw.allowed !== null ? raw.allowed : {};
  } catch (/** @type {any} */ err) {
    process.stderr.write(`[check-state-writers] FAIL — cannot read ${ALLOWLIST_REL}: ${err?.message ?? err}\n`);
    return 1;
  }

  /** @type {import('../lib/state-writer-lint.mjs').ScannedFile[]} */
  const files = [];
  for (const rel of SCAN_DIRS) {
    for (const abs of await collectMjs(resolve(root, rel))) {
      // Normalize to POSIX separators so the allowlist keys are cross-platform.
      const relPath = relative(root, abs).split(sep).join('/');
      files.push({ path: relPath, text: await readTextFile(abs) });
    }
  }

  const callers = findWriteTaskStateCallers(files);
  const { unlisted, stale } = computeStateWriterViolations(callers, allowed);

  if (unlisted.length === 0 && stale.length === 0) {
    process.stdout.write(
      `[check-state-writers] PASS — ${callers.length} direct writeTaskState caller(s), all justified in ${ALLOWLIST_REL}.\n`,
    );
    return 0;
  }

  if (unlisted.length > 0) {
    process.stderr.write(
      `[check-state-writers] FAIL — ${unlisted.length} unlisted direct writeTaskState caller(s). ` +
        `Route the write through mutateTaskStateUnderLock (lib/task-state.mjs), or add the path to ${ALLOWLIST_REL} with a justification:\n`,
    );
    for (const p of unlisted) process.stderr.write(`  - ${p}\n`);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `[check-state-writers] FAIL — ${stale.length} stale allowlist entry/entries (no longer call writeTaskState). Remove them from ${ALLOWLIST_REL}:\n`,
    );
    for (const p of stale) process.stderr.write(`  - ${p}\n`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
