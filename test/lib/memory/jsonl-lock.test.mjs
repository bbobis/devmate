// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, LockTimeoutError } from '../../../lib/memory/jsonl-lock.mjs';

/**
 * Create a temp dir and ledger path for each test.
 * @returns {{ dir: string, ledger: string, cleanup: () => void }}
 */
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-lock-test-'));
  const ledger = join(dir, 'test.jsonl');
  return { dir, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('acquireLock — happy path: returns LockHandle; sentinel exists; release removes it', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    const handle = await acquireLock(ledger);
    assert.equal(typeof handle.lockPath, 'string');
    assert.ok(handle.lockPath.endsWith('.lock'));
    assert.ok(existsSync(handle.lockPath), 'sentinel should exist while lock held');
    await releaseLock(handle);
    assert.ok(!existsSync(handle.lockPath), 'sentinel should be removed after release');
  } finally {
    cleanup();
  }
});

test('acquireLock — second caller blocks then succeeds after first releases', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    const handleA = await acquireLock(ledger);
    let bAcquired = false;
    // Start B immediately; it will poll until A releases.
    const promiseB = acquireLock(ledger, { timeoutMs: 3000, retryIntervalMs: 20 }).then((h) => {
      bAcquired = true;
      return h;
    });
    // Give B a tick to attempt and block.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(bAcquired, false, 'B should not have acquired yet');
    await releaseLock(handleA);
    const handleB = await promiseB;
    assert.ok(bAcquired, 'B should have acquired after A released');
    await releaseLock(handleB);
  } finally {
    cleanup();
  }
});

test('acquireLock — timeout: held lock causes LockTimeoutError; ledger gets lock_timeout entry', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    // Hold the lock by keeping sentinel in place (never release).
    const handleA = await acquireLock(ledger);
    let caught = /** @type {unknown} */ (null);
    try {
      await acquireLock(ledger, { timeoutMs: 150, retryIntervalMs: 20 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof LockTimeoutError, 'should throw LockTimeoutError');
    // Ledger should contain a lock_timeout entry.
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.event, 'lock_timeout');
    assert.equal(entry.ledgerPath, ledger);
    // Clean up sentinel manually.
    await releaseLock(handleA);
  } finally {
    cleanup();
  }
});

test('releaseLock — idempotent: calling twice does not throw', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    const handle = await acquireLock(ledger);
    await releaseLock(handle);
    // Second call should be silent (ENOENT ignored).
    await assert.doesNotReject(() => releaseLock(handle));
  } finally {
    cleanup();
  }
});
