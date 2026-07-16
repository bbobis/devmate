// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDelegationAdvisory,
  INLINE_RISK_GATES,
} from '../../../lib/orchestrator/delegation-advisory.mjs';

/**
 * @param {Record<string, unknown>|null} taskState
 * @param {Array<Record<string, unknown>>|null} traceLines
 */
function makeRoot(taskState, traceLines) {
  const root = mkdtempSync(join(tmpdir(), 'deleg-advisory-'));
  const stateDir = join(root, '.devmate', 'state');
  mkdirSync(join(stateDir, 'trace'), { recursive: true });
  if (taskState) {
    writeFileSync(join(stateDir, 'task.json'), JSON.stringify(taskState), 'utf8');
  }
  if (traceLines && taskState) {
    writeFileSync(
      join(stateDir, 'trace', `${taskState.taskId}.jsonl`),
      traceLines.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {Partial<Record<string, unknown>>} [over]
 * @returns {Record<string, unknown>}
 */
function taskState(over) {
  return {
    taskId: 'feat-1',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {string} a
 * @returns {Record<string, unknown>}
 */
function startEvent(a) {
  return {
    type: 'subagent_start',
    stepId: `subagent-${a}`,
    taskId: 'feat-1',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    agentName: a,
    persona: a,
    activeCount: 1,
  };
}

test('advisory / no task.json → null', async () => {
  const { root, cleanup } = makeRoot(null, null);
  try {
    assert.equal(await loadDelegationAdvisory(root), null);
  } finally {
    cleanup();
  }
});

test('advisory / impl-started with zero dispatches → inlineLikely', async () => {
  const { root, cleanup } = makeRoot(taskState(), null);
  try {
    const a = await loadDelegationAdvisory(root);
    assert.ok(a);
    assert.equal(a.inlineLikely, true);
    assert.equal(a.workflowGate, 'impl-started');
    assert.equal(a.totalDispatches, 0);
  } finally {
    cleanup();
  }
});

test('advisory / impl-started WITH a dispatch → not inlineLikely', async () => {
  const { root, cleanup } = makeRoot(taskState(), [startEvent('discovery')]);
  try {
    const a = await loadDelegationAdvisory(root);
    assert.ok(a);
    assert.equal(a.inlineLikely, false);
    assert.equal(a.totalDispatches, 1);
  } finally {
    cleanup();
  }
});

test('advisory / terminal done gate is never flagged', async () => {
  const { root, cleanup } = makeRoot(taskState({ workflowGate: 'done' }), null);
  try {
    const a = await loadDelegationAdvisory(root);
    assert.ok(a);
    assert.equal(a.inlineLikely, false);
  } finally {
    cleanup();
  }
});

test('advisory / pre-analysis gate (plan-approved) is not flagged', async () => {
  const { root, cleanup } = makeRoot(taskState({ workflowGate: 'plan-approved' }), null);
  try {
    const a = await loadDelegationAdvisory(root);
    assert.ok(a);
    assert.equal(a.inlineLikely, false);
  } finally {
    cleanup();
  }
});

test('advisory / INLINE_RISK_GATES excludes terminal and pre-analysis gates', () => {
  for (const g of ['done', 'parked', 'abandoned', 'plan-approved', 'lane-set']) {
    assert.equal(INLINE_RISK_GATES.includes(g), false, `${g} must not be an inline-risk gate`);
  }
  assert.ok(INLINE_RISK_GATES.includes('impl-started'));
});
