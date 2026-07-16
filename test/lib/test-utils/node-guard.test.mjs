// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeMajorAtLeast, skipUnlessNode } from '../../../lib/test-utils/node-guard.mjs';

const currentMajor = Number(process.versions.node.split('.')[0]);

test('nodeMajorAtLeast returns true at/above min', () => {
  assert.equal(nodeMajorAtLeast(currentMajor), true, 'at min');
  assert.equal(nodeMajorAtLeast(currentMajor - 1), true, 'above min');
  assert.equal(nodeMajorAtLeast(0), true, 'far above min');
});

test('nodeMajorAtLeast returns false below min', () => {
  assert.equal(nodeMajorAtLeast(currentMajor + 1), false, 'one below min');
  assert.equal(nodeMajorAtLeast(999), false, 'far below min');
});

test('skipUnlessNode yields a string reason below min and false at/above', () => {
  const atOrAbove = skipUnlessNode(currentMajor);
  assert.deepEqual(atOrAbove, { skip: false });

  const below = skipUnlessNode(currentMajor + 1);
  assert.equal(typeof below.skip, 'string');
  const reason = /** @type {string} */ (below.skip);
  assert.ok(reason.includes(`Node >= ${currentMajor + 1}`), 'names the required major');
  assert.ok(reason.includes('assertNodeVersion'), 'points at the entrypoint guard');
  assert.ok(reason.includes(process.versions.node), 'names the running version');
});
