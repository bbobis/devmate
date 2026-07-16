// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertSecurityAgentAvailable } from '../lib/workflow/agents/security.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';
import { runBugLane } from '../lib/workflow/lanes/bug.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeBugState(over = {}) {
  return {
    taskId: 'missing-agent-1',
    lane: 'bug',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
    ...over,
  };
}

test('required security path halts loudly when security agent file is missing', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'missing-security-agent-'));
  try {
    mkdirSync(join(repoRoot, 'agents'), { recursive: true });

    const guard = assertSecurityAgentAvailable(repoRoot);
    assert.equal(guard.ok, false);
    const message = guard.error ?? '';
    assert.match(message, /security\.agent\.md/i);
    assert.equal(message.includes(repoRoot), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dispatch contract guard halts loudly on unresolved required agent output', () => {
  const verdicts = [
    assertDispatchResult('planner', null),
    assertDispatchResult('planner', undefined),
    assertDispatchResult('planner', {}),
  ];

  for (const verdict of verdicts) {
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? '', /planner|empty|missing|invalid|status/i);
  }
});

test('bug lane halts with user-visible summary when diagnosis is missing', async () => {
  const result = await runBugLane('Repro without diagnosis', makeBugState());
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /no diagnosis provided/i);
});
