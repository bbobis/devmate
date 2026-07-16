// @ts-check
/**
 * Guard (#8): the test-only fault seam must be impossible to arm from production.
 *
 * The seam reads one env var (`lib/testing/fault-injection.mjs`), and the whole
 * safety argument is that NOTHING in the shipped tree sets it — only a test does,
 * through the harness. This test enforces that invariant structurally: the
 * literal fault-var name may appear in exactly one production file — the seam
 * module that DEFINES it (and only reads it) — and nowhere else under the
 * executable tree (`lib/`, `hooks/`, `scripts/`). If a future change references
 * or (worse) assigns it from production code, this fails.
 *
 * `test/` is excluded on purpose: tests are the one place allowed to arm it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The env var name, spelled here so this test does not import the seam it guards. */
const FAULT_VAR = 'DEVMATE_FAULT';

/** The single production file allowed to name the var (it defines + reads it). */
const SEAM_FILE = join('lib', 'testing', 'fault-injection.mjs');

/** Executable/production roots to scan. */
const PRODUCTION_ROOTS = ['lib', 'hooks', 'scripts'];

/**
 * Every `.mjs` file under `dir`, recursively, as repo-relative paths.
 * @param {string} dir
 * @returns {string[]}
 */
function mjsFilesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...mjsFilesUnder(rel));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(rel);
    }
  }
  return out;
}

test('no production file outside the seam even names the fault env var', () => {
  /** @type {string[]} */
  const offenders = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const rel of mjsFilesUnder(root)) {
      if (relative(SEAM_FILE, rel) === '') continue; // the seam itself is allowed
      // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- bounded by the repo's own committed source tree, not by any runtime/user input.
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (text.includes(FAULT_VAR)) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `production code must never reference ${FAULT_VAR}; found in: ${offenders.join(', ')}`,
  );
});

test('the seam module reads the fault var but never assigns it', () => {
  const text = readFileSync(join(REPO_ROOT, SEAM_FILE), 'utf8');
  assert.ok(text.includes(FAULT_VAR), 'the seam is expected to define the var name');
  // Any assignment form would arm the seam from within itself. None may exist.
  for (const line of text.split('\n')) {
    if (!line.includes(FAULT_VAR)) continue;
    assert.doesNotMatch(
      line,
      /process\.env\[[^\]]*\]\s*=|process\.env\.DEVMATE_FAULT\s*=/,
      `the seam must not assign the fault var: ${line.trim()}`,
    );
  }
});
