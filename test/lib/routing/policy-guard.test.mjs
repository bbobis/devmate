// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertEvalBaselineExists,
  assertRoleEvalBaselineExists,
  assertRoleRouteAllowed,
} from '../../../lib/routing/policy-guard.mjs';

test('policy-guard › assertEvalBaselineExists throws when file absent', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-empty-'));
  await assert.rejects(
    assertEvalBaselineExists('large', evalsDir),
    /No eval baseline for large\. Run eval comparison before changing the default\./
  );
});

test('policy-guard › assertEvalBaselineExists resolves when file present', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-present-'));
  const dir = join(evalsDir, 'model-routing');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'baseline-tiny.json'), '{}', 'utf8');
  // Should not throw.
  await assertEvalBaselineExists('tiny', evalsDir);
  assert.ok(true);
});

// ---- FO-7: role-route baseline gating ----

test('policy-guard › assertRoleEvalBaselineExists throws when role baseline absent', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-empty-'));
  await assert.rejects(
    assertRoleEvalBaselineExists('discoveryWorker', evalsDir),
    /No eval baseline for role discoveryWorker\. Run eval comparison before changing the default\./
  );
});

test('policy-guard › assertRoleEvalBaselineExists resolves on baseline-discovery-worker.json', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-present-'));
  const dir = join(evalsDir, 'model-routing');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'baseline-discovery-worker.json'), '{}', 'utf8');
  // Should not throw.
  await assertRoleEvalBaselineExists('discoveryWorker', evalsDir);
  assert.ok(true);
});

test('policy-guard › assertRoleEvalBaselineExists fails closed on an unknown role', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-unknown-'));
  await assert.rejects(
    assertRoleEvalBaselineExists(
      /** @type {import('../../../lib/types.mjs').ModelRole} */ (/** @type {unknown} */ ('fixerWorker')),
      evalsDir
    ),
    /No baseline slug registered for role fixerWorker\. Unknown roles cannot be honored\./
  );
});

test('policy-guard › assertRoleRouteAllowed passes an advisory (unverified) role route through', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-advisory-'));
  // No baseline anywhere — an advisory route must still pass.
  await assertRoleRouteAllowed(
    { role: 'discoveryWorker', modelId: '[UNVERIFIED — x]', verified: false },
    evalsDir
  );
  assert.ok(true);
});

test('policy-guard › assertRoleRouteAllowed blocks a verified role route without a baseline', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-blocked-'));
  await assert.rejects(
    assertRoleRouteAllowed(
      { role: 'discoveryWorker', modelId: 'real-worker-model', verified: true },
      evalsDir
    ),
    /No eval baseline for role discoveryWorker/
  );
});

test('policy-guard › assertRoleRouteAllowed honors a verified role route with a committed baseline', async () => {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'evals-role-honored-'));
  const dir = join(evalsDir, 'model-routing');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'baseline-discovery-worker.json'), '{}', 'utf8');
  await assertRoleRouteAllowed(
    { role: 'discoveryWorker', modelId: 'real-worker-model', verified: true },
    evalsDir
  );
  assert.ok(true);
});
