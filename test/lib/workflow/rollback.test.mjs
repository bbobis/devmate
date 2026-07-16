// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRollbackPlan,
  validateStash,
  checkDirtyState,
  applyRollback,
} from '../../../lib/workflow/rollback.mjs';

/**
 * Build a mock runner. `responses` maps a matcher (substring of the joined
 * argv) to a partial RunCommandResult. Records every argv it is called with.
 * @param {Array<{ match: string, result: Partial<import('../../../lib/types.mjs').RunCommandResult> }>} responses
 */
function mockRunner(responses) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../../../lib/types.mjs').RunCommandResult} */
  const base = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  /** @type {(argv: string[]) => Promise<import('../../../lib/types.mjs').RunCommandResult>} */
  const run = async (argv) => {
    calls.push(argv);
    const joined = argv.join(' ');
    const hit = responses.find((r) => joined.includes(r.match));
    return { ...base, ...(hit ? hit.result : {}) };
  };
  return { run, calls };
}

/** @returns {import('../../../lib/types.mjs').TaskState} */
function makeState(over = {}) {
  return {
    taskId: 'feat-1',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: 'stash@{0}',
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// validateStash
// ---------------------------------------------------------------------------

test('validateStash — ref present in stash list → exists true', async () => {
  const { run } = mockRunner([
    { match: 'stash list', result: { stdout: 'stash@{0}: WIP on main: abc\n' } },
  ]);
  const result = await validateStash('stash@{0}', { run });
  assert.equal(result.exists, true);
});

test('validateStash — ref absent → exists false with reason', async () => {
  const { run } = mockRunner([{ match: 'stash list', result: { stdout: '' } }]);
  const result = await validateStash('stash@{0}', { run });
  assert.equal(result.exists, false);
  assert.match(result.reason || '', /Stash not found/);
});

// ---------------------------------------------------------------------------
// checkDirtyState
// ---------------------------------------------------------------------------

test('checkDirtyState — clean porcelain → empty array', async () => {
  const { run } = mockRunner([{ match: 'status --porcelain', result: { stdout: '' } }]);
  assert.deepEqual(await checkDirtyState({ run }), []);
});

test('checkDirtyState — two modified files → two paths', async () => {
  const { run } = mockRunner([
    { match: 'status --porcelain', result: { stdout: ' M lib/a.mjs\n M lib/b.mjs\n' } },
  ]);
  const dirty = await checkDirtyState({ run });
  assert.deepEqual(dirty, ['lib/a.mjs', 'lib/b.mjs']);
});

// ---------------------------------------------------------------------------
// buildRollbackPlan
// ---------------------------------------------------------------------------

test('buildRollbackPlan — populated state yields a complete plan', async () => {
  const { run } = mockRunner([
    { match: 'stash list', result: { stdout: 'stash@{0}: WIP\n' } },
    { match: 'status --porcelain', result: { stdout: '' } },
    { match: 'rev-parse', result: { stdout: 'deadbeef\n' } },
  ]);
  const plan = await buildRollbackPlan(makeState(), { run });
  assert.equal(plan.stashRef, 'stash@{0}');
  assert.equal(plan.targetCommit, 'deadbeef');
  assert.ok(plan.drySummary.includes('Rollback plan'));
  assert.ok(plan.recoveryHints.length > 0);
  assert.equal(plan.hasConflicts, false);
});

test('buildRollbackPlan — missing preImplStash throws', async () => {
  const { run } = mockRunner([]);
  await assert.rejects(
    () => buildRollbackPlan(makeState({ preImplStash: null }), { run }),
    /preImplStash is null/,
  );
});

// ---------------------------------------------------------------------------
// applyRollback
// ---------------------------------------------------------------------------

/** @returns {import('../../../lib/types.mjs').RollbackPlan} */
function makePlan(over = {}) {
  return {
    stashRef: 'stash@{0}',
    targetCommit: 'deadbeef',
    dirtyFiles: [],
    hasConflicts: false,
    drySummary: 'Rollback plan (dry-run)',
    recoveryHints: ['Run: git stash list'],
    ...over,
  };
}

test('applyRollback — dryRun returns success and runs no git', async () => {
  const { run, calls } = mockRunner([]);
  const result = await applyRollback(makePlan(), { dryRun: true, run });
  assert.equal(result.success, true);
  assert.equal(calls.length, 0);
});

test('applyRollback — confirmed:false throws confirmation error', async () => {
  const { run } = mockRunner([]);
  await assert.rejects(
    () => applyRollback(makePlan(), { confirmed: false, run }),
    /requires explicit confirmation/,
  );
});

test('applyRollback — dirty tree aborts before any git spawn', async () => {
  const { run, calls } = mockRunner([]);
  const result = await applyRollback(makePlan({ dirtyFiles: ['lib/a.mjs'] }), {
    confirmed: true,
    run,
  });
  assert.equal(result.success, false);
  assert.match(result.message, /Dirty working tree/);
  assert.equal(calls.length, 0);
});

test('applyRollback — missing stash returns failure with hints', async () => {
  const { run } = mockRunner([{ match: 'stash list', result: { stdout: '' } }]);
  const result = await applyRollback(makePlan(), { confirmed: true, run });
  assert.equal(result.success, false);
  assert.ok(result.recoveryHints.length > 0);
});

test('applyRollback — happy path (mocked) returns success and uses argv arrays', async () => {
  const { run, calls } = mockRunner([
    { match: 'stash list', result: { stdout: 'stash@{0}: WIP\n' } },
    { match: 'reset --hard', result: { exitCode: 0 } },
    { match: 'stash pop', result: { exitCode: 0 } },
  ]);
  const result = await applyRollback(makePlan(), { confirmed: true, run });
  assert.equal(result.success, true);
  // every spawn call is an argv array starting with 'git'
  for (const argv of calls) {
    assert.ok(Array.isArray(argv));
    assert.equal(argv[0], 'git');
  }
  assert.ok(calls.some((a) => a.includes('reset') && a.includes('--hard')));
  assert.ok(calls.some((a) => a.includes('pop')));
});

test('applyRollback — reset failure returns failure with hints', async () => {
  const { run } = mockRunner([
    { match: 'stash list', result: { stdout: 'stash@{0}: WIP\n' } },
    { match: 'reset --hard', result: { exitCode: 1, stderr: 'boom' } },
  ]);
  const result = await applyRollback(makePlan(), { confirmed: true, run });
  assert.equal(result.success, false);
  assert.match(result.message, /reset --hard failed/);
});
