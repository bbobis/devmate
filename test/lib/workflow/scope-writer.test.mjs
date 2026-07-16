// @ts-check
/**
 * #92 — the scope contract's serializer and its one writer.
 *
 * The format `lib/workflow/scope.mjs` parses is unforgiving: only `- ` bullets,
 * only `## ` headings. A writer that gets it subtly wrong does not fail loudly —
 * it produces a file that PARSES, to an empty contract, which Rule 6 then reads
 * as "deny every edit". So the round-trip (serialize → parse) is the thing under
 * test, not the string.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectTestGlobs,
  resolveWorkspacePaths,
  scopePathFor,
  serializeScope,
  writeScope,
} from '../../../lib/workflow/scope-writer.mjs';
import { parseScope, validateScope } from '../../../lib/workflow/scope.mjs';

/** @returns {string} */
const workspace = () => mkdtempSync(join(tmpdir(), 'devmate-scope-writer-'));

test('scope-writer › what it writes is what the guard parses (round-trip)', () => {
  const md = serializeScope({
    lane: 'feature',
    allowedPaths: ['lib/a.mjs', 'lib/b.mjs'],
    allowedGlobs: ['**/*.test.mjs'],
  });

  const parsed = parseScope(md);
  assert.equal(parsed.lane, 'feature');
  assert.deepEqual(parsed.allowedPaths, ['lib/a.mjs', 'lib/b.mjs']);
  assert.deepEqual(parsed.allowedGlobs, ['**/*.test.mjs']);
  assert.equal(validateScope(parsed).ok, true);
});

test('scope-writer › an EMPTY contract is refused, not written', async () => {
  // A scope.md with no paths and no globs parses fine and then denies every
  // single edit — the lane would enter implementation unable to touch anything,
  // which reads to a user as devmate being broken rather than as a scoping
  // failure. Writing nothing is honest: the dispatch gate then refuses for want
  // of a contract, and names the real cause.
  const root = workspace();
  try {
    const result = await writeScope(root, {
      taskId: 't1',
      lane: 'chore',
      allowedPaths: [],
      allowedGlobs: [],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.ok === false && result.reason), /empty scope/i);
    assert.throws(() => readFileSync(scopePathFor(root, 't1'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope-writer › blank and whitespace-only entries never reach the contract', async () => {
  const root = workspace();
  try {
    const result = await writeScope(root, {
      taskId: 't1',
      lane: 'bug',
      allowedPaths: ['  lib/a.mjs  ', '', '   '],
      allowedGlobs: [],
    });
    assert.equal(result.ok, true);

    const parsed = parseScope(readFileSync(scopePathFor(root, 't1'), 'utf8'));
    assert.deepEqual(parsed.allowedPaths, ['lib/a.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope-writer › the test-glob floor is unioned, never duplicated', () => {
  const globs = collectTestGlobs(
    /** @type {any} */ ({
      personas: [{ persona: 'backend', testGlobs: ['**/*.test.mjs', 'spec/**'] }],
      testGlobs: ['**/*.test.mjs'],
    }),
  );
  assert.equal(new Set(globs).size, globs.length, 'the floor must be deduped');
  assert.ok(globs.includes('spec/**'));
  assert.ok(globs.includes('**/*.test.mjs'));
});

test('scope-writer › multi-root prefixing is idempotent', () => {
  const config = /** @type {any} */ ({
    mode: 'multi-root',
    personas: [{ persona: 'editor', repo: 'api' }],
  });
  const once = resolveWorkspacePaths(['src/a.mjs'], config, 'editor');
  const twice = resolveWorkspacePaths(once, config, 'editor');
  assert.deepEqual(once, ['api/src/a.mjs']);
  assert.deepEqual(twice, ['api/src/a.mjs'], 'prefixing twice must not double the prefix');
});

test('scope-writer › single-root config is left alone', () => {
  const config = /** @type {any} */ ({ mode: 'single-root', personas: [] });
  assert.deepEqual(resolveWorkspacePaths(['src/a.mjs'], config, 'editor'), ['src/a.mjs']);
});
