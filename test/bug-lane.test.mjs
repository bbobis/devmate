// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBugLane } from '../lib/workflow/lanes/bug.mjs';
import { validateDiagnosisResult, FIXER_TARGET } from '../lib/workflow/bug-handoff.mjs';
import { createMockExecutor, assertCallOrder, assertNoCalls } from '../lib/test-utils/mock-executor.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../lib/types.mjs').DiagnosisResult} DiagnosisResult */

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: 'bug-lane-1',
    lane: 'bug',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 8,
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {Partial<DiagnosisResult>} [over]
 * @returns {DiagnosisResult}
 */
function makeDiagnosis(over = {}) {
  return {
    bugScope: 'backend',
    suspectedLayer: 'Service guard clause',
    reproCommand: 'node --test test/bug-regression.test.mjs',
    fixerRecommendation: 'Add null guard before mutation',
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/app.mjs'],
    allowedGlobs: [],
    taskId: 'bug-lane-1',
    schemaVersion: 1,
    ...over,
  };
}

test('bug lane e2e enforces diagnose-first, scope checks, failing test before fix, verify after fix', async () => {
  const diagnosis = makeDiagnosis();
  const state = makeState();
  const { executor, getCallLog } = createMockExecutor({
    agents: ['diagnose', 'fullstack', 'verify'],
    stubResults: {
      diagnose: { status: 'ok' },
      fullstack: { status: 'ok' },
      verify: { passed: true, summary: 'regression fixed' },
    },
  });

  let regressionFailedFirst = false;
  executor.invoke('diagnose', { description: 'Order total bug' });

  const result = await runBugLane('Order total bug', state, {
    diagnosis,
    /** @param {DiagnosisResult} value */
    validate: (value) => {
      const verdict = validateDiagnosisResult(value);
      if (!verdict.ok) {
        throw new TypeError(verdict.errors.join('; '));
      }
      return value;
    },
    /** @param {DiagnosisResult} value */
    dispatch: async (value) => {
      executor.invoke('fullstack', { persona: value.bugScope, scope: value.suspectedLayer });
      regressionFailedFirst = true;
      return {
        target: FIXER_TARGET,
        persona: value.bugScope,
        stateUpdated: true,
      };
    },
    verify: async () => {
      executor.invoke('verify', { phase: 'post-fix' });
      if (!regressionFailedFirst) {
        return { passed: false, summary: 'regression test never failed first' };
      }
      return { passed: true, summary: 'verify after fix passed' };
    },
  });

  assert.equal(result.status, 'verified');
  assert.match(result.summary, /verify after fix passed/i);
  assertCallOrder(getCallLog(), ['diagnose', 'fullstack', 'verify']);
});

test('bug lane blocks invalid diagnosis scope before dispatch', async () => {
  const diagnosis = makeDiagnosis({ bugScope: '' });
  const state = makeState();
  const { executor, getCallLog } = createMockExecutor({
    agents: ['diagnose', 'fullstack', 'verify'],
    stubResults: {
      diagnose: { status: 'ok' },
      fullstack: { status: 'ok' },
      verify: { passed: true },
    },
  });

  executor.invoke('diagnose', { description: 'Scope mismatch bug' });

  const result = await runBugLane('Scope mismatch bug', state, {
    diagnosis,
    /** @param {DiagnosisResult} value */
    validate: (value) => {
      const verdict = validateDiagnosisResult(value);
      if (!verdict.ok) {
        throw new TypeError(verdict.errors.join('; '));
      }
      return value;
    },
    dispatch: async () => {
      executor.invoke('fullstack', { shouldNotRun: true });
      return { target: FIXER_TARGET, persona: 'backend', stateUpdated: true };
    },
    verify: async () => {
      executor.invoke('verify', { shouldNotRun: true });
      return { passed: true };
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /bugScope/i);
  assertNoCalls(getCallLog(), ['fullstack', 'verify']);
});
