// @ts-check
// B8: Tests for multi-root persona-glob anchoring in ownsFile.
//
// ownsFile matches a persona's editableGlobs / offLimitsGlobs against the path
// the gate-guard receives. In multi-root workspaces that path is
// workspace-relative (e.g. 'payments/src/x.ts', per B5), but persona globs are
// authored relative to the sub-repo (e.g. 'src/**'). The fix strips the
// persona's own `repo` prefix and tests both forms — mirroring enforceScope's
// repoPrefix handling (scope.mjs) — so real personas anchor at the right tree
// while single-root behaviour is unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownsFile } from '../lib/gate-guard-core.mjs';

/** @typedef {import('../lib/types.mjs').DevmateConfig} DevmateConfig */

/**
 * Single-root config (no mode, persona has no repo field).
 * @param {string[]} editableGlobs
 * @param {string[]} [offLimitsGlobs]
 * @returns {DevmateConfig}
 */
function singleRoot(editableGlobs, offLimitsGlobs) {
  return /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    personas: [{ persona: 'editor', editableGlobs, offLimitsGlobs }],
  });
}

/**
 * Multi-root config with one persona scoped to `repo`.
 * @param {string} repo
 * @param {string[]} editableGlobs
 * @param {string[]} [offLimitsGlobs]
 * @returns {DevmateConfig}
 */
function multiRoot(repo, editableGlobs, offLimitsGlobs) {
  return /** @type {DevmateConfig} */ ({
    schemaVersion: 2,
    mode: 'multi-root',
    personas: [{ persona: 'dev', repo, editableGlobs, offLimitsGlobs }],
  });
}

// ---------------------------------------------------------------------------
// Single-root — must be byte-for-byte unchanged (no repo → no prefix stripping)
// ---------------------------------------------------------------------------

test('ownsFile — single-root: repo-relative glob matches repo-relative path', () => {
  const config = singleRoot(['src/**']);
  assert.equal(ownsFile('editor', 'src/x.ts', config), true);
});

test('ownsFile — single-root: path outside editable globs is not owned', () => {
  const config = singleRoot(['src/**']);
  assert.equal(ownsFile('editor', 'other/x.ts', config), false);
});

test('ownsFile — single-root: offLimits still denies', () => {
  const config = singleRoot(['src/**'], ['src/secret/**']);
  assert.equal(ownsFile('editor', 'src/app.ts', config), true);
  assert.equal(ownsFile('editor', 'src/secret/keys.ts', config), false);
});

// ---------------------------------------------------------------------------
// Multi-root — the fix: repo-relative globs match workspace-relative paths
// ---------------------------------------------------------------------------

test('ownsFile — multi-root: repo-relative glob matches workspace-relative path (THE FIX)', () => {
  const config = multiRoot('payments', ['src/**']);
  assert.equal(ownsFile('dev', 'payments/src/x.ts', config), true);
});

test('ownsFile — multi-root: path inside the repo but outside the glob is not owned', () => {
  const config = multiRoot('payments', ['src/**']);
  assert.equal(ownsFile('dev', 'payments/docs/x.md', config), false);
});

test('ownsFile — multi-root: workspace-relative glob (raw form) still matches', () => {
  const config = multiRoot('payments', ['payments/src/**']);
  assert.equal(ownsFile('dev', 'payments/src/x.ts', config), true);
});

test('ownsFile — multi-root: cross-repo isolation — a payments persona does not own a ui path', () => {
  // repoPrefix 'payments/' does not match 'ui/src/x.ts', so repoRelative is null
  // and the repo-relative glob 'src/**' is only tested against the raw path,
  // which does not match. The guardrail stays inside the persona's own repo.
  const config = multiRoot('payments', ['src/**']);
  assert.equal(ownsFile('dev', 'ui/src/x.ts', config), false);
});

test('ownsFile — multi-root: offLimits repo-relative glob denies (dual-form)', () => {
  const config = multiRoot('payments', ['src/**'], ['src/secret/**']);
  assert.equal(ownsFile('dev', 'payments/src/app.ts', config), true);
  assert.equal(ownsFile('dev', 'payments/src/secret/keys.ts', config), false);
});

test('ownsFile — multi-root: offLimits workspace-relative glob denies (raw form)', () => {
  const config = multiRoot('payments', ['src/**'], ['payments/src/secret/**']);
  assert.equal(ownsFile('dev', 'payments/src/secret/keys.ts', config), false);
});

// ---------------------------------------------------------------------------
// Fallback persona shape — repo-scoped workspace-relative globs
// ---------------------------------------------------------------------------

test('ownsFile — fallback persona (repo/** editable) owns its own repo but not siblings', () => {
  const config = multiRoot('payments', ['payments/**'], [
    'payments/**/.env',
    'payments/**/secrets/**',
  ]);
  assert.equal(ownsFile('dev', 'payments/anything/deep.ts', config), true);
  assert.equal(ownsFile('dev', 'ui/anything.ts', config), false);
  assert.equal(ownsFile('dev', 'payments/config/.env', config), false);
  assert.equal(ownsFile('dev', 'payments/app/secrets/token.txt', config), false);
});

// ---------------------------------------------------------------------------
// Normalisation — trailing-slash repo, Windows backslash paths
// ---------------------------------------------------------------------------

test('ownsFile — multi-root: repo field with trailing slash is normalised', () => {
  const config = multiRoot('payments/', ['src/**']);
  assert.equal(ownsFile('dev', 'payments/src/x.ts', config), true);
});

test('ownsFile — multi-root: Windows backslash path is normalised before anchoring', () => {
  const config = multiRoot('payments', ['src/**']);
  assert.equal(ownsFile('dev', 'payments\\src\\x.ts', config), true);
});

test('ownsFile — unknown persona is never an owner', () => {
  const config = multiRoot('payments', ['src/**']);
  assert.equal(ownsFile('nobody', 'payments/src/x.ts', config), false);
});
