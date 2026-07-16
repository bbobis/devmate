// @ts-check
/**
 * AC-6 (epic #416): the deterministic AC-coverage eval suite, run under
 * `node --test` (so it is exercised by `npm test` / `npm run verify` / CI,
 * exactly like evals/issue-quality and evals/gate-robustness).
 *
 * It runs the REAL harness (evals/ac-coverage/index.mjs — the same module the
 * scripts/run-ac-coverage-evals.mjs CLI wraps), which materializes each fixture
 * into a real `.devmate/` root and drives AC-1's `computeAcCoverage` read and
 * AC-2's `pr-ready` gate under off/warn/block, and asserts every scenario
 * reaches its expected verdict. The pure scorer + report aggregation (the
 * eval-of-the-eval) are unit-tested separately in test/evals/ac-coverage.test.mjs.
 * Temp dirs only; committed fixtures are read-only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { evaluateScenarios, runScenario, loadScenarios } from './index.mjs';

test('ac-coverage › every fixture scenario reaches its expected verdict', async () => {
  const report = await evaluateScenarios(loadScenarios());
  for (const s of report.scenarios) {
    assert.ok(s.score.ok, `scenario "${s.id}" diverged: ${s.score.mismatches.join('; ')}`);
  }
  assert.equal(report.passed, true, `failed scenarios: ${report.failed.join(', ')}`);
  assert.equal(report.scenarioCount, 9);
});

test('ac-coverage › gate moves detection from 0% (off, pre-gate) to 100% of targeted misses (block)', async () => {
  const report = await evaluateScenarios(loadScenarios());
  assert.ok(report.missCount >= 5, `expected at least 5 miss scenarios, got ${report.missCount}`);
  // Off mode is the pre-gate baseline: it never refuses, so no miss is detected.
  assert.equal(report.offDetected, 0);
  // Block mode catches every Phase-1-targetable miss.
  assert.equal(report.blockDetected, report.missCount);
  assert.equal(report.detectionRate, 1);
});

test('ac-coverage › partial coverage: block refuses, warn records one violation, off allows', async () => {
  const report = await evaluateScenarios(loadScenarios());
  const partial = report.scenarios.find((s) => s.id === 'feature-partial');
  assert.ok(partial, 'feature-partial scenario present');
  assert.equal(partial.observed.off, 'allow');
  assert.equal(partial.observed.warn, 'allow');
  assert.equal(partial.observed.block, 'refuse');
  assert.equal(partial.observed.warnViolations, 1);
});

test('ac-coverage › feature zero-AC fails closed under block; chore zero-AC passes', async () => {
  const report = await evaluateScenarios(loadScenarios());
  const featureZero = report.scenarios.find((s) => s.id === 'feature-zero-ac');
  const choreZero = report.scenarios.find((s) => s.id === 'chore-zero-ac');
  assert.ok(featureZero && choreZero);
  assert.equal(featureZero.observed.total, 0);
  assert.equal(featureZero.observed.block, 'refuse'); // fail closed, not vacuous pass
  assert.equal(choreZero.observed.total, 0);
  assert.equal(choreZero.observed.block, 'allow'); // no coverage expectation on chore
});

test('ac-coverage › duplicate AC ids are de-duplicated and tolerated (total 3, full coverage)', async () => {
  const report = await evaluateScenarios(loadScenarios());
  const dup = report.scenarios.find((s) => s.id === 'feature-duplicate-ids');
  assert.ok(dup);
  assert.equal(dup.observed.total, 3);
  assert.equal(dup.observed.block, 'allow');
});

test('ac-coverage › the stale-completion limitation is surfaced, not silently passed', async () => {
  const report = await evaluateScenarios(loadScenarios());
  // The renumbered-after-revision case passes coverage today (id-only match) —
  // it must be recorded as an expected-to-detect-later limitation, not omitted.
  assert.deepEqual(report.knownLimitations, ['feature-stale-completion']);
  const stale = report.scenarios.find((s) => s.id === 'feature-stale-completion');
  assert.ok(stale);
  assert.equal(stale.category, 'known-limitation');
  assert.equal(stale.observed.block, 'allow');
});

test('ac-coverage › evaluation is deterministic across runs', async () => {
  const a = await evaluateScenarios(loadScenarios());
  const b = await evaluateScenarios(loadScenarios());
  assert.deepEqual(a, b);
});

test('ac-coverage › a single scenario runs through the real gate under every mode', async () => {
  const [full] = loadScenarios().filter((s) => s.id === 'feature-full-coverage');
  assert.ok(full);
  const observed = await runScenario(full, tmpdir());
  assert.deepEqual(
    { off: observed.off, warn: observed.warn, block: observed.block },
    { off: 'allow', warn: 'allow', block: 'allow' },
  );
});
