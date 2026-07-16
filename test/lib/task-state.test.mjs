// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateTaskState,
  readTaskState,
  writeTaskState,
  migrateTaskState,
  recordArtifactHash,
} from '../../lib/task-state.mjs';

/** @returns {import('../../lib/types.mjs').TaskState} */
function minimalState() {
  return {
    taskId: 'test-task',
    lane: 'feature',
    workflowGate: 'plan-approved',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

// ---------------------------------------------------------------------------
// validateTaskState
// ---------------------------------------------------------------------------

test('validateTaskState — valid minimal state → { ok: true }', () => {
  const result = validateTaskState(minimalState());
  assert.equal(result.ok, true);
});

test('validateTaskState — missing taskId → { ok: false } with error mentioning taskId', () => {
  const state = { ...minimalState(), taskId: '' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('taskId')));
});

test('validateTaskState — invalid lane value → error mentions the bad value', () => {
  const state = { ...minimalState(), lane: 'invalid-lane' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('invalid-lane')));
});

test('validateTaskState — invalid workflowGate value → error mentions the bad value', () => {
  const state = { ...minimalState(), workflowGate: 'bad-gate' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('bad-gate')));
});

test('validateTaskState — schemaVersion is 2 → error mentions schemaVersion', () => {
  const state = { ...minimalState(), schemaVersion: 2 };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('schemaVersion')));
});

test('validateTaskState — budget is negative → error mentions budget', () => {
  const state = { ...minimalState(), budget: -1 };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('budget')));
});

test('validateTaskState — artifactHashes contains a non-string value → error mentions artifactHashes', () => {
  const state = { ...minimalState(), artifactHashes: { 'file.mjs': 42 } };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('artifactHashes')));
});

// ---------------------------------------------------------------------------
// readTaskState
// ---------------------------------------------------------------------------

test('readTaskState — file not found → { ok: false } with path in message', () => {
  const result = readTaskState('/nonexistent/path/task.json');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.includes('/nonexistent/path/task.json')));
});

test('readTaskState — malformed JSON → { ok: false } and file on disk is unchanged', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const badContent = '{not valid json';
  writeFileSync(filePath, badContent, 'utf8');

  const result = readTaskState(filePath);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(e => e.toLowerCase().includes('malformed')));
  // file must not be overwritten
  assert.equal(readFileSync(filePath, 'utf8'), badContent);

  rmSync(dir, { recursive: true });
});

test('readTaskState — valid JSON file → { ok: true, state } with correct fields', () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const state = minimalState();
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');

  const result = readTaskState(filePath);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.state.taskId, 'test-task');
  assert.equal(result.state.schemaVersion, 1);

  rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// writeTaskState
// ---------------------------------------------------------------------------

test('writeTaskState — valid state → file exists and parses back identically', async () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const state = minimalState();

  await writeTaskState(state, filePath);

  assert.ok(existsSync(filePath));
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed, state);

  rmSync(dir, { recursive: true });
});

test('writeTaskState — invalid state → throws before writing; no file created', async () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const badState = /** @type {any} */ ({ ...minimalState(), taskId: '' });

  await assert.rejects(() => writeTaskState(badState, filePath));
  assert.ok(!existsSync(filePath));

  rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// migrateTaskState
// ---------------------------------------------------------------------------

test('migrateTaskState — v1 object → returned unchanged', () => {
  const state = minimalState();
  const result = migrateTaskState(state);
  assert.deepEqual(result, state);
});

test('migrateTaskState — object with missing schemaVersion → returns object with schemaVersion: 1 and all defaults', () => {
  const partial = { taskId: 'my-task', lane: 'bug' };
  const result = migrateTaskState(partial);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.taskId, 'my-task');
  assert.equal(result.lane, 'bug');
  assert.equal(result.workflowGate, 'plan-approved');
  assert.deepEqual(result.artifactHashes, {});
  assert.equal(result.preImplStash, null);
  assert.equal(result.currentStep, 0);
  assert.equal(typeof result.budget, 'number');
});

// ---------------------------------------------------------------------------
// recordArtifactHash
// ---------------------------------------------------------------------------

test('recordArtifactHash — writes artifact path and digest keys', async () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const state = minimalState();
  await writeTaskState(state, filePath);

  await recordArtifactHash('plan', 'abc123', '/tmp/plan.json', { statePath: filePath });

  const result = readTaskState(filePath);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.state.artifactHashes.plan, '/tmp/plan.json');
  assert.equal(result.state.artifactHashes.planDigest, 'abc123');

  rmSync(dir, { recursive: true });
});

test('recordArtifactHash — preserves existing artifactHashes entries', async () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');
  const state = {
    ...minimalState(),
    artifactHashes: {
      spec: '/tmp/spec.md',
      specDigest: 'deadbeef',
    },
  };
  await writeTaskState(state, filePath);

  await recordArtifactHash('design', 'feedface', '/tmp/design.json', { statePath: filePath });

  const result = readTaskState(filePath);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.state.artifactHashes.spec, '/tmp/spec.md');
  assert.equal(result.state.artifactHashes.specDigest, 'deadbeef');
  assert.equal(result.state.artifactHashes.design, '/tmp/design.json');
  assert.equal(result.state.artifactHashes.designDigest, 'feedface');

  rmSync(dir, { recursive: true });
});

test('recordArtifactHash — no-op when state file is missing', async () => {
  const dir = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'task.json');

  await recordArtifactHash('plan', 'abc123', '/tmp/plan.json', { statePath: filePath });

  assert.equal(existsSync(filePath), false);
  rmSync(dir, { recursive: true });
});

test('recordArtifactHash — rejects empty artifact name', async () => {
  await assert.rejects(
    () => recordArtifactHash('   ', 'abc123', '/tmp/plan.json'),
    (err) => {
      assert.equal(err instanceof TypeError, true);
      return true;
    },
  );
});

test('validateTaskState — accepts a valid acceptanceCriteria array', () => {
  const state = { ...minimalState(), acceptanceCriteria: ['first', 'second'] };
  const result = validateTaskState(state);
  assert.equal(result.ok, true);
});

test('validateTaskState — rejects non-string / empty acceptanceCriteria entries', () => {
  const bad = { ...minimalState(), acceptanceCriteria: ['ok', '   '] };
  const result = validateTaskState(bad);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.errors.some((e) => e.includes('acceptanceCriteria[1]')));

  const notArray = { ...minimalState(), acceptanceCriteria: 'nope' };
  const r2 = validateTaskState(notArray);
  assert.equal(r2.ok, false);
});

test('migrateTaskState — passes through a valid acceptanceCriteria list', () => {
  const migrated = migrateTaskState({ ...minimalState(), acceptanceCriteria: ['a', 'b'] });
  assert.deepEqual(migrated.acceptanceCriteria, ['a', 'b']);
});
