// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBugLane,
  runBugHandoff,
} from '../../../../lib/workflow/lanes/bug.mjs';
import { validateDiagnosisResult, FIXER_TARGET } from '../../../../lib/workflow/bug-handoff.mjs';

/** @typedef {import('../../../../lib/types.mjs').DiagnosisResult} DiagnosisResult */
/** @typedef {import('../../../../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<DiagnosisResult>} [over]
 * @returns {DiagnosisResult}
 */
function makeDiagnosis(over = {}) {
  return {
    bugScope: 'backend',
    suspectedLayer: 'Service layer null-check',
    reproCommand: 'npm test -- --grep order-total',
    fixerRecommendation: 'Add null guard before sum.',
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/app.mjs'],
    allowedGlobs: [],
    taskId: 'bug-42',
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: 'bug-42',
    lane: 'bug',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// E2E (happy path) — call order: validate -> dispatch -> verify
// ---------------------------------------------------------------------------

test('runBugLane — E2E happy path with injected functions', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d); // real validation to ensure schema is good
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (d, _s, _o) => {
    callOrder.push('dispatch');
    return {
      target: FIXER_TARGET,
      persona: d.bugScope,
      stateUpdated: true,
    };
  };

  /** @param {any} _opts */
  const fakeVerify = async (_opts) => {
    callOrder.push('verify');
    return {
      passed: true,
      summary: 'Regression test verified and bug dispatched successfully.',
    };
  };

  const result = await runBugLane('order-total returns zero', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
    verify: fakeVerify,
  });

  // Assert call order
  assert.deepEqual(callOrder, ['validate', 'dispatch', 'verify']);

  // Assert return value
  assert.equal(result.status, 'verified');
  assert.match(result.summary, /dispatched|verified/i);
});

test('runBugLane — default verify runs when none injected (E9-13)', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d);
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (d, _s, _o) => {
    callOrder.push('dispatch');
    return {
      target: FIXER_TARGET,
      persona: d.bugScope,
      stateUpdated: true,
    };
  };

  // No verify injected: the real default runs verifyStep over verifyArgv.
  // Point it at a fast no-op command and temp trace/output paths.
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'bug-default-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  const result = await runBugLane('order-total returns zero', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
    verifyArgv: [process.execPath, '--version'],
    traceFile: join(tmp, 'trace.jsonl'),
    repoRoot: tmp,
    outputDir: join(tmp, 'output'),
  });

  assert.deepEqual(callOrder, ['validate', 'dispatch']);
  // The default verify really ran (and passed) — no more unconditional
  // status: 'verified' without verification.
  assert.equal(result.status, 'verified');
  assert.match(result.summary, /diagnosed|dispatched|verif/i);
});

// ---------------------------------------------------------------------------
// Negative (schema) — missing reproCommand halts at validate, verify never called
// ---------------------------------------------------------------------------

test('runBugLane — negative case: missing reproCommand → validation fails', async () => {
  const diagnosis = makeDiagnosis();
  // @ts-expect-error intentional removal
  delete diagnosis.reproCommand;
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d); // will throw
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (d, _s, _o) => {
    callOrder.push('dispatch');
    return { target: FIXER_TARGET, persona: d.bugScope, stateUpdated: true };
  };

  /** @param {any} _opts */
  const fakeVerify = async (_opts) => {
    callOrder.push('verify');
    return { passed: true, summary: 'Verified.' };
  };

  const result = await runBugLane('order-total', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
    verify: fakeVerify,
  });

  // Assert early halt: only validate called, not dispatch or verify
  assert.deepEqual(callOrder, ['validate']);

  // Assert error in summary
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /reproCommand/i);
});

test('runBugLane — negative case: missing bugScope → validation fails', async () => {
  const diagnosis = makeDiagnosis();
  // @ts-expect-error intentional removal
  delete diagnosis.bugScope;
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d); // will throw
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (_d, _s, _o) => {
    callOrder.push('dispatch');
    return { target: FIXER_TARGET, persona: 'unknown', stateUpdated: true };
  };

  const result = await runBugLane('crash on startup', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
  });

  // Assert dispatch never called
  assert.deepEqual(callOrder, ['validate']);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /bugScope/i);
});

// ---------------------------------------------------------------------------
// Negative (dispatch) — dispatch fails, verify never called
// ---------------------------------------------------------------------------

test('runBugLane — negative case: dispatch throws → lane fails', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d);
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (_d, _s, _o) => {
    callOrder.push('dispatch');
    throw new Error('dispatch failed: no routing config for persona backend');
  };

  /** @param {any} _opts */
  const fakeVerify = async (_opts) => {
    callOrder.push('verify');
    return { passed: true, summary: 'OK' };
  };

  const result = await runBugLane('order-total', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
    verify: fakeVerify,
  });

  // Assert verify never called (stopped after dispatch failure)
  assert.deepEqual(callOrder, ['validate', 'dispatch']);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /dispatch failed/i);
});

// ---------------------------------------------------------------------------
// Safety (scope) — out-of-scope edit rejection, verify not called
// ---------------------------------------------------------------------------

test('runBugLane — safety case: verify fails → lane status is failed', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();

  /** @type {string[]} */
  const callOrder = [];

  /** @param {DiagnosisResult} d */
  const fakeValidate = (d) => {
    callOrder.push('validate');
    return validateDiagnosisResult(d);
  };

  /** @type {(d: any, s: any, o: any) => Promise<any>} */
  const fakeDispatch = async (d, _s, _o) => {
    callOrder.push('dispatch');
    return {
      target: FIXER_TARGET,
      persona: d.bugScope,
      stateUpdated: true,
    };
  };

  /** @param {any} _opts */
  const fakeVerify = async (_opts) => {
    callOrder.push('verify');
    return {
      passed: false,
      summary: 'Regression test still failing: order-total returns 0.',
    };
  };

  const result = await runBugLane('order-total', state, {
    diagnosis,
    validate: fakeValidate,
    dispatch: fakeDispatch,
    verify: fakeVerify,
  });

  // Assert verify was called (full chain executed)
  assert.deepEqual(callOrder, ['validate', 'dispatch', 'verify']);

  // Assert failed status due to verification failure
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /Regression test still failing/i);
});

// ---------------------------------------------------------------------------
// Negative (no diagnosis) — early halt with message
// ---------------------------------------------------------------------------

test('runBugLane — negative case: no diagnosis provided → fails immediately', async () => {
  const state = makeState();

  const result = await runBugLane('some-bug', state, {
    // no diagnosis provided
  });

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /no diagnosis provided/i);
});

// ---------------------------------------------------------------------------
// Backward compat: runBugHandoff still works
// ---------------------------------------------------------------------------

test('runBugHandoff — regression: existing function still works', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();

  // Isolate all writes to a temp workspace: with no paths the handoff would
  // default to cwd-relative `.devmate/state/{task.json,transitions.jsonl}` and
  // leak `bug-42` state into the repo tree (gitignored, so `git status` stays
  // clean but the artifact-allowlist check flags the stray).
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'bug-handoff-'));
  const statePath = join(tmp, 'task.json');
  const transitionsPath = join(tmp, 'transitions.jsonl');

  const result = await runBugHandoff(diagnosis, state, { statePath, transitionsPath });

  assert.equal(result.target, FIXER_TARGET);
  assert.equal(result.persona, 'backend');
  assert.equal(result.stateUpdated, true);

  // Isolation regression: the write landed in temp, not the repo tree.
  const persisted = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  assert.equal(persisted.taskId, 'bug-42');
  assert.equal(persisted.bugScope, 'backend');
});
