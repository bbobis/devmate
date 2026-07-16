// @ts-check
/**
 * E8-4: model-routing eval suite. Asserts the policy router behaves correctly:
 * routes by budget class when allowed, refuses unverified IDs by default, and
 * the baseline guard blocks default changes without a measured baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeModel } from '../../lib/routing/model-policy.mjs';
import { assertEvalBaselineExists } from '../../lib/routing/policy-guard.mjs';

/** @typedef {import('../../lib/types.mjs').ModelPolicy} ModelPolicy */

/** Unverified policy mirroring the committed placeholder config. @type {ModelPolicy} */
const UNVERIFIED_POLICY = {
  schemaVersion: 1,
  byBudgetClass: {
    tiny: { modelId: '[UNVERIFIED — tiny]', verifiedAt: null },
    standard: { modelId: '[UNVERIFIED — standard]', verifiedAt: null },
    large: { modelId: '[UNVERIFIED — large]', verifiedAt: null },
  },
};

test('eval routing › routeModel with allowUnverified=true returns modelId', () => {
  const route = routeModel('tiny', UNVERIFIED_POLICY, { allowUnverified: true });
  assert.equal(route.budgetClass, 'tiny');
  assert.equal(route.modelId, '[UNVERIFIED — tiny]');
  assert.equal(route.verified, false);
});

test('eval routing › unverified entry throws correct message', () => {
  assert.throws(
    () => routeModel('large', UNVERIFIED_POLICY),
    /Model ID for large is \[UNVERIFIED\]\. Set verifiedAt before routing in production\./
  );
});

test('eval routing › baseline guard blocks change without baseline file', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'eval-routing-'));
  await assert.rejects(
    assertEvalBaselineExists('standard', evalsDir),
    /No eval baseline for standard/
  );
});

test('eval routing › baseline guard resolves once baseline exists', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'eval-routing-ok-'));
  const dir = join(evalsDir, 'model-routing');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'baseline-standard.json'), '{}', 'utf8');
  await assertEvalBaselineExists('standard', evalsDir);
  assert.ok(true);
});

// E9-22: the guard must also pass against the REAL committed baselines, not
// only tmpdir fixtures.
test('eval routing › committed baselines satisfy assertEvalBaselineExists for every class', async () => {
  const repoEvalsDir = join(import.meta.dirname, '..');
  for (const budgetClass of /** @type {const} */ (['tiny', 'standard', 'large'])) {
    await assertEvalBaselineExists(budgetClass, repoEvalsDir);
  }
});
