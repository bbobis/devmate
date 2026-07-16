// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import { writeTaskState } from '../../../lib/task-state.mjs';
import {
  assertRubberDuckDispatchInput,
  createCritiqueResult,
  createGrillResult,
  writeCritiqueArtifact,
} from '../../../lib/workflow/agents/rubber-duck.mjs';
import {
  validateCritiqueResult,
  validateGrillResult,
} from '../../../lib/workflow/contracts.mjs';

/**
 * @returns {string}
 */
function makeTmpRepo() {
  return mkdtempSync(join(tmpdir(), 'devmate-rubber-duck-'));
}

/**
 * @param {string} taskId
 * @returns {import('../../../lib/types.mjs').TaskState}
 */
function minimalState(taskId) {
  return {
    taskId,
    lane: 'feature',
    workflowGate: 'plan-approved',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

// ============================================================================
// Unit — createGrillResult
// ============================================================================

describe('createGrillResult', () => {
  test('returns all required sections with defaults when inputs are empty', () => {
    const result = createGrillResult({}, { taskId: 'T-GRILL-1' });

    assert.equal(result.mode, 'grill');
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.taskId, 'T-GRILL-1');
    assert.ok(typeof result.returnedAt === 'string' && result.returnedAt.length > 0);

    const arrayFields = [
      'assumptions', 'missingRequirements', 'edgeCases', 'cornerCases',
      'securityRisks', 'uxRisks', 'blockingQuestions', 'recommendedDecisions',
      'unverifiedItems', 'risks',
    ];
    for (const field of arrayFields) {
      const val = result[/** @type {keyof typeof result} */ (field)];
      assert.ok(Array.isArray(val), `${field} must be an array`);
      assert.deepEqual(/** @type {unknown[]} */ (val), [], `${field} must default to empty array`);
    }
  });

  test('derives risks as concatenation of securityRisks and uxRisks', () => {
    const result = createGrillResult(
      { securityRisks: ['XSS via user input'], uxRisks: ['screen flicker on submit'] },
      { taskId: 'T-GRILL-2' },
    );

    assert.equal(result.securityRisks.length, 1);
    assert.equal(result.uxRisks.length, 1);
    assert.equal(result.risks.length, 2);
    assert.ok(result.risks.includes('XSS via user input'));
    assert.ok(result.risks.includes('screen flicker on submit'));
  });

  test('forces [UNVERIFIED] prefix on all unverifiedItems entries', () => {
    const result = createGrillResult(
      {
        unverifiedItems: [
          '[UNVERIFIED] already tagged',
          'missing tag',
          '   ',  // whitespace-only — filtered out
        ],
      },
      { taskId: 'T-GRILL-3' },
    );

    assert.equal(result.unverifiedItems.length, 2);
    assert.ok(result.unverifiedItems.every((item) => item.startsWith('[UNVERIFIED]')));
  });

  test('sets revisionsRequested from iterationNumber option', () => {
    const r0 = createGrillResult({}, { taskId: 'T-GRILL-4' });
    assert.equal(r0.revisionsRequested, 0);

    const r1 = createGrillResult({}, { taskId: 'T-GRILL-4', iterationNumber: 1 });
    assert.equal(r1.revisionsRequested, 1);

    const r2 = createGrillResult({}, { taskId: 'T-GRILL-4', iterationNumber: 2 });
    assert.equal(r2.revisionsRequested, 2);
  });

  test('strips empty strings from string lists', () => {
    const result = createGrillResult(
      { edgeCases: ['', 'valid edge case', '  '] },
      { taskId: 'T-GRILL-5' },
    );
    assert.equal(result.edgeCases.length, 1);
    assert.equal(result.edgeCases[0], 'valid edge case');
  });

  test('throws TypeError when taskId is missing', () => {
    assert.throws(
      () => createGrillResult({}, /** @type {any} */ ({ taskId: '' })),
      TypeError,
    );
  });
});

// ============================================================================
// Unit — validateGrillResult
// ============================================================================

describe('validateGrillResult', () => {
  test('accepts a valid artifact produced by createGrillResult', () => {
    const artifact = createGrillResult(
      { assumptions: ['auth token stays stable'], blockingQuestions: ['confirm rollout strategy'] },
      { taskId: 'T-VAL-1' },
    );
    const result = validateGrillResult(artifact);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  test('returns { ok, errors } shape (wired validator)', () => {
    const result = validateGrillResult({});
    assert.ok('ok' in result, 'must have ok key');
    assert.ok('errors' in result, 'must have errors key');
    assert.ok(Array.isArray(result.errors));
  });

  test('rejects null', () => {
    const result = validateGrillResult(null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test('rejects missing required array sections', () => {
    const result = validateGrillResult({
      taskId: 'T-VAL-2',
      mode: 'grill',
      schemaVersion: 1,
      returnedAt: new Date().toISOString(),
      revisionsRequested: 0,
      // omit all array fields
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('assumptions')));
  });

  test('rejects unverifiedItems entries without [UNVERIFIED] prefix', () => {
    const artifact = createGrillResult({}, { taskId: 'T-VAL-3' });
    const tampered = {
      ...artifact,
      unverifiedItems: ['this is missing the prefix'],
    };
    const result = validateGrillResult(tampered);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('[UNVERIFIED]')));
  });

  test('rejects wrong mode', () => {
    const artifact = createGrillResult({}, { taskId: 'T-VAL-4' });
    const result = validateGrillResult({ ...artifact, mode: 'critique' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('mode')));
  });

  test('rejects wrong schemaVersion', () => {
    const artifact = createGrillResult({}, { taskId: 'T-VAL-5' });
    const result = validateGrillResult({ ...artifact, schemaVersion: 2 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
  });
});

// ============================================================================
// Unit — createCritiqueResult
// ============================================================================

describe('createCritiqueResult', () => {
  test('returns all required sections with APPROVE_PLAN default', () => {
    const result = createCritiqueResult({}, { taskId: 'T-CRIT-1' });

    assert.equal(result.mode, 'critique');
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.taskId, 'T-CRIT-1');
    assert.equal(result.verdict, 'APPROVE_PLAN');
    assert.equal(result.revisionsRequested, 0);

    const arrayFields = [
      'missingAcceptanceCriteria', 'missingTests', 'riskySequencing',
      'unlistedFiles', 'backwardsCompatRisks',
    ];
    for (const field of arrayFields) {
      assert.ok(Array.isArray(result[/** @type {keyof typeof result} */ (field)]));
    }
  });

  test('preserves REQUEST_REVISION verdict when iterationNumber < 2', () => {
    const result = createCritiqueResult(
      { verdict: 'REQUEST_REVISION:missing edge case tests' },
      { taskId: 'T-CRIT-2', iterationNumber: 1 },
    );
    assert.ok(result.verdict.startsWith('REQUEST_REVISION:'));
    assert.equal(result.revisionsRequested, 1);
  });

  test('sets revisionsRequested from iterationNumber option', () => {
    const r = createCritiqueResult({}, { taskId: 'T-CRIT-3', iterationNumber: 2 });
    assert.equal(r.revisionsRequested, 2);
  });

  test('throws TypeError when taskId is missing', () => {
    assert.throws(
      () => createCritiqueResult({}, /** @type {any} */ ({ taskId: '  ' })),
      TypeError,
    );
  });
});

// ============================================================================
// Unit — validateCritiqueResult
// ============================================================================

describe('validateCritiqueResult', () => {
  test('accepts a valid artifact produced by createCritiqueResult', () => {
    const artifact = createCritiqueResult(
      { missingTests: ['unit test for fold path'], verdict: 'APPROVE_PLAN' },
      { taskId: 'T-VCRIT-1' },
    );
    const result = validateCritiqueResult(artifact);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  test('rejects invalid verdict format', () => {
    const artifact = createCritiqueResult({}, { taskId: 'T-VCRIT-2' });
    const result = validateCritiqueResult({ ...artifact, verdict: 'APPROVE_NOW' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('verdict')));
  });

  test('rejects missing mode field', () => {
    const artifact = createCritiqueResult({}, { taskId: 'T-VCRIT-3' });
    const { mode: _mode, ...rest } = artifact;
    const result = validateCritiqueResult(rest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('mode')));
  });
});

// ============================================================================
// Unit — assertRubberDuckDispatchInput
// ============================================================================

describe('assertRubberDuckDispatchInput', () => {
  test('throws on non-object input', () => {
    assert.throws(() => assertRubberDuckDispatchInput(null), TypeError);
    assert.throws(() => assertRubberDuckDispatchInput('string'), TypeError);
  });

  test('throws on missing or invalid mode', () => {
    assert.throws(
      () => assertRubberDuckDispatchInput({ mode: 'analyze', taskId: 'T1' }),
      TypeError,
    );
    assert.throws(
      () => assertRubberDuckDispatchInput({ taskId: 'T1' }),
      TypeError,
    );
  });

  test('throws on missing taskId', () => {
    assert.throws(
      () => assertRubberDuckDispatchInput({ mode: 'grill', taskId: '' }),
      TypeError,
    );
    assert.throws(
      () => assertRubberDuckDispatchInput({ mode: 'grill', taskId: '   ' }),
      TypeError,
    );
  });

  test('throws on grill mode without request or discoveryPointer', () => {
    assert.throws(
      () => assertRubberDuckDispatchInput({ mode: 'grill', taskId: 'T1' }),
      TypeError,
    );
  });

  test('throws on critique mode without planPointer', () => {
    assert.throws(
      () => assertRubberDuckDispatchInput({ mode: 'critique', taskId: 'T1' }),
      TypeError,
    );
  });

  test('passes on valid grill input with request', () => {
    assert.doesNotThrow(() =>
      assertRubberDuckDispatchInput({
        mode: 'grill',
        taskId: 'T-DISPATCH-1',
        request: 'Add pagination to the orders list',
      }),
    );
  });

  test('passes on valid grill input with discoveryPointer', () => {
    assert.doesNotThrow(() =>
      assertRubberDuckDispatchInput({
        mode: 'grill',
        taskId: 'T-DISPATCH-2',
        discoveryPointer: '.devmate/session/T-DISPATCH-2/discovery.json',
      }),
    );
  });

  test('passes on valid critique input', () => {
    assert.doesNotThrow(() =>
      assertRubberDuckDispatchInput({
        mode: 'critique',
        taskId: 'T-DISPATCH-3',
        planPointer: '.devmate/session/T-DISPATCH-3/plan.json',
      }),
    );
  });
});

// ============================================================================
// Integration — two-revision fold
// ============================================================================

describe('two-revision fold', () => {
  test('folds REQUEST_REVISION reason into backwardsCompatRisks at iterationNumber 2', () => {
    const result = createCritiqueResult(
      {
        verdict: 'REQUEST_REVISION:missing edge case tests for the fold path',
        backwardsCompatRisks: ['existing compat risk'],
      },
      { taskId: 'T-FOLD-1', iterationNumber: 2 },
    );

    assert.equal(result.verdict, 'APPROVE_PLAN');
    assert.equal(result.revisionsRequested, 2);
    assert.ok(result.backwardsCompatRisks.length >= 2);
    assert.ok(result.backwardsCompatRisks.includes('existing compat risk'));
    assert.ok(
      result.backwardsCompatRisks.some((r) => r.startsWith('[FOLDED]')),
      'folded reason must be prefixed with [FOLDED]',
    );
    assert.ok(
      result.backwardsCompatRisks.some((r) => r.includes('missing edge case tests')),
    );
  });

  test('passes REQUEST_REVISION through unchanged at iterationNumber 1', () => {
    const result = createCritiqueResult(
      { verdict: 'REQUEST_REVISION:needs more tests' },
      { taskId: 'T-FOLD-2', iterationNumber: 1 },
    );
    assert.ok(result.verdict.startsWith('REQUEST_REVISION:'));
    assert.equal(result.backwardsCompatRisks.length, 0);
  });

  test('produced artifact passes validateCritiqueResult after fold', () => {
    const artifact = createCritiqueResult(
      { verdict: 'REQUEST_REVISION:blocker still open' },
      { taskId: 'T-FOLD-3', iterationNumber: 2 },
    );
    const verdict = validateCritiqueResult(artifact);
    assert.equal(verdict.ok, true, `fold produced invalid artifact: ${verdict.errors.join('; ')}`);
  });
});

// ============================================================================
// Integration — writeCritiqueArtifact round-trip
// ============================================================================

describe('writeCritiqueArtifact round-trip', () => {
  test('writes critique.json and validateCritiqueResult passes on re-read', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-WRITE-1';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');

      const { mkdirSync: mkdir } = await import('node:fs');
      mkdir(join(repoRoot, '.devmate', 'state'), { recursive: true });
      await writeTaskState(minimalState(taskId), statePath);

      const artifact = createCritiqueResult(
        {
          missingTests: ['unit test for edge path'],
          verdict: 'APPROVE_PLAN',
        },
        { taskId, iterationNumber: 1 },
      );

      const { path } = await writeCritiqueArtifact(artifact, { taskId, repoRoot, statePath });

      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      const verdict = validateCritiqueResult(parsed);

      assert.equal(verdict.ok, true, `round-trip failed: ${verdict.errors.join('; ')}`);
      assert.equal(parsed.taskId, taskId);
      assert.equal(parsed.mode, 'critique');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Regression — factory purity
// ============================================================================

describe('factory purity', () => {
  test('createGrillResult returns a result without touching the file system', () => {
    // If this throws, the factory performed unexpected I/O
    const result = createGrillResult(
      { blockingQuestions: ['is the API stable?'] },
      { taskId: 'T-PURE-1', iterationNumber: 0 },
    );
    assert.equal(typeof result, 'object');
    assert.equal(result.mode, 'grill');
  });

  test('createCritiqueResult returns a result without touching the file system', () => {
    const result = createCritiqueResult(
      { verdict: 'APPROVE_PLAN' },
      { taskId: 'T-PURE-2', iterationNumber: 0 },
    );
    assert.equal(typeof result, 'object');
    assert.equal(result.mode, 'critique');
  });

  test('validateGrillResult and validateCritiqueResult are synchronous and side-effect-free', () => {
    const g = createGrillResult({}, { taskId: 'T-PURE-3' });
    const c = createCritiqueResult({}, { taskId: 'T-PURE-3' });
    const gv = validateGrillResult(g);
    const cv = validateCritiqueResult(c);
    assert.equal(gv.ok, true);
    assert.equal(cv.ok, true);
  });
});
