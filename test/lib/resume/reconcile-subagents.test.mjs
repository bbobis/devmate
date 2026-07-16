// @ts-check
/**
 * DN-6: pure decision tests for reconcileActiveSubagents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileActiveSubagents } from '../../../lib/resume/reconcile-subagents.mjs';

/**
 * @param {Partial<import('../../../lib/types.mjs').TaskState>} overrides
 * @returns {import('../../../lib/types.mjs').TaskState}
 */
function makeTaskState(overrides = {}) {
  return /** @type {import('../../../lib/types.mjs').TaskState} */ ({
    taskId: 't-1',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  });
}

test('activeSubagents > 0 -> needed with previous value', () => {
  const result = reconcileActiveSubagents({ taskState: makeTaskState({ activeSubagents: 2 }) });
  assert.deepEqual(result, { needed: true, previous: 2, previousAgents: 0 });
});

test('activeSubagents === 0 -> not needed', () => {
  const result = reconcileActiveSubagents({ taskState: makeTaskState({ activeSubagents: 0 }) });
  assert.deepEqual(result, { needed: false, previous: 0, previousAgents: 0 });
});

test('activeSubagents absent -> not needed, previous 0', () => {
  const result = reconcileActiveSubagents({ taskState: makeTaskState() });
  assert.deepEqual(result, { needed: false, previous: 0, previousAgents: 0 });
});

test('taskState null (no task.json) -> not needed, previous 0', () => {
  const result = reconcileActiveSubagents({ taskState: null });
  assert.deepEqual(result, { needed: false, previous: 0, previousAgents: 0 });
});

// #93: the in-flight agent roster is reconciled with the counter. A leaked entry
// is an identity a dead sub-agent left behind — and identity is what authorizes a
// session-artifact write.
test('activeAgents non-empty with a zero counter -> still needed', () => {
  const result = reconcileActiveSubagents({
    taskState: makeTaskState({
      activeSubagents: 0,
      activeAgents: [{ agentName: 'spec-writer', agentId: 'a1' }],
    }),
  });
  assert.deepEqual(result, { needed: true, previous: 0, previousAgents: 1 });
});
