// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHandoff } from '../../../lib/handoff/capture-handoff.mjs';
import { handoffTaskDir } from '../../../lib/handoff/write-handoff.mjs';

/**
 * @param {{ taskId?: string, workflowGate?: string, withState?: boolean }} [opts]
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capture-handoff-'));
  mkdirSync(join(root, '.devmate', 'state', 'trace'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'state', 'handoff'), { recursive: true });
  if (opts.withState !== false) {
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId: opts.taskId ?? 'feat-1',
        lane: 'feature',
        workflowGate: opts.workflowGate ?? 'impl-started',
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

test('captureHandoff writes a handoff for an in-progress task', async () => {
  const { root, cleanup } = makeRoot({ taskId: 'feat-1' });
  try {
    /** @type {string[]} */
    const warnings = [];
    const result = await captureHandoff(root, { warn: (m) => warnings.push(m) });

    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(warnings.length, 0);
    const dir = join(root, handoffTaskDir('feat-1'));
    assert.equal(existsSync(join(dir, 'handoff.json')), true);
    assert.equal(existsSync(join(dir, 'handoff.md')), true);
  } finally {
    cleanup();
  }
});

test('captureHandoff skips silently when there is no active task', async () => {
  const { root, cleanup } = makeRoot({ withState: false });
  try {
    /** @type {string[]} */
    const warnings = [];
    const result = await captureHandoff(root, { warn: (m) => warnings.push(m) });
    assert.equal(result.ok, true);
    assert.equal(result.written, false);
    assert.equal(result.skipped, 'no_task');
    assert.equal(warnings.length, 0);
  } finally {
    cleanup();
  }
});

test('captureHandoff skips a completed task (workflowGate=done)', async () => {
  const { root, cleanup } = makeRoot({ workflowGate: 'done' });
  try {
    const result = await captureHandoff(root, {});
    assert.equal(result.ok, true);
    assert.equal(result.written, false);
    assert.equal(result.skipped, 'complete');
  } finally {
    cleanup();
  }
});

test('captureHandoff surfaces a warning when task.json is unreadable', async () => {
  const { root, cleanup } = makeRoot({ withState: false });
  try {
    writeFileSync(join(root, '.devmate', 'state', 'task.json'), '{ not json', 'utf8');
    /** @type {string[]} */
    const warnings = [];
    const result = await captureHandoff(root, { warn: (m) => warnings.push(m) });
    assert.equal(result.written, false);
    assert.equal(result.skipped, 'unreadable_state');
    assert.equal(warnings.some((w) => w.includes('handoff skipped (non-fatal)')), true);
  } finally {
    cleanup();
  }
});
