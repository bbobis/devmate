// @ts-check
// P06: Unit, integration, and regression tests for the unified scope.md
// enforcement across all three workflow lanes (bug, chore, feature).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseScope, validateScope, enforceScope, readScopeForTask } from '../lib/workflow/scope.mjs';
import { evaluateGuard } from '../lib/gate-guard-core.mjs';

/** @typedef {import('../lib/types.mjs').ParsedScope} ParsedScope */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Full canonical scope.md for a given lane.
 * @param {'bug'|'chore'|'feature'} lane
 * @param {string[]} paths
 * @param {string[]} globs
 * @returns {string}
 */
function makeScopeContent(lane, paths = [], globs = []) {
  const pathLines = paths.map((p) => `- ${p}`).join('\n');
  const globLines = globs.map((g) => `- ${g}`).join('\n');
  return [
    '---',
    `lane: ${lane}`,
    '---',
    '# Scope',
    '',
    '## Allowed paths',
    pathLines,
    '',
    '## Allowed globs',
    globLines,
    '',
  ].join('\n');
}

/**
 * @param {import('../lib/types.mjs').WorkflowGate} gate
 * @param {'bug'|'chore'|'feature'} [lane]
 * @returns {TaskState}
 */
function stateAt(gate, lane = 'bug') {
  return {
    taskId: 'T1',
    lane,
    workflowGate: gate,
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    tddGuard: {
      testFileWritten: true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    schemaVersion: 1,
  };
}

/** @returns {import('../lib/types.mjs').ConfigResult} */
function validConfigResult() {
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      personas: [
        { persona: 'backend', editableGlobs: ['backend/**', 'lib/**'] },
        { persona: 'frontend', editableGlobs: ['frontend/**'] },
      ],
    },
  };
}

/**
 * @param {string} path
 * @returns {import('../lib/types.mjs').HookPayload}
 */
function editPayload(path) {
  return /** @type {import('../lib/types.mjs').HookPayload} */ ({
    tool_name: 'write_file',
    path,
  });
}

// ---------------------------------------------------------------------------
// Unit: parseScope
// ---------------------------------------------------------------------------

test('parseScope — full schema parses lane, paths, and globs', () => {
  const content = makeScopeContent('bug', ['src/foo.mjs'], ['src/**/*.mjs']);
  const parsed = parseScope(content);
  assert.equal(parsed.lane, 'bug');
  assert.deepEqual(parsed.allowedPaths, ['src/foo.mjs']);
  assert.deepEqual(parsed.allowedGlobs, ['src/**/*.mjs']);
});

test('parseScope — lane: chore', () => {
  const parsed = parseScope(makeScopeContent('chore', ['CHANGELOG.md', 'package.json']));
  assert.equal(parsed.lane, 'chore');
  assert.deepEqual(parsed.allowedPaths, ['CHANGELOG.md', 'package.json']);
  assert.deepEqual(parsed.allowedGlobs, []);
});

test('parseScope — lane: feature', () => {
  const parsed = parseScope(makeScopeContent('feature', [], ['src/**']));
  assert.equal(parsed.lane, 'feature');
  assert.deepEqual(parsed.allowedPaths, []);
  assert.deepEqual(parsed.allowedGlobs, ['src/**']);
});

test('parseScope — missing ## Allowed globs section yields empty array', () => {
  const content = '---\nlane: bug\n---\n# Scope\n\n## Allowed paths\n- lib/a.mjs\n';
  const parsed = parseScope(content);
  assert.deepEqual(parsed.allowedGlobs, []);
  assert.deepEqual(parsed.allowedPaths, ['lib/a.mjs']);
});

test('parseScope — missing ## Allowed paths section yields empty array', () => {
  const content = '---\nlane: chore\n---\n# Scope\n\n## Allowed globs\n- docs/**\n';
  const parsed = parseScope(content);
  assert.deepEqual(parsed.allowedPaths, []);
  assert.deepEqual(parsed.allowedGlobs, ['docs/**']);
});

test('parseScope — bad frontmatter (no lane key) yields empty lane', () => {
  const content = '---\nschema: 1\n---\n# Scope\n\n## Allowed paths\n- a.mjs\n';
  const parsed = parseScope(content);
  assert.equal(parsed.lane, '');
});

test('parseScope — no frontmatter at all yields empty lane', () => {
  const content = '# Scope\n\n## Allowed paths\n- a.mjs\n';
  const parsed = parseScope(content);
  assert.equal(parsed.lane, '');
});

test('parseScope — empty content yields empty contract', () => {
  const parsed = parseScope('');
  assert.equal(parsed.lane, '');
  assert.deepEqual(parsed.allowedPaths, []);
  assert.deepEqual(parsed.allowedGlobs, []);
});

test('parseScope — Windows CRLF line endings are normalised', () => {
  const content = '---\r\nlane: bug\r\n---\r\n# Scope\r\n\r\n## Allowed paths\r\n- lib/a.mjs\r\n';
  const parsed = parseScope(content);
  assert.equal(parsed.lane, 'bug');
  assert.deepEqual(parsed.allowedPaths, ['lib/a.mjs']);
});

