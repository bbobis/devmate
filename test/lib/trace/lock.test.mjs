// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAppendLock } from '../../../lib/trace/lock.mjs';

test('5 concurrent calls on the same path run FIFO and all complete', async () => {
  const key = 'lock-test-a';
  /** @type {number[]} */
  const order = [];

  /**
   * Make a critical-section fn that records its index when it actually runs.
   * A small async delay makes interleaving observable if the lock were broken.
   * @param {number} i
   * @returns {() => Promise<number>}
   */
  const makeFn = (i) => async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(i);
    return i;
  };

  // Kick off 5 calls synchronously so they all contend for the same key.
  const results = await Promise.all([
    withAppendLock(key, makeFn(0)),
    withAppendLock(key, makeFn(1)),
    withAppendLock(key, makeFn(2)),
    withAppendLock(key, makeFn(3)),
    withAppendLock(key, makeFn(4)),
  ]);

  // All 5 fns ran and returned their own value.
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  // And they ran strictly in submission order (FIFO).
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('different paths run independently (no cross-path blocking)', async () => {
  /** @type {string[]} */
  const order = [];

  // pathA's fn is slow; pathB's fn is fast. pathB must not wait on pathA.
  const slow = withAppendLock('lock-test-b1', async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('a');
  });
  const fast = withAppendLock('lock-test-b2', async () => {
    order.push('b');
  });

  await Promise.all([slow, fast]);
  // Fast (b) finishes before slow (a) despite being submitted second.
  assert.deepEqual(order, ['b', 'a']);
});

test('a rejected fn does not block later callers on the same path', async () => {
  const key = 'lock-test-c';
  /** @type {string[]} */
  const order = [];

  const failing = withAppendLock(key, async () => {
    order.push('first');
    throw new Error('boom');
  });
  const next = withAppendLock(key, async () => {
    order.push('second');
    return 'ok';
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ok');
  assert.deepEqual(order, ['first', 'second']);
});
