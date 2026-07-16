// @ts-check
/**
 * E8-1: tests for the orchestrator worker-contract surface. It re-exports the
 * E4-8 validator (#38); these tests confirm the orchestrator import path works
 * and the contract behaves as expected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerReturn } from '../../../lib/orchestrator/worker-contract.mjs';

/** @typedef {import('../../../lib/types.mjs').WorkerReturn} WorkerReturn */

/**
 * Build a fully valid WorkerReturn fixture.
 * @param {Partial<WorkerReturn>} [over]
 * @returns {WorkerReturn}
 */
function makeReturn(over = {}) {
  /** @type {WorkerReturn} */
  const base = {
    workerId: 'w1',
    finding: 'Found the config loader.',
    sourcePointer: {
      path: 'lib/config.mjs',
      lineRange: null,
      reason: 'defines the loader',
      confidence: 0.9,
      freshness: '2026-06-24T00:00:00.000Z',
      kind: 'file',
    },
    confidence: 0.8,
    artifactWritten: null,
    nextRecommendedStep: 'Wire the loader into startup.',
    tokenNotes: 'Loaded 1 slice, ~300 tokens',
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: '2026-06-24T00:00:01.000Z',
  };
  return { ...base, ...over };
}

test('worker-contract › valid return → ok=true', () => {
  const { ok, errors } = validateWorkerReturn(makeReturn());
  assert.equal(ok, true, errors.join('; '));
});

test('worker-contract › missing finding → error', () => {
  const bad = makeReturn();
  // @ts-expect-error intentionally drop a required field
  delete bad.finding;
  const { ok, errors } = validateWorkerReturn(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /finding/.test(e)));
});

test('worker-contract › confidence=1.1 → error', () => {
  const { ok, errors } = validateWorkerReturn(makeReturn({ confidence: 1.1 }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /confidence/.test(e)));
});
