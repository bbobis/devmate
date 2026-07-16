// @ts-check
/**
 * E6-1/E6-2 regression: the trace reader must degrade gracefully on truncated
 * or corrupt JSONL lines — returning only valid entries and reporting a
 * malformedCount > 0, never throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readTrace } from '../../lib/trace/read-trace.mjs';
import { makeTmpDir, cleanup, writeRawLines } from './_helpers.mjs';

const TASK = 'task-malformed-001';

/**
 * Build a valid step_complete JSONL line for the given stepId.
 * @param {string} stepId
 * @param {string} label
 * @returns {string}
 */
function validLine(stepId, label) {
  return JSON.stringify({
    schemaVersion: 1,
    type: 'step_complete',
    stepId,
    taskId: TASK,
    ts: new Date().toISOString(),
    label,
    artifactPaths: [],
  });
}

test('malformed-jsonl › reader returns only valid entries', async () => {
  const dir = makeTmpDir('reg-malformed-');
  try {
    writeRawLines(join(dir, `${TASK}.jsonl`), [
      validLine('step-1', 'first'),
      '{"type":"step_complete","stepId":"trunc', // truncated JSON
      validLine('step-2', 'second'),
      'not json at all',
    ]);
    const { steps } = await readTrace(TASK, { traceDir: dir });
    assert.equal(steps.length, 2, 'only the two valid steps are returned');
    assert.deepEqual(steps.map((s) => s.stepId).sort(), ['step-1', 'step-2']);
  } finally {
    cleanup(dir);
  }
});

test('malformed-jsonl › malformedCount > 0 in result', async () => {
  const dir = makeTmpDir('reg-malformed-');
  try {
    writeRawLines(join(dir, `${TASK}.jsonl`), [
      validLine('step-1', 'first'),
      '{"broken":', // malformed
      '}{', // malformed
    ]);
    const { summary } = await readTrace(TASK, { traceDir: dir });
    assert.ok(summary.malformedCount > 0, 'malformedCount reflects corrupt lines');
    assert.equal(summary.malformedCount, 2);
  } finally {
    cleanup(dir);
  }
});
