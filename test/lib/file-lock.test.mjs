// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, LOCK_SUFFIX } from '../../lib/file-lock.mjs';

/**
 * Create a fresh temp directory for a test. Returns the dir path.
 * @returns {string}
 */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'devmate-lock-test-'));
}

test('withFileLock › sequential calls on the same path succeed in order', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json' + LOCK_SUFFIX);
  const results = /** @type {number[]} */ ([]);

  const r1 = await withFileLock(lockPath, async () => {
    results.push(1);
    return 'a';
  });
  const r2 = await withFileLock(lockPath, async () => {
    results.push(2);
    return 'b';
  });

  assert.equal(r1.acquired, true);
  assert.equal(r2.acquired, true);
  assert.deepEqual(results, [1, 2]);

  rmSync(dir, { recursive: true, force: true });
});

test('withFileLock › two concurrent calls: both complete, only one holds at a time', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json' + LOCK_SUFFIX);
  const order = /** @type {string[]} */ ([]);

  // Both race to acquire the same lock.
  const [r1, r2] = await Promise.all([
    withFileLock(lockPath, async () => {
      order.push('start-1');
      // Yield to let the other coroutine attempt to acquire.
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('end-1');
      return 1;
    }, { retryIntervalMs: 5 }),
    withFileLock(lockPath, async () => {
      order.push('start-2');
      order.push('end-2');
      return 2;
    }, { retryIntervalMs: 5 }),
  ]);

  assert.equal(r1.acquired, true);
  assert.equal(r2.acquired, true);
  // end-1 must appear before start-2 — the second caller must wait.
  const idx_end1 = order.indexOf('end-1');
  const idx_start2 = order.indexOf('start-2');
  assert.ok(idx_end1 < idx_start2, `Expected end-1 (${idx_end1}) before start-2 (${idx_start2}). order=${JSON.stringify(order)}`);

  rmSync(dir, { recursive: true, force: true });
});

test('withFileLock › fn throws → lock file removed, error re-thrown', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json' + LOCK_SUFFIX);

  await assert.rejects(
    () => withFileLock(lockPath, () => { throw new Error('boom'); }),
    /boom/
  );

  // Lock file should be removed after fn throws.
  assert.equal(existsSync(lockPath), false, 'lock file should be removed after fn throws');

  rmSync(dir, { recursive: true, force: true });
});

test('withFileLock › timeout exceeded → { acquired: false, error } containing lock path', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json' + LOCK_SUFFIX);

  // Pre-place the lock file to simulate a process that already holds it.
  writeFileSync(lockPath, '{"owner":"test-blocker"}', 'utf8');

  const result = await withFileLock(lockPath, () => {}, { timeoutMs: 100, retryIntervalMs: 20 });

  assert.equal(result.acquired, false);
  assert.ok('error' in result && typeof result.error === 'string', 'error should be a string');
  if ('error' in result) {
    assert.ok(result.error.includes(lockPath), `error should mention lockPath, got: ${result.error}`);
    assert.ok(result.error.toLowerCase().includes('timeout'), `error should mention timeout, got: ${result.error}`);
  }

  // Cleanup.
  rmSync(lockPath, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('withFileLock › lock file leftover from crashed process → times out correctly, does not hang', async () => {
  const dir = makeTmpDir();
  const lockPath = join(dir, 'state.json' + LOCK_SUFFIX);

  // Simulate a crashed process by pre-placing a lock file.
  writeFileSync(lockPath, '{"owner":"crashed-pid","ts":"2020-01-01T00:00:00.000Z"}', 'utf8');

  const start = Date.now();
  const result = await withFileLock(lockPath, () => {}, { timeoutMs: 150, retryIntervalMs: 30 });
  const elapsed = Date.now() - start;

  assert.equal(result.acquired, false);
  // Should not hang significantly beyond the timeout.
  assert.ok(elapsed < 1000, `Should time out quickly, elapsed: ${elapsed}ms`);

  // Cleanup.
  rmSync(lockPath, { force: true });
  rmSync(dir, { recursive: true, force: true });
});
