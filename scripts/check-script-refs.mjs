// @ts-check
// CI lint: every bundled-script reference in agent- and skill-facing markdown
// must be anchored to `${PLUGIN_ROOT}/`. Thin I/O wrapper around
// lib/script-ref-lint.mjs. Exits 1 when any bare `scripts/<name>.mjs` remains.
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { listDirEntries, readTextFile } from '../lib/fs-safe.mjs';
import { findBareScriptRefs, formatScriptRefTable } from '../lib/script-ref-lint.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Directories whose markdown is agent/skill facing and must use the token. */
const SCAN_DIRS = ['agents', 'skills'];

/**
 * Recursively collect `*.md` files under a directory.
 * @param {string} dir  Absolute directory path.
 * @returns {Promise<string[]>}
 */
async function collectMarkdown(dir) {
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
      out.push(...(await collectMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * CI entrypoint. Exits 0 when every bundled-script reference is token-anchored,
 * 1 otherwise.
 * @param {string[]} _args  CLI args (unused).
 * @param {{ rootOverride?: string, scanDirs?: string[] }} [opts]  Test overrides.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;
  const dirs = opts.scanDirs ?? SCAN_DIRS;

  /** @type {import('../lib/script-ref-lint.mjs').ScriptRefViolation[]} */
  const violations = [];
  for (const rel of dirs) {
    const files = await collectMarkdown(resolve(root, rel));
    for (const file of files) {
      const text = await readTextFile(file);
      violations.push(...findBareScriptRefs(text, relative(root, file)));
    }
  }

  if (violations.length === 0) {
    process.stdout.write(
      '[check-script-refs] PASS — all bundled-script references use ${PLUGIN_ROOT}.\n'
    );
    return 0;
  }

  process.stderr.write(
    `[check-script-refs] FAIL — ${violations.length} bare bundled-script reference(s). ` +
      'A bare reference resolves against the consumer workspace cwd and fails at runtime; ' +
      'anchor each to the plugin-root placeholder (see the Fix column below).\n'
  );
  process.stderr.write(formatScriptRefTable(violations) + '\n');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
