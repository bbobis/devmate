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
  isStateFileMissing,
  isStateCorrupt,
  STATE_FILE_NOT_FOUND_PREFIX,
  commitRenameWithRetry,
  mutateTaskStateUnderLock,
  mutateTaskStateWithRetry,
  stateVersionOf,
} from '../../lib/task-state.mjs';
import { transitionLogPath } from '../../lib/state-transition-log.mjs';
import { TRANSITIONS } from '../../lib/gate-transitions.mjs';

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

// ---------------------------------------------------------------------------
// validateTaskState — #129 (lane, workflowGate) cross-validation
// ---------------------------------------------------------------------------

test('validateTaskState — bug lane + discovery-done → rejected, error names both fields', () => {
  const state = { ...minimalState(), lane: 'bug', workflowGate: 'discovery-done' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok &&
      result.errors.some(
        (e) => e.includes('discovery-done') && e.includes('bug') && e.includes('hand-edited'),
      ),
  );
});

test('validateTaskState — chore lane + discovery-done → rejected, error names both fields', () => {
  const state = { ...minimalState(), lane: 'chore', workflowGate: 'discovery-done' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok &&
      result.errors.some((e) => e.includes('discovery-done') && e.includes('chore')),
  );
});

test('validateTaskState — chore lane + spec-draft → rejected (chore has no spec gates)', () => {
  const state = { ...minimalState(), lane: 'chore', workflowGate: 'spec-draft' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.errors.some((e) => e.includes('spec-draft') && e.includes('chore')),
  );
});

test('validateTaskState — feature lane + spec-invalidated → rejected (no runtime writer sets it)', () => {
  const state = { ...minimalState(), workflowGate: 'spec-invalidated' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok &&
      result.errors.some((e) => e.includes('spec-invalidated') && e.includes('feature')),
  );
});

test('validateTaskState — invalid gate enum gets ONE error, not a compounded pair message', () => {
  const state = { ...minimalState(), lane: 'bug', workflowGate: 'bad-gate' };
  const result = validateTaskState(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.length === 1);
  assert.ok(!result.ok && result.errors[0].includes('workflowGate must be one of'));
});

test('validateTaskState — every (lane, gate) pair present in TRANSITIONS[lane] validates ok', () => {
  // Property loop over the canonical table: every gate a lane's own table
  // mentions — as a row (has exits) or as a target (entered by an event) —
  // must remain a valid resting value for that lane.
  for (const [lane, laneTable] of Object.entries(TRANSITIONS)) {
    // @bounded-alloc — one Set per lane over the frozen three-lane table.
    /** @type {Set<string>} */
    const gates = new Set();
    for (const [gate, gateTable] of Object.entries(laneTable)) {
      gates.add(gate);
      for (const target of Object.values(gateTable)) gates.add(target);
    }
    for (const gate of gates) {
      const state = {
        ...minimalState(),
        lane: /** @type {import('../../lib/types.mjs').Lane} */ (lane),
        workflowGate: /** @type {import('../../lib/types.mjs').WorkflowGate} */ (gate),
      };
      const result = validateTaskState(state);
      assert.equal(result.ok, true, `expected (${lane}, ${gate}) to validate ok`);
    }
  }
});

test('validateTaskState — lane-agnostic gates stay valid for every lane', () => {
  for (const lane of /** @type {const} */ (['feature', 'bug', 'chore'])) {
    for (const gate of /** @type {const} */ (['no-lane', 'done', 'parked', 'abandoned'])) {
      const state = { ...minimalState(), lane, workflowGate: gate };
      const result = validateTaskState(state);
      assert.equal(result.ok, true, `expected (${lane}, ${gate}) to validate ok`);
    }
  }
});

// ── #171: isStateFileMissing distinguishes "no task yet" from "corrupt state" ──

test('isStateFileMissing is true only for an absent state file', () => {
  const missing = readTaskState(join(tmpdir(), 'devmate-nonexistent', 'task.json'));
  assert.equal(missing.ok, false);
  assert.equal(isStateFileMissing(missing), true, 'a not-found read is "missing"');
  // The predicate is keyed off the exact producer prefix — they cannot drift.
  assert.ok((missing.errors[0] ?? '').startsWith(STATE_FILE_NOT_FOUND_PREFIX));
});