test('parseScope — multiple paths and globs are all captured', () => {
  const content = makeScopeContent(
    'feature',
    ['src/a.mjs', 'src/b.mjs'],
    ['src/**/*.mjs', 'test/**'],
  );
  const parsed = parseScope(content);
  assert.deepEqual(parsed.allowedPaths, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(parsed.allowedGlobs, ['src/**/*.mjs', 'test/**']);
});

// ---------------------------------------------------------------------------
// Unit: validateScope
// ---------------------------------------------------------------------------

test('validateScope — valid bug scope passes', () => {
  const result = validateScope({ lane: 'bug', allowedPaths: ['lib/a.mjs'], allowedGlobs: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateScope — valid chore scope passes', () => {
  const result = validateScope({ lane: 'chore', allowedPaths: ['CHANGELOG.md'], allowedGlobs: [] });
  assert.equal(result.ok, true);
});

test('validateScope — valid feature scope (globs only) passes', () => {
  const result = validateScope({ lane: 'feature', allowedPaths: [], allowedGlobs: ['src/**'] });
  assert.equal(result.ok, true);
});

test('validateScope — invalid lane fails', () => {
  const result = validateScope({
    lane: /** @type {'bug'} */ ('badlane'),
    allowedPaths: ['a.mjs'],
    allowedGlobs: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('lane')));
});

test('validateScope — empty lane fails', () => {
  const result = validateScope({ lane: /** @type {'bug'} */ (''), allowedPaths: ['a.mjs'], allowedGlobs: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('lane')));
});

test('validateScope — both arrays empty fails', () => {
  const result = validateScope({ lane: 'bug', allowedPaths: [], allowedGlobs: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('nothing is permitted')));
});

test('validateScope — valid scope with both paths and globs passes', () => {
  const result = validateScope({
    lane: 'feature',
    allowedPaths: ['src/a.mjs'],
    allowedGlobs: ['src/**'],
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Unit: enforceScope
// ---------------------------------------------------------------------------

test('enforceScope — exact literal path match allows', () => {
  const scope = parseScope(makeScopeContent('bug', ['lib/a.mjs'], []));
  const result = enforceScope('lib/a.mjs', scope);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, undefined);
});

test('enforceScope — non-matching path denies', () => {
  const scope = parseScope(makeScopeContent('bug', ['lib/a.mjs'], []));
  const result = enforceScope('lib/b.mjs', scope);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('out of scope per scope.md'));
  assert.ok(result.reason?.includes('lane: bug'));
  assert.ok(result.reason?.includes('lib/b.mjs'));
});

test('enforceScope — glob match allows', () => {
  const scope = parseScope(makeScopeContent('chore', [], ['docs/**/*.md']));
  const result = enforceScope('docs/api/README.md', scope);
  assert.equal(result.allowed, true);
});

test('enforceScope — non-matching glob denies', () => {
  const scope = parseScope(makeScopeContent('chore', [], ['docs/**']));
  const result = enforceScope('src/main.mjs', scope);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('lane: chore'));
});

test('enforceScope — Windows backslash path is normalised to match', () => {
  const scope = parseScope(makeScopeContent('bug', ['lib/a.mjs'], []));
  // Windows callers may pass backslash paths.
  const result = enforceScope('lib\\a.mjs', scope);
  assert.equal(result.allowed, true);
});

test('enforceScope — Windows backslash in allowedPaths entry is normalised', () => {
  // Paths written on Windows may have backslashes; enforceScope normalises both.
  const scope = {
    lane: /** @type {'bug'} */ ('bug'),
    allowedPaths: ['lib\\a.mjs'],
    allowedGlobs: [],
  };
  const result = enforceScope('lib/a.mjs', scope);
  assert.equal(result.allowed, true);
});

test('enforceScope — deny reason contains expected prefix format', () => {
  const scope = parseScope(makeScopeContent('feature', ['src/a.mjs'], []));
  const result = enforceScope('src/b.mjs', scope);
  assert.ok(result.reason?.startsWith('out of scope per scope.md (lane: feature):'));
});

// ---------------------------------------------------------------------------
// Unit: readScopeForTask
// ---------------------------------------------------------------------------

test('readScopeForTask — returns null when file is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-test-'));
  try {
    const result = await readScopeForTask('no-such-task', { repoRoot: root });
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readScopeForTask — returns null when file is empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T1'), { recursive: true });
    writeFileSync(resolve(root, '.devmate', 'session', 'T1', 'scope.md'), '   ', 'utf8');
    const result = await readScopeForTask('T1', { repoRoot: root });
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readScopeForTask — returns ParsedScope when file is present and valid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-test-'));
  try {
    mkdirSync(resolve(root, '.devmate', 'session', 'T1'), { recursive: true });
    writeFileSync(
      resolve(root, '.devmate', 'session', 'T1', 'scope.md'),
      makeScopeContent('chore', ['CHANGELOG.md'], []),
      'utf8',
    );
    const result = await readScopeForTask('T1', { repoRoot: root });
    assert.ok(result !== null);
    assert.equal(result.lane, 'chore');
    assert.deepEqual(result.allowedPaths, ['CHANGELOG.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: evaluateGuard + scope enforcement across lanes
//
// For each of the three lanes, build a ParsedScope with one allowed path and
// verify that (a) an in-scope edit is allowed, and (b) an out-of-scope edit
// is denied with the lane-specific reason. The deny-reason format must be
// byte-identical across lanes (uniformity guarantee).
// ---------------------------------------------------------------------------

/** @param {'bug'|'chore'|'feature'} lane */
function scopeForLane(lane) {
  return parseScope(makeScopeContent(lane, [`${lane}/allowed.mjs`], []));
}

for (const lane of /** @type {Array<'bug'|'chore'|'feature'>} */ (['bug', 'chore', 'feature'])) {
  test(`evaluateGuard + scope — ${lane} lane: in-scope write is allowed`, () => {
    const scope = scopeForLane(lane);
    const result = evaluateGuard(
      editPayload(`${lane}/allowed.mjs`),
      stateAt('impl-started', lane),
      validConfigResult(),
      { scope },
    );
    assert.equal(result.decision, 'allow', `expected allow for ${lane}/allowed.mjs`);
  });

  test(`evaluateGuard + scope — ${lane} lane: out-of-scope write is denied`, () => {
    const scope = scopeForLane(lane);
    const result = evaluateGuard(
      editPayload('outside/other.mjs'),
      stateAt('impl-started', lane),
      validConfigResult(),
      { scope },
    );
    assert.equal(result.decision, 'deny', `expected deny for outside/other.mjs in ${lane} lane`);
    assert.ok(
      result.reason?.includes(`lane: ${lane}`),
      `reason should include "lane: ${lane}" — got: ${result.reason}`,
    );
    assert.ok(
      result.reason?.includes('outside/other.mjs'),
      `reason should include the file path — got: ${result.reason}`,
    );
  });
}

test('evaluateGuard + scope — deny reason format is identical across lanes', () => {
  // Extract the prefix before the file path; it must be the same across lanes.
  const reasons = /** @type {string[]} */ ([]);
  for (const lane of /** @type {Array<'bug'|'chore'|'feature'>} */ (['bug', 'chore', 'feature'])) {
    const result = evaluateGuard(
      editPayload('other/file.mjs'),
      stateAt('impl-started', lane),
      validConfigResult(),
      { scope: scopeForLane(lane) },
    );
    assert.equal(result.decision, 'deny');
    reasons.push(/** @type {string} */ (result.reason));
  }
  // All reasons should start with the same prefix and include "out of scope per scope.md".
  for (const reason of reasons) {
    assert.ok(
      reason.includes('out of scope per scope.md'),
      `reason missing canonical phrase: ${reason}`,
    );
    assert.ok(
      reason.includes('other/file.mjs'),
      `reason missing the file path: ${reason}`,
    );
  }
});

test('evaluateGuard + scope — an ABSENT scope contract now DENIES at impl-started', () => {
  // This asserted `allow`, and named itself "absent scope (undefined) is a no-op
  // (allows)". It was the fail-open, written down and made green (#92): a
  // missing scope.md meant every edit was permitted, while an EMPTY scope.md
  // (both arrays present but empty) denied every edit. The polarity was exactly
  // backwards, and since no lane could write a scope.md at all, the permissive
  // branch was the only one that ever ran — so `@fullstack` at impl-started
  // could touch any path in the repository.
  const result = evaluateGuard(
    editPayload('anything/file.mjs'),
    stateAt('impl-started', 'bug'),
    validConfigResult(),
    // no scope field
  );
  assert.equal(result.decision, 'deny');
  assert.match(String(result.reason), /no scope contract/i);
});

test('evaluateGuard + scope — an absent contract is a no-op BEFORE impl-started', () => {
  // The fail-closed rule is scoped to implementation. Pre-impl gates have their
  // own denial (Rule 3), and a task legitimately has no scope contract yet while
  // it is still being planned — demanding one there would refuse the very
  // artifacts (spec.md, plan.json) that produce the scope.
  const result = evaluateGuard(
    editPayload('.devmate/session/spec.md'),
    stateAt('plan-done', 'feature'),
    validConfigResult(),
  );
  assert.notEqual(result.reason, undefined);
  assert.doesNotMatch(String(result.reason ?? ''), /no scope contract/i);
});

test('evaluateGuard + scope — glob in scope allows matching path', () => {
  const scope = parseScope(makeScopeContent('feature', [], ['src/**/*.mjs']));
  const result = evaluateGuard(
    editPayload('src/services/Foo.mjs'),
    stateAt('impl-started', 'feature'),
    validConfigResult(),
    { scope },
  );
  assert.equal(result.decision, 'allow');
});

// ---------------------------------------------------------------------------
// Regression: enforceBugScope has been removed from bug-handoff
// ---------------------------------------------------------------------------

test('regression — enforceBugScope is no longer exported from bug-handoff', async () => {
  const bugHandoff = await import('../lib/workflow/bug-handoff.mjs');
  assert.equal(
    'enforceBugScope' in bugHandoff,
    false,
    'enforceBugScope must not be exported from lib/workflow/bug-handoff.mjs',
  );
});
