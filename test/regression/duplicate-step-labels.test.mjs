// @ts-check
/**
 * E6-2 regression: read-trace uses stable stepId identity. Two step_complete
 * entries sharing the same label but different stepIds must remain distinct
 * (never merged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readTrace } from '../../lib/trace/read-trace.mjs';
import { makeTmpDir, cleanup, writeJsonl } from './_helpers.mjs';

const TASK = 'task-duplabel-001';

/**
 * Build a valid step_complete event object.
 * @param {string} stepId
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function stepComplete(stepId, label) {
  return {
    schemaVersion: 1,
    type: 'step_complete',
    stepId,
    taskId: TASK,
    ts: new Date().toISOString(),
    label,
    artifactPaths: [],
  };
}

test('duplicate-step-labels › same label, different stepId → two distinct entries', async () => {
  const dir = makeTmpDir('reg-duplabel-');
  try {
    // Same human label "run tests", two different stable stepIds.
    writeJsonl(join(dir, `${TASK}.jsonl`), [
      stepComplete('step-aaa', 'run tests'),
      stepComplete('step-bbb', 'run tests'),
    ]);

    const { steps } = await readTrace(TASK, { traceDir: dir });
    assert.equal(steps.length, 2, 'two steps tracked despite identical labels');

    const ids = steps.map((s) => s.stepId).sort();
    assert.deepEqual(ids, ['step-aaa', 'step-bbb'], 'distinct stepIds preserved');

    // Both carry the same label — proving identity is stepId, not label.
    assert.ok(steps.every((s) => s.label === 'run tests'));
  } finally {
    cleanup(dir);
  }
});
