// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  waitForCompletionSignal,
  SENTINEL_FILENAME,
} from '../../../lib/worktree/signals.mjs';

/**
 * Build a minimal handle pointing at a real temp worktree directory.
 * @param {string} worktreePath
 * @returns {import('../../../lib/types.mjs').WorktreeHandle}
 */
function makeHandle(worktreePath) {
  return {
    branchName: 'devmate/signal',
    worktreePath,
    baseRef: 'main',
    createdAt: new Date().toISOString(),
    active: true,
    repoRoot: worktreePath,
  };
}

test('signals › resolves signalReceived=true when sentinel file written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-sig-'));
  try {
    const handle = makeHandle(dir);
    // Write the sentinel shortly after starting the wait.
    setTimeout(() => {
      writeFileSync(resolve(dir, SENTINEL_FILENAME), 'done\n', 'utf8');
    }, 150);
    const result = await waitForCompletionSignal(handle, { timeoutMs: 3000, pollMs: 50 });
    assert.equal(result.signalReceived, true);
    assert.notEqual(result.timedOut, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signals › resolves timedOut=true after deadline without signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-sig-'));
  try {
    const handle = makeHandle(dir);
    const result = await waitForCompletionSignal(handle, { timeoutMs: 200, pollMs: 50 });
    assert.equal(result.signalReceived, false);
    assert.equal(result.timedOut, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signals › no busy-wait (setTimeout-based polling)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-sig-'));
  try {
    const handle = makeHandle(dir);
    // With a 100ms poll over a 250ms window the loop should iterate only a few
    // times — a busy loop would spin thousands of times. We assert the call
    // takes roughly the timeout window (proves it is sleeping, not spinning).
    const start = Date.now();
    const result = await waitForCompletionSignal(handle, { timeoutMs: 250, pollMs: 100 });
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed >= 200, `elapsed ${elapsed}ms should be near the timeout window`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
