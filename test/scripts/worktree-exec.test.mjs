// @ts-check
/**
 * E8-3: tests for the worktree-exec guarded entrypoint. Verifies the DoD that
 * the worktree is ALWAYS torn down — including on error paths — so we never
 * leave orphaned worktrees behind. Dependencies are injected so failures are
 * deterministic and no real git operations are needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../scripts/worktree-exec.mjs';
import { SENTINEL_FILENAME } from '../../lib/worktree/signals.mjs';

/** @typedef {import('../../lib/types.mjs').WorktreeHandle} WorktreeHandle */

/**
 * Build a fake handle.
 * @param {string} branch
 * @returns {WorktreeHandle}
 */
function fakeHandle(branch) {
  return {
    branchName: branch,
    worktreePath: `/tmp/${branch}`,
    baseRef: 'main',
    createdAt: new Date().toISOString(),
    active: true,
    repoRoot: '/tmp',
  };
}

test('worktree-exec › teardown called on main() error path', async () => {
  let teardownCalls = 0;
  const handle = fakeHandle('devmate/exec-err');

  const code = await main(
    ['--branch', 'devmate/exec-err', '--worktree-path', '/tmp/x', '--timeout', '50'],
    {
      createIsolatedWorktree: async () => handle,
      waitForCompletionSignal: async () => ({ signalReceived: true }),
      // Simulate a failure AFTER the worktree exists.
      extractDiff: async () => {
        throw new Error('boom: simulated diff failure');
      },
      recordWorktreeTelemetry: async () => {},
      teardownWorktree: async (h) => {
        teardownCalls += 1;
        h.active = false;
      },
    }
  );

  assert.equal(code, 1, 'error path returns non-zero');
  assert.equal(teardownCalls, 1, 'teardown called exactly once on error path');
  assert.equal(handle.active, false, 'handle marked inactive after teardown');
});

test('worktree-exec › teardown called on the happy path too', async () => {
  let teardownCalls = 0;
  const handle = fakeHandle('devmate/exec-ok');

  const code = await main(
    ['--branch', 'devmate/exec-ok', '--worktree-path', '/tmp/y', '--timeout', '50'],
    {
      createIsolatedWorktree: async () => handle,
      waitForCompletionSignal: async () => ({ signalReceived: true }),
      extractDiff: async () => ({
        diffText: 'diff',
        artifactPath: '/tmp/y.diff',
        filesChanged: 1,
        insertions: 2,
        deletions: 0,
      }),
      recordWorktreeTelemetry: async () => {},
      teardownWorktree: async (h) => {
        teardownCalls += 1;
        h.active = false;
      },
    }
  );

  assert.equal(code, 0, 'happy path returns 0');
  assert.equal(teardownCalls, 1, 'teardown called on success');
});

test('worktree-exec › returns 1 on missing required args', async () => {
  const code = await main(['--base-ref', 'main']);
  assert.equal(code, 1);
});

test('worktree-exec › sentinel filename is the documented value', async () => {
  assert.equal(SENTINEL_FILENAME, '.devmate-complete');
});