test('isStateFileMissing is false for a present-but-corrupt state (the #129 case)', () => {
  const dir = join(tmpdir(), `devmate-corrupt-${process.pid}-${process.hrtime.bigint()}`);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'task.json');
  try {
    // A valid enum lane + gate whose PAIR is illegal — the #129 corruption.
    writeFileSync(
      statePath,
      JSON.stringify({ ...minimalState(), lane: 'bug', workflowGate: 'discovery-done' }),
      'utf8',
    );
    const corrupt = readTaskState(statePath);
    assert.equal(corrupt.ok, false);
    assert.equal(isStateFileMissing(corrupt), false, 'a corrupt state is NOT "missing"');
    assert.ok(
      corrupt.errors.some((e) => /has no transitions defined for lane "bug"/.test(e)),
      'the #129 diagnostic is present to be surfaced',
    );

    // Malformed JSON is corruption too, not "missing".
    writeFileSync(statePath, 'not json {{{', 'utf8');
    const malformed = readTaskState(statePath);
    assert.equal(malformed.ok, false);
    assert.equal(isStateFileMissing(malformed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTaskState reserves the not-found prefix for ENOENT — a present-but-unreadable file is "unreadable", not "missing"', () => {
  const dir = join(tmpdir(), `devmate-unreadable-${process.pid}-${process.hrtime.bigint()}`);
  // A DIRECTORY where task.json should be: the file "exists" but readFileSync
  // throws EISDIR (not ENOENT) cross-platform — the present-but-unreadable case.
  const statePath = join(dir, 'task.json');
  mkdirSync(statePath, { recursive: true });
  try {
    const result = readTaskState(statePath);
    assert.equal(result.ok, false);
    // NOT classified as missing → the #171 anchors surface it instead of silence,
    // and the fail-closed consumers (dispatch/budget guard) don't wave it through.
    assert.equal(isStateFileMissing(result), false, 'a non-ENOENT read error is not "missing"');
    assert.ok(!result.ok && result.errors[0].startsWith('State file unreadable:'), result.ok ? '' : result.errors[0]);
    // A truly-absent path, by contrast, IS missing.
    const absent = readTaskState(join(dir, 'nope', 'task.json'));
    assert.equal(absent.ok, false);
    assert.equal(isStateFileMissing(absent), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#191 isStateCorrupt — true for malformed/shape-invalid, false for missing or unreadable', () => {
  const dir = join(tmpdir(), `devmate-corrupt-pred-${process.pid}-${process.hrtime.bigint()}`);
  const statePath = join(dir, 'task.json');
  mkdirSync(dir, { recursive: true });
  // Read + classify: isStateCorrupt takes a failed result, so guard on !ok first
  // (narrows the union away from the ok branch for the typechecker).
  const corruptOf = (/** @type {string} */ p) => {
    const r = readTaskState(p);
    return !r.ok && isStateCorrupt(r);
  };
  try {
    writeFileSync(statePath, 'not json {{{', 'utf8');
    assert.equal(corruptOf(statePath), true, 'malformed JSON is corrupt');

    writeFileSync(statePath, JSON.stringify({ ...minimalState(), lane: 'bug', workflowGate: 'discovery-done' }), 'utf8');
    assert.equal(corruptOf(statePath), true, 'shape-invalid is corrupt');

    assert.equal(corruptOf(join(dir, 'nope', 'task.json')), false, 'missing is not corrupt');

    const unreadable = join(dir, 'unreadable-task.json');
    mkdirSync(unreadable, { recursive: true });
    assert.equal(corruptOf(unreadable), false, 'unreadable is not corrupt (might be live)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #174: commitRenameWithRetry absorbs transient Windows sharing-violations ──

/**
 * A fake rename that throws `code` for the first `failTimes` calls, then succeeds.
 * @param {number} failTimes
 * @param {string} code
 * @returns {{ rename: (f: string, t: string) => void, calls: () => number }}
 */
function flakyRename(failTimes, code) {
  let calls = 0;
  return {
    rename: () => {
      calls += 1;
      if (calls <= failTimes) {
        const err = /** @type {NodeJS.ErrnoException} */ (new Error(`${code}: simulated`));
        err.code = code;
        throw err;
      }
    },
    calls: () => calls,
  };
}

test('#174 commitRenameWithRetry — succeeds on the first try, never sleeps', async () => {
  const r = flakyRename(0, 'EPERM');
  let slept = 0;
  await commitRenameWithRetry('a', 'b', { rename: r.rename, sleep: async () => { slept += 1; } });
  assert.equal(r.calls(), 1, 'renamed exactly once');
  assert.equal(slept, 0, 'no sleep when the first rename succeeds');
});

test('#174 commitRenameWithRetry — retries a transient EPERM then succeeds', async () => {
  const r = flakyRename(2, 'EPERM'); // fail twice, succeed on the 3rd
  let slept = 0;
  await commitRenameWithRetry('a', 'b', {
    attempts: 5,
    rename: r.rename,
    sleep: async () => { slept += 1; },
  });
  assert.equal(r.calls(), 3, 'renamed three times (two failures + one success)');
  assert.equal(slept, 2, 'slept once between each failed attempt');
});

test('#174 commitRenameWithRetry — EACCES and EBUSY are also treated as transient', async () => {
  for (const code of ['EACCES', 'EBUSY']) {
    const r = flakyRename(1, code);
    await commitRenameWithRetry('a', 'b', { rename: r.rename, sleep: async () => {} });
    assert.equal(r.calls(), 2, `${code} retried once then succeeded`);
  }
});

test('#174 commitRenameWithRetry — a non-transient error rethrows immediately, no retry', async () => {
  const r = flakyRename(99, 'ENOSPC'); // never succeeds; not a transient code
  let slept = 0;
  await assert.rejects(
    () => commitRenameWithRetry('a', 'b', { rename: r.rename, sleep: async () => { slept += 1; } }),
    /ENOSPC/,
  );
  assert.equal(r.calls(), 1, 'a non-transient error is not retried');
  assert.equal(slept, 0, 'no sleep on a non-transient error');
});

test('#174 commitRenameWithRetry — a bad attempts value never becomes a silent no-op', async () => {
  // attempts: 0 / NaN / negative must NOT skip the rename and quietly "succeed".
  for (const bad of [0, -1, Number.NaN, /** @type {any} */ (undefined)]) {
    const r = flakyRename(0, 'EPERM'); // succeeds on the first real call
    await commitRenameWithRetry('a', 'b', { attempts: bad, rename: r.rename, sleep: async () => {} });
    assert.equal(r.calls(), 1, `attempts=${String(bad)} still renamed at least once`);
  }
});

test('#174 commitRenameWithRetry — rethrows the transient error after the attempt bound is spent', async () => {
  const r = flakyRename(99, 'EPERM'); // always EPERM
  let slept = 0;
  await assert.rejects(
    () => commitRenameWithRetry('a', 'b', { attempts: 3, rename: r.rename, sleep: async () => { slept += 1; } }),
    /EPERM/,
  );
  assert.equal(r.calls(), 3, 'tried exactly `attempts` times');
  assert.equal(slept, 2, 'slept between attempts but not after the last');
});

// ── #175: mutateTaskStateUnderLock — serialized read-modify-write ─────────────

/**
 * Seed a valid task.json in a fresh temp dir and return its path + a cleanup.
 * @param {Partial<import('../../lib/types.mjs').TaskState>} [patch]
 * @returns {{ path: string, cleanup: () => void }}
 */
function seedStateFile(patch = {}) {
  const dir = join(tmpdir(), `devmate-mutate-${process.pid}-${process.hrtime.bigint()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task.json');
  writeFileSync(path, JSON.stringify({ ...minimalState(), ...patch }), 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('#175 mutateTaskStateUnderLock — applies the mutation and reports written', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    const res = await mutateTaskStateUnderLock((s) => ({ ...s, activeDomains: ['billing'] }), path);
    // #112: a committed write reports the bumped version (fresh 0 → 1).
    assert.deepEqual(res, { ok: true, written: true, version: 1 });
    const after = readTaskState(path);
    assert.ok(after.ok && after.state.activeDomains?.[0] === 'billing');
  } finally {
    cleanup();
  }
});

test('#175 mutateTaskStateUnderLock — a null mutator result skips the write (no churn)', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    const before = readFileSync(path, 'utf8');
    const res = await mutateTaskStateUnderLock(() => null, path);
    // #112: a skipped write reports the unchanged on-disk version (fresh 0).
    assert.deepEqual(res, { ok: true, written: false, version: 0 });
    assert.equal(readFileSync(path, 'utf8'), before, 'the file is untouched when the mutator returns null');
  } finally {
    cleanup();
  }
});

test('#175 mutateTaskStateUnderLock — a missing/corrupt state is a non-throwing failure, no write', async () => {
  // Unique dir + cleanup (mutateTaskStateUnderLock ensureDirSyncs the parent, so a
  // fixed path would leave temp churn and risk cross-run interference).
  const { path: missingPath, cleanup: cleanupMissing } = seedStateFile();
  rmSync(missingPath, { force: true }); // remove the seeded file → a genuinely-absent path
  try {
    const missing = await mutateTaskStateUnderLock((s) => s, missingPath);
    assert.equal(missing.ok, false);
  } finally {
    cleanupMissing();
  }

  const { path, cleanup } = seedStateFile();
  try {
    writeFileSync(path, 'not json {{{', 'utf8');
    const corrupt = await mutateTaskStateUnderLock((s) => s, path);
    assert.equal(corrupt.ok, false);
    assert.equal(readFileSync(path, 'utf8'), 'not json {{{', 'a corrupt file is not overwritten');
  } finally {
    cleanup();
  }
});

test('#175 mutateTaskStateUnderLock — a mutator result that fails validation is refused, not written', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    const res = await mutateTaskStateUnderLock((s) => /** @type {any} */ ({ ...s, taskId: '' }), path);
    assert.equal(res.ok, false);
    const after = readTaskState(path);
    assert.ok(after.ok && after.state.taskId === 'test-task', 'the invalid mutation never reached disk');
  } finally {
    cleanup();
  }
});

test('#175 mutateTaskStateUnderLock — the mutator sees the FRESH state, so a just-committed gate advance survives', async () => {
  // The crux of #175: pre-fix, the domain write merged onto a state read OUTSIDE
  // the lock, so it wrote back a stale gate. The mutator must instead see whatever
  // is currently on disk.
  const { path, cleanup } = seedStateFile({ workflowGate: 'plan-approved', lane: 'bug' });
  try {
    // Another writer advances the gate.
    await writeTaskState({ ...minimalState(), lane: 'bug', workflowGate: 'impl-started' }, path);
    // The domain write mutates AFTER — it must read impl-started, not plan-approved.
    let seenGate = '';
    const res = await mutateTaskStateUnderLock((s) => {
      seenGate = s.workflowGate;
      return { ...s, activeDomains: ['billing'] };
    }, path);
    assert.equal(res.ok, true);
    assert.equal(seenGate, 'impl-started', 'the mutator saw the FRESH advanced gate');
    const after = readTaskState(path);
    assert.ok(after.ok && after.state.workflowGate === 'impl-started', 'the gate advance survives the domain write');
    assert.ok(after.ok && after.state.activeDomains?.[0] === 'billing');
  } finally {
    cleanup();
  }
});

test('#175 mutateTaskStateUnderLock — two concurrent RMWs both apply (no lost update)', async () => {
  const { path, cleanup } = seedStateFile({ budget: 10, activeDomains: [] });
  try {
    // A sets budget; B sets activeDomains against the SAME file. Under the shared
    // lock they serialize and compose — neither is lost. (The deterministic proof
    // that the merge base is fresh is the "mutator sees the FRESH state" test
    // above; this one exercises real cross-call lock contention end-to-end.)
    await Promise.all([
      mutateTaskStateUnderLock((s) => ({ ...s, budget: 99 }), path),
      mutateTaskStateUnderLock((s) => ({ ...s, activeDomains: ['billing'] }), path),
    ]);
    const after = readTaskState(path);
    assert.ok(after.ok, 'state stays valid');
    assert.equal(after.ok && after.state.budget, 99, "A's write survived");
    assert.deepEqual(after.ok && after.state.activeDomains, ['billing'], "B's write survived");
  } finally {
    cleanup();
  }
});

// ── #112: stateVersion + optimistic concurrency + transition log ──────────────

test('#112 validateTaskState — a negative/non-integer stateVersion is rejected', () => {
  for (const bad of [-1, 1.5, '1']) {
    const result = validateTaskState({ ...minimalState(), stateVersion: /** @type {any} */ (bad) });
    assert.equal(result.ok, false, `stateVersion ${bad} must be rejected`);
    assert.ok(!result.ok && result.errors.some((e) => e.includes('stateVersion')));
  }
  // Absent is valid (legacy), and a valid non-negative integer is accepted.
  assert.equal(validateTaskState(minimalState()).ok, true);
  assert.equal(validateTaskState({ ...minimalState(), stateVersion: 0 }).ok, true);
});

test('#112 stateVersionOf — absent reads as 0, present reads through', () => {
  assert.equal(stateVersionOf(minimalState()), 0);
  assert.equal(stateVersionOf({ ...minimalState(), stateVersion: 7 }), 7);
});

test('#112 migrateTaskState — a state without stateVersion migrates to 0 and keeps its gate', () => {
  const legacy = { ...minimalState(), workflowGate: 'impl-started' };
  delete (/** @type {any} */ (legacy)).stateVersion;
  const migrated = migrateTaskState({ ...legacy, schemaVersion: 0 });
  assert.equal(migrated.stateVersion, 0, 'seeded at 0');
  assert.equal(migrated.workflowGate, 'impl-started', 'migration never opens a gate');
});

test('#112 mutateTaskStateUnderLock — the version increments monotonically per committed write', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    const first = await mutateTaskStateUnderLock((s) => ({ ...s, budget: 1 }), path);
    const second = await mutateTaskStateUnderLock((s) => ({ ...s, budget: 2 }), path);
    assert.deepEqual([first, second].map((r) => r.ok && r.version), [1, 2]);
    const after = readTaskState(path);
    assert.equal(after.ok && after.state.stateVersion, 2);
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateUnderLock — a matching expectedVersion applies; a stale one is a deterministic conflict', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    // Bring the on-disk version to 1.
    await mutateTaskStateUnderLock((s) => ({ ...s, budget: 1 }), path);

    // A pinned write at the wrong version is refused, writes nothing.
    const stale = await mutateTaskStateUnderLock((s) => ({ ...s, budget: 42 }), path, { expectedVersion: 0 });
    assert.equal(stale.ok, false);
    assert.ok(!stale.ok && stale.conflict === true, 'flagged as a conflict');
    assert.ok(!stale.ok && stale.currentVersion === 1 && stale.expectedVersion === 0);
    const mid = readTaskState(path);
    assert.equal(mid.ok && mid.state.budget, 1, 'the stale write never landed');
    assert.equal(mid.ok && mid.state.stateVersion, 1, 'version unchanged by a refused write');

    // A pin at the correct version applies and bumps.
    const fresh = await mutateTaskStateUnderLock((s) => ({ ...s, budget: 42 }), path, { expectedVersion: 1 });
    assert.deepEqual(fresh, { ok: true, written: true, version: 2 });
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateWithRetry — retries past a conflicting writer, then applies', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    let attempts = 0;
    const res = await mutateTaskStateWithRetry(
      (state, version) => {
        attempts += 1;
        // On the first attempt only, race in a competing write that bumps the
        // version out from under the pin — forcing exactly one retry.
        if (attempts === 1) {
          writeFileSync(path, JSON.stringify({ ...state, stateVersion: version + 1, budget: 5 }), 'utf8');
        }
        return { ...state, activeDomains: ['billing'] };
      },
      path,
      { attempts: 3 },
    );
    assert.equal(res.ok, true, 'eventually applies after the retry');
    assert.ok(attempts >= 2, 'the producer re-ran on the fresh version');
    const after = readTaskState(path);
    assert.deepEqual(after.ok && after.state.activeDomains, ['billing']);
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateWithRetry — a persistent conflict is bounded and returns the conflict', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    // Every produce call races in a fresh version bump, so the pin can never win.
    const res = await mutateTaskStateWithRetry(
      (state, version) => {
        writeFileSync(path, JSON.stringify({ ...state, stateVersion: version + 1 }), 'utf8');
        return { ...state, budget: 7 };
      },
      path,
      { attempts: 2 },
    );
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.conflict === true, 'gives up with a conflict, not an infinite loop');
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateUnderLock — a committed write appends a matching transition record', async () => {
  const { path, cleanup } = seedStateFile({ workflowGate: 'plan-approved' });
  try {
    await mutateTaskStateUnderLock(
      (s) => ({ ...s, workflowGate: 'spec-draft' }),
      path,
      { event: 'unit-test', ts: '2026-01-01T00:00:00.000Z' },
    );
    const logPath = transitionLogPath(path, 'test-task');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.deepEqual(rec, {
      taskId: 'test-task',
      branchId: 'test-task',
      fromVersion: 0,
      toVersion: 1,
      event: 'unit-test',
      fromGate: 'plan-approved',
      toGate: 'spec-draft',
      ts: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateUnderLock — a failing ensureDirSync is a non-throwing failure, not a crash', async () => {
  // Point the state path under an existing FILE, so creating its parent dir fails
  // (ENOTDIR/EEXIST). The doc contract is best-effort/non-throwing; the failure
  // must surface as { ok: false }, never a thrown error a hook wouldn't catch.
  const { path: filePath, cleanup } = seedStateFile();
  try {
    const underAFile = join(filePath, 'nested', 'task.json'); // filePath is a file, not a dir
    const res = await mutateTaskStateUnderLock((s) => s, underAFile);
    assert.equal(res.ok, false, 'reported as a failure, not thrown');
  } finally {
    cleanup();
  }
});

test('#112 mutateTaskStateUnderLock — a skipped write (null mutator) appends no transition record', async () => {
  const { path, cleanup } = seedStateFile();
  try {
    await mutateTaskStateUnderLock(() => null, path);
    assert.equal(existsSync(transitionLogPath(path, 'test-task')), false, 'no record for a no-op');
  } finally {
    cleanup();
  }
});
