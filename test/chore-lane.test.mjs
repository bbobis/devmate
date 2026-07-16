// @ts-check

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runChoreLane } from '../lib/workflow/lanes/chore.mjs';
import { createMockExecutor, assertCallOrder, assertNoCalls } from '../lib/test-utils/mock-executor.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: 'chore-lane-1',
    lane: 'chore',
    workflowGate: 'plan-approved',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
    ...over,
  };
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'chore-lane-test-'));
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  mkdirSync(resolve(root, '.devmate', 'session'), { recursive: true });

  writeFileSync(
    resolve(root, '.devmate', 'devmate.config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        personas: [
          {
            persona: 'editor',
            editableGlobs: ['docs/**', '*.md', '*.json', 'scripts/**'],
            offLimitsGlobs: ['src/main/**', 'lib/workflow/**'],
            instructionFile: null,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const statePath = resolve(root, '.devmate', 'state', 'task.json');
  writeFileSync(statePath, JSON.stringify(makeState(), null, 2), 'utf8');

  return {
    root,
    statePath,
    transitionsPath: resolve(root, '.devmate', 'state', 'transitions.jsonl'),
    traceFile: resolve(root, '.devmate', 'state', 'trace.jsonl'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('chore lane runs scope-limited workflow and verifies', async () => {
  const ws = makeWorkspace();
  const { executor, getCallLog } = createMockExecutor({
    agents: ['fullstack', 'verify'],
    stubResults: {
      fullstack: {
        status: 'ok',
        agentName: 'fullstack',
        payload: { summary: 'docs updated' },
      },
      verify: { passed: true, summary: 'verify passed' },
    },
  });

  try {
    const result = await runChoreLane('Refresh docs', makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ['docs/README.md', 'CHANGELOG.md'],
      dispatch: async (input) => {
        return /** @type {import('../lib/workflow/orchestrator.mjs').DispatchResult} */ (executor.dispatch({
          agent: input.agent,
          persona: input.persona,
          scopePath: input.scopePath,
          choreDescription: input.choreDescription,
        }));
      },
      verify: async () => {
        executor.invoke('verify', { step: 'post-dispatch' });
        return { passed: true, summary: 'verify passed' };
      },
    });

    assert.deepEqual(result, { status: 'verified', summary: 'verify passed' });
    assertCallOrder(getCallLog(), ['fullstack', 'verify']);

    const onDisk = JSON.parse(readFileSync(ws.statePath, 'utf8'));
    assert.equal(onDisk.workflowGate, 'verification-passed');
  } finally {
    ws.cleanup();
  }
});

test('chore lane escalates and does not dispatch when proposed files exceed editor scope', async () => {
  const ws = makeWorkspace();
  const { executor, getCallLog } = createMockExecutor({
    agents: ['fullstack'],
    stubResults: {
      fullstack: {
        status: 'ok',
        agentName: 'fullstack',
        payload: { summary: 'should not run' },
      },
    },
  });

  try {
    const result = await runChoreLane('Touch core workflow', makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ['lib/workflow/orchestrator.mjs'],
      dispatch: async (input) => {
        return /** @type {import('../lib/workflow/orchestrator.mjs').DispatchResult} */ (executor.dispatch({
          agent: input.agent,
          persona: input.persona,
          scopePath: input.scopePath,
          choreDescription: input.choreDescription,
        }));
      },
    });

    assert.equal(result.status, 'escalated');
    assert.match(result.summary, /Escalated chore to feature/i);
    assertNoCalls(getCallLog(), ['fullstack']);
  } finally {
    ws.cleanup();
  }
});
