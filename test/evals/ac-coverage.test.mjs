// @ts-check
/**
 * AC-6 (epic #416): unit tests for the AC-coverage scorer + report aggregation
 * (the eval-of-the-eval) over SYNTHETIC verdicts, plus fixture-shape checks that
 * read the committed scenarios via loadScenarios(). No temp-dir materialization
 * and no filesystem writes — the real-module harness that materializes fixtures
 * and drives the gate lives in evals/ac-coverage/suite.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreScenario, buildCoverageReport, COMPARED_FIELDS } from '../../evals/ac-coverage/scorer.mjs';
import { loadScenarios } from '../../evals/ac-coverage/index.mjs';

/** @typedef {import('../../evals/ac-coverage/scorer.mjs').CoverageVerdict} CoverageVerdict */
/** @typedef {import('../../evals/ac-coverage/scorer.mjs').ScenarioResult} ScenarioResult */

/** Ids every fixture release must carry — the full loss/gate matrix from the issue. */
const EXPECTED_IDS = [
  'feature-full-coverage',
  'feature-partial',
  'feature-omitted-ids',
  'feature-false-claim',
  'feature-zero-ac',
  'chore-zero-ac',
  'feature-duplicate-ids',
  'feature-task-local-as-global',
  'feature-stale-completion',
];

/**
 * Build a CoverageVerdict, overriding selected fields on a full-coverage base.
 * @param {Partial<CoverageVerdict>} [overrides]
 * @returns {CoverageVerdict}
 */
function verdict(overrides = {}) {
  return {
    total: 3,
    completed: 3,
    coverageOk: true,
    off: 'allow',
    warn: 'allow',
    block: 'allow',
    warnViolations: 0,
    ...overrides,
  };
}

// ---- scoreScenario ----

test('scorer › matching observed scores ok with no mismatches', () => {
  const expected = verdict({ completed: 2, coverageOk: false, block: 'refuse', warnViolations: 1 });
  const score = scoreScenario('x', expected, verdict({ completed: 2, coverageOk: false, block: 'refuse', warnViolations: 1 }));
  assert.equal(score.ok, true);
  assert.deepEqual(score.mismatches, []);
});

test('scorer › a deviating field fails the scenario and is named', () => {
  const expected = verdict({ completed: 2, coverageOk: false, block: 'refuse', warnViolations: 1 });
  const observed = verdict({ completed: 2, coverageOk: false, block: 'allow', warnViolations: 0 });
  const score = scoreScenario('x', expected, observed);
  assert.equal(score.ok, false);
  assert.equal(score.mismatches.length, 2);
  assert.ok(score.mismatches.some((m) => m.startsWith('block:')));
  assert.ok(score.mismatches.some((m) => m.startsWith('warnViolations:')));
});

test('scorer › compares exactly the seven verdict fields', () => {
  assert.deepEqual(
    [...COMPARED_FIELDS].sort(),
    ['block', 'completed', 'coverageOk', 'off', 'total', 'warn', 'warnViolations'],
  );
});

// ---- buildCoverageReport ----

test('report › detectionRate, failed, and knownLimitations are computed correctly', () => {
  /** @type {ScenarioResult[]} */
  const results = [
    { id: 'a', lane: 'feature', category: 'miss', observed: verdict({ block: 'refuse' }), score: { id: 'a', ok: true, mismatches: [] }, note: null },
    { id: 'b', lane: 'feature', category: 'miss', observed: verdict({ block: 'allow' }), score: { id: 'b', ok: true, mismatches: [] }, note: null },
    { id: 'c', lane: 'feature', category: 'known-limitation', observed: verdict(), score: { id: 'c', ok: true, mismatches: [] }, note: null },
    { id: 'd', lane: 'feature', category: 'correct', observed: verdict(), score: { id: 'd', ok: false, mismatches: ['total: expected 3, observed 2'] }, note: null },
  ];
  const report = buildCoverageReport(results);
  assert.equal(report.missCount, 2);
  assert.equal(report.blockDetected, 1);
  assert.equal(report.offDetected, 0);
  assert.equal(report.detectionRate, 0.5);
  assert.deepEqual(report.knownLimitations, ['c']);
  assert.deepEqual(report.failed, ['d']);
  assert.equal(report.passed, false);
  assert.equal(report.scenarioCount, 4);
});

test('report › no misses yields a detectionRate of 1', () => {
  /** @type {ScenarioResult[]} */
  const results = [
    { id: 'a', lane: 'chore', category: 'correct', observed: verdict(), score: { id: 'a', ok: true, mismatches: [] }, note: null },
  ];
  const report = buildCoverageReport(results);
  assert.equal(report.missCount, 0);
  assert.equal(report.detectionRate, 1);
  assert.equal(report.passed, true);
});

// ---- Fixture hygiene ----

test('fixtures › cover the full loss/gate matrix with well-formed expectations', () => {
  const scenarios = loadScenarios();
  assert.deepEqual(scenarios.map((s) => s.id).sort(), [...EXPECTED_IDS].sort());
  for (const s of scenarios) {
    assert.ok(['correct', 'miss', 'known-limitation'].includes(s.category), `${s.id} has a valid category`);
    for (const field of COMPARED_FIELDS) {
      assert.ok(field in s.expected, `${s.id}.expected declares "${field}"`);
    }
    // A declared miss must expect a block-mode refusal; a compliant/known-limitation
    // scenario must expect block to allow — keeps fixtures internally consistent.
    if (s.category === 'miss') {
      assert.equal(s.expected.block, 'refuse', `${s.id} is a miss → block must refuse`);
    } else {
      assert.equal(s.expected.block, 'allow', `${s.id} is ${s.category} → block must allow`);
    }
  }
});
