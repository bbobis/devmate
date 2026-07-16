// @ts-check
/**
 * E5-4 regression: Tier 5 E2E must block until the backend-ready gate is
 * satisfied. A not-ready backend blocks; a satisfied backend passes; a stale
 * gate throws immediately (forcing a re-check).
 * Reconciled to real API: assertBackendReadyBeforeTier5(state, predicates, opts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertBackendReadyBeforeTier5 } from '../../lib/workflow/backend-ready.mjs';
import { makeTmpDir, cleanup } from './_helpers.mjs';

/**
 * Minimal valid TaskState for gate tests.
 * @param {Partial<import('../../lib/types.mjs').TaskState>} [over]
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: 'task-tier5-001',
    lane: 'feature',
    workflowGate: 'verification-passed',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

/** @param {string} dir @returns {{ statePath: string, transitionsPath: string }} */
function opts(dir) {
  return { statePath: join(dir, 'state.json'), transitionsPath: join(dir, 'transitions.jsonl') };
}

test('tier5-gate › absent backend-ready gate → blocked', async () => {
  const dir = makeTmpDir('reg-tier5-');
  try {
    // Unreachable backend → not ready → blocked (throws).
    const predicates = [{ url: 'http://127.0.0.1:1/health', timeoutMs: 100 }];
    await assert.rejects(
      () => assertBackendReadyBeforeTier5(makeState(), predicates, opts(dir)),
      /backend not ready|not ready/i
    );
  } finally {
    cleanup(dir);
  }
});

test('tier5-gate › present backend-ready gate → passes', async () => {
  const dir = makeTmpDir('reg-tier5-');
  try {
    // No predicates declared = backend ready (skip) → passes.
    const result = await assertBackendReadyBeforeTier5(makeState(), [], opts(dir));
    assert.equal(result.ready, true);
  } finally {
    cleanup(dir);
  }
});

test('tier5-gate › stale gate triggers re-check', async () => {
  const dir = makeTmpDir('reg-tier5-');
  try {
    // A stale gate throws immediately without probing — forcing a re-check.
    const stale = makeState({ backendReadyStaleSince: new Date().toISOString() });
    await assert.rejects(
      () => assertBackendReadyBeforeTier5(stale, [], opts(dir)),
      /stale/i
    );
  } finally {
    cleanup(dir);
  }
});
