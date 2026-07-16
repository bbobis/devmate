// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStaleness } from '../../lib/task-staleness.mjs';

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR; // arbitrary fixed clock

test('task-staleness › in-flight task idle past threshold is stale', () => {
  const r = evaluateStaleness({
    workflowGate: 'impl-started',
    mtimeMs: NOW - 72 * HOUR,
    nowMs: NOW,
    staleHours: 48,
  });
  assert.equal(r.stale, true);
  assert.equal(Math.round(r.idleHours), 72);
});

test('task-staleness › in-flight task within threshold is not stale', () => {
  const r = evaluateStaleness({
    workflowGate: 'impl-started',
    mtimeMs: NOW - 12 * HOUR,
    nowMs: NOW,
    staleHours: 48,
  });
  assert.equal(r.stale, false);
});

test('task-staleness › terminal + no-lane gates are never stale', () => {
  for (const gate of /** @type {const} */ (['done', 'abandoned', 'no-lane'])) {
    const r = evaluateStaleness({
      workflowGate: gate,
      mtimeMs: NOW - 1000 * HOUR,
      nowMs: NOW,
      staleHours: 48,
    });
    assert.equal(r.stale, false, `${gate} must not be stale`);
  }
});

test('task-staleness › parked task can be stale', () => {
  const r = evaluateStaleness({
    workflowGate: 'parked',
    mtimeMs: NOW - 100 * HOUR,
    nowMs: NOW,
    staleHours: 48,
  });
  assert.equal(r.stale, true);
});

test('task-staleness › idleHours never negative when mtime is in the future', () => {
  const r = evaluateStaleness({
    workflowGate: 'impl-started',
    mtimeMs: NOW + 5 * HOUR,
    nowMs: NOW,
    staleHours: 48,
  });
  assert.equal(r.idleHours, 0);
  assert.equal(r.stale, false);
});
