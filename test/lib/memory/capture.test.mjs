// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMemory } from '../../../lib/memory/capture.mjs';
import {
  memoryMdPath,
  repoLedgerPath,
  taskLedgerPath,
} from '../../../lib/memory/paths.mjs';

/**
 * @param {string|null} taskId  null → no task.json at all.
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot(taskId) {
  const root = mkdtempSync(join(tmpdir(), 'capture-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  if (taskId !== null) {
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId,
        lane: 'feature',
        workflowGate: 'done',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 1,
        budget: 10,
        schemaVersion: 1,
        outputContract: { done_when: 'x' },
      }),
      'utf8',
    );
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {Partial<import('../../../lib/types.mjs').FactEntry>} over
 * @returns {string}
 */
function factLine(over) {
  return `${JSON.stringify({
    event: 'fact',
    key: 'lib/a.mjs:1',
    source: 'lib/a.mjs',
    tool: 'write_file',
    lane: 'feature',
    tags: [],
    summary: 'edited a',
    confidence: 0.8,
    ts: 1000,
    stepId: '1',
    firstEdit: true,
    ...over,
  })}\n`;
}

test('captureMemory promotes the task ledger then renders MEMORY.md', async () => {
  const { root, cleanup } = makeRoot('task-1');
  try {
    writeFileSync(taskLedgerPath(root, 'task-1'), factLine({}), 'utf8');
    /** @type {string[]} */
    const warnings = [];
    const result = await captureMemory(root, { warn: (m) => warnings.push(m) });

    assert.equal(result.ok, true);
    assert.equal(result.promoted, 1);
    assert.equal(result.rendered, true);
    assert.equal(warnings.length, 0);
    assert.equal(readFileSync(repoLedgerPath(root), 'utf8').includes('lib/a.mjs'), true);
    assert.equal(readFileSync(memoryMdPath(root), 'utf8').includes('## lib/a.mjs'), true);
    // Task ledger consumed on success.
    assert.equal(existsSync(taskLedgerPath(root, 'task-1')), false);
  } finally {
    cleanup();
  }
});

test('captureMemory renders even with no active task (no task.json)', async () => {
  const { root, cleanup } = makeRoot(null);
  try {
    writeFileSync(repoLedgerPath(root), factLine({ source: 'lib/b.mjs', key: 'lib/b.mjs:1' }), 'utf8');
    /** @type {string[]} */
    const warnings = [];
    const result = await captureMemory(root, { warn: (m) => warnings.push(m) });

    assert.equal(result.ok, true);
    assert.equal(result.promoted, 0);
    // No task.json means no active task — a silent, legitimate skip.
    assert.equal(warnings.length, 0);
    assert.equal(readFileSync(memoryMdPath(root), 'utf8').includes('## lib/b.mjs'), true);
  } finally {
    cleanup();
  }
});

test('captureMemory surfaces a warning when task.json exists but is unreadable', async () => {
  const { root, cleanup } = makeRoot(null);
  try {
    // A task.json that exists but is not valid TaskState must not be silent.
    writeFileSync(join(root, '.devmate', 'state', 'task.json'), '{ not valid json', 'utf8');
    /** @type {string[]} */
    const warnings = [];
    const result = await captureMemory(root, { warn: (m) => warnings.push(m) });

    assert.equal(result.ok, true); // render still runs
    assert.equal(
      warnings.some((w) => w.includes('promote skipped (non-fatal)')),
      true,
      'unreadable state must surface a warning, not strand facts silently',
    );
  } finally {
    cleanup();
  }
});
