// @ts-check
// B5: Tests for multi-root workspace scope path resolution.
//
// Covers:
//   resolveWorkspacePaths  (chore.mjs) — path prefixing in multi-root mode
//   enforceScope           (scope.mjs) — repoPrefix opt for workspace-relative matching
//   writeChoreScope        (chore.mjs) — scope.md written with workspace-relative paths

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveWorkspacePaths, writeChoreScope } from '../lib/workflow/lanes/chore.mjs';
import { enforceScope, parseScope } from '../lib/workflow/scope.mjs';

/** @typedef {import('../lib/types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal single-root DevmateConfig — no mode field, single editor persona
 * without a repo field.
 * @returns {DevmateConfig}
 */
function singleRootConfig() {
  return /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    personas: [{ persona: 'editor', editableGlobs: ['**'] }],
  });
}

/**
 * Minimal multi-root DevmateConfig with an editor persona that has repo: 'api'.
 * @param {string} [repo]
 * @returns {DevmateConfig}
 */
function multiRootConfig(repo = 'api') {
  return /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    mode: 'multi-root',
    personas: [{ persona: 'editor', repo, editableGlobs: [`${repo}/**`] }],
  });
}

/**
 * Minimal multi-root config where the editor persona has NO repo field.
 * @returns {DevmateConfig}
 */
function multiRootNoRepoConfig() {
  return /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    mode: 'multi-root',
    personas: [{ persona: 'editor', editableGlobs: ['**'] }],
  });
}

/** @returns {TaskState} */
function makeState() {
  return /** @type {TaskState} */ ({
    taskId: 'T-B5',
    lane: 'chore',
    workflowGate: 'plan-approved',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 5,
    tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
    schemaVersion: 1,
  });
}

// ---------------------------------------------------------------------------
// resolveWorkspacePaths — single-root (no-op)
// ---------------------------------------------------------------------------

test('resolveWorkspacePaths — single-root config returns input unchanged', () => {
  const files = ['src/index.ts', 'lib/util.ts'];
  const result = resolveWorkspacePaths(files, singleRootConfig());
  assert.deepEqual(result, files);
});

test('resolveWorkspacePaths — multi-root with no repo field returns input unchanged', () => {
  const files = ['src/index.ts'];
  const result = resolveWorkspacePaths(files, multiRootNoRepoConfig());
  assert.deepEqual(result, files);
});

test('resolveWorkspacePaths — multi-root with repo prefixes each path', () => {
  const files = ['src/index.ts', 'src/utils/db.ts'];
  const result = resolveWorkspacePaths(files, multiRootConfig('api'));
  assert.deepEqual(result, ['api/src/index.ts', 'api/src/utils/db.ts']);
});

test('resolveWorkspacePaths — already-prefixed paths are not double-prefixed', () => {
  // If a path already starts with the repo prefix, it must NOT be doubled.
  const files = ['api/src/already-prefixed.ts'];
  const result = resolveWorkspacePaths(files, multiRootConfig('api'));
  assert.deepEqual(result, ['api/src/already-prefixed.ts']);
});

test('resolveWorkspacePaths — repo field with trailing slash is handled', () => {
  // A trailing slash on the repo field (e.g. 'api/') must not produce 'api//src/…'.
  const config = /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    mode: 'multi-root',
    personas: [{ persona: 'editor', repo: 'api/', editableGlobs: ['api/**'] }],
  });
  const result = resolveWorkspacePaths(['src/main.ts'], config);
  assert.deepEqual(result, ['api/src/main.ts']);
});

test('resolveWorkspacePaths — Windows backslash paths are normalised before prefixing', () => {
  const files = ['src\\index.ts'];
  const result = resolveWorkspacePaths(files, multiRootConfig('api'));
  assert.deepEqual(result, ['api/src/index.ts']);
});

test('resolveWorkspacePaths — returns a new array (does not mutate input)', () => {
  const files = ['src/a.ts'];
  const result = resolveWorkspacePaths(files, singleRootConfig());
  result.push('injected');
  assert.equal(files.length, 1, 'original array must not be mutated');
});

test('resolveWorkspacePaths — empty files array returns empty array', () => {
  const result = resolveWorkspacePaths([], multiRootConfig('api'));
  assert.deepEqual(result, []);
});

test('resolveWorkspacePaths — non-editor persona repo field is ignored', () => {
  // Only the persona with persona === 'editor' should be used.
  const config = /** @type {DevmateConfig} */ ({
    schemaVersion: 1,
    mode: 'multi-root',
    personas: [
      { persona: 'backend', repo: 'backend', editableGlobs: ['backend/**'] },
      { persona: 'editor', editableGlobs: ['**'] }, // no repo
    ],
  });
  const result = resolveWorkspacePaths(['src/a.ts'], config);
  // editor has no repo field → no prefix
  assert.deepEqual(result, ['src/a.ts']);
});

// ---------------------------------------------------------------------------
// enforceScope — repoPrefix opt (B5 multi-root gate-guard matching)
// ---------------------------------------------------------------------------

test('enforceScope — no opts: workspace-relative path matches workspace-relative allowedPaths entry', () => {
  // B5 writes workspace-relative paths into scope.md; gate-guard passes
  // workspace-relative tool paths. Without opts this is a plain exact match.
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- api/src/index.ts\n\n## Allowed globs\n\n',
  );
  const result = enforceScope('api/src/index.ts', scope);
  assert.equal(result.allowed, true);
});

test('enforceScope — repoPrefix: workspace-relative path matches workspace-relative allowedPaths entry', () => {
  // New scope.md (post-B5): allowedPaths contains workspace-relative paths.
  // Gate-guard passes workspace-relative path with repoPrefix 'api/'.
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- api/src/index.ts\n\n## Allowed globs\n\n',
  );
  const result = enforceScope('api/src/index.ts', scope, { repoPrefix: 'api' });
  assert.equal(result.allowed, true);
});

test('enforceScope — repoPrefix: workspace-relative path matches legacy repo-relative allowedPaths entry', () => {
  // Legacy scope.md (pre-B5): allowedPaths contains repo-relative paths.
  // Gate-guard passes workspace-relative path; repoPrefix strips prefix for compat.
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- src/index.ts\n\n## Allowed globs\n\n',
  );
  const result = enforceScope('api/src/index.ts', scope, { repoPrefix: 'api' });
  assert.equal(result.allowed, true);
});

test('enforceScope — repoPrefix: path outside scope is still denied', () => {
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- api/src/index.ts\n\n## Allowed globs\n\n',
  );
  const result = enforceScope('api/src/other.ts', scope, { repoPrefix: 'api' });
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('out of scope per scope.md'));
});

test('enforceScope — repoPrefix with trailing slash is normalised', () => {
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- src/index.ts\n\n## Allowed globs\n\n',
  );
  // Passing 'api/' (with slash) must behave the same as 'api' (without).
  const result = enforceScope('api/src/index.ts', scope, { repoPrefix: 'api/' });
  assert.equal(result.allowed, true);
});

test('enforceScope — repoPrefix: workspace-relative path matches repo-relative glob (legacy)', () => {
  // Legacy scope.md with a glob (no workspace prefix).
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n\n## Allowed globs\n- src/**/*.ts\n',
  );
  const result = enforceScope('api/src/services/auth.ts', scope, { repoPrefix: 'api' });
  assert.equal(result.allowed, true);
});

test('enforceScope — no repoPrefix: single-root callers unaffected', () => {
  const scope = parseScope(
    '---\nlane: chore\n---\n# Scope\n\n## Allowed paths\n- src/index.ts\n\n## Allowed globs\n\n',
  );
  // Single-root: no opts, no prefix — exact match only.
  assert.equal(enforceScope('src/index.ts', scope).allowed, true);
  assert.equal(enforceScope('api/src/index.ts', scope).allowed, false);
});

// ---------------------------------------------------------------------------
// writeChoreScope — multi-root writes workspace-relative paths
// ---------------------------------------------------------------------------

test('writeChoreScope — single-root: scope.md contains repo-relative paths as-is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b5-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T-B5'), { recursive: true });
    const scopePath = await writeChoreScope(
      makeState(),
      'update changelog',
      ['CHANGELOG.md', 'package.json'],
      { repoRoot: root, config: singleRootConfig() },
    );
    const content = readFileSync(scopePath, 'utf8');
    assert.ok(content.includes('- CHANGELOG.md'), 'must contain repo-relative path');
    assert.ok(content.includes('- package.json'), 'must contain repo-relative path');
    assert.ok(!content.includes('api/'), 'must NOT have workspace prefix in single-root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeChoreScope — multi-root: scope.md contains workspace-relative paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b5-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T-B5'), { recursive: true });
    const scopePath = await writeChoreScope(
      makeState(),
      'refactor service layer',
      ['src/services/auth.ts', 'src/services/user.ts'],
      { repoRoot: root, config: multiRootConfig('api') },
    );
    const content = readFileSync(scopePath, 'utf8');
    assert.ok(content.includes('- api/src/services/auth.ts'), 'must have workspace-relative path');
    assert.ok(content.includes('- api/src/services/user.ts'), 'must have workspace-relative path');
    assert.ok(content.includes('lane: chore'), 'must declare chore lane');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeChoreScope — multi-root: already-prefixed paths are not double-prefixed in scope.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b5-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T-B5'), { recursive: true });
    const scopePath = await writeChoreScope(
      makeState(),
      'fix already prefixed',
      ['api/src/main.ts'], // already has the workspace prefix
      { repoRoot: root, config: multiRootConfig('api') },
    );
    const content = readFileSync(scopePath, 'utf8');
    // Must appear exactly once — no 'api/api/src/main.ts'
    assert.ok(content.includes('- api/src/main.ts'), 'path must appear once');
    assert.ok(!content.includes('api/api/'), 'must not double-prefix');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeChoreScope — no config opt: behaves as single-root (no prefix added)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b5-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T-B5'), { recursive: true });
    const scopePath = await writeChoreScope(
      makeState(),
      'minimal call',
      ['src/a.ts'],
      { repoRoot: root }, // no config
    );
    const content = readFileSync(scopePath, 'utf8');
    assert.ok(content.includes('- src/a.ts'));
    assert.ok(!content.includes('api/'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
