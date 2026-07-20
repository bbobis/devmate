// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { transitionLogPath, appendTransitionRecord, isSafeTaskId } from '../../lib/state-transition-log.mjs';

test('transitionLogPath — derives a per-task jsonl beside the state file', () => {
  const p = transitionLogPath(join('any', 'dir', 'task.json'), 'bug-42');
  assert.equal(p, join('any', 'dir', 'transitions', 'bug-42.jsonl'));
});

test('appendTransitionRecord — writes a complete, ordered record with branchId=taskId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transition-log-'));
  try {
    const statePath = join(dir, 'task.json');
    appendTransitionRecord(statePath, {
      taskId: 'bug-42',
      fromVersion: 3,
      toVersion: 4,
      event: 'gate-advance',
      fromGate: 'grill-done',
      toGate: 'plan-done',
      ts: '2026-02-02T02:02:02.000Z',
    });
    const rec = JSON.parse(readFileSync(transitionLogPath(statePath, 'bug-42'), 'utf8'));
    assert.deepEqual(rec, {
      taskId: 'bug-42',
      branchId: 'bug-42',
      fromVersion: 3,
      toVersion: 4,
      event: 'gate-advance',
      fromGate: 'grill-done',
      toGate: 'plan-done',
      ts: '2026-02-02T02:02:02.000Z',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSafeTaskId — accepts safe ids, rejects separators and traversal', () => {
  for (const ok of ['bug-42', 'feature.x_1', 'a0']) assert.equal(isSafeTaskId(ok), true, ok);
  for (const bad of ['../etc', 'a/b', 'a\\b', '.hidden', '', 'A-upper']) {
    assert.equal(isSafeTaskId(bad), false, bad);
  }
});

test('appendTransitionRecord — a tampered taskId with a separator is dropped, not written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transition-log-'));
  try {
    const statePath = join(dir, 'task.json');
    appendTransitionRecord(statePath, {
      taskId: '../escape', fromVersion: 0, toVersion: 1, event: 'mutate',
      fromGate: 'no-lane', toGate: 'lane-set', ts: '2026-01-01T00:00:00.000Z',
    });
    // Nothing under the transitions dir, and no escape artifact beside it.
    assert.equal(existsSync(join(dir, 'transitions')), false, 'no log written for an unsafe id');
    assert.equal(existsSync(join(dir, 'escape.jsonl')), false, 'the id did not escape the directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendTransitionRecord — appends (never truncates) across calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transition-log-'));
  try {
    const statePath = join(dir, 'task.json');
    for (let v = 0; v < 3; v += 1) {
      appendTransitionRecord(statePath, {
        taskId: 't', fromVersion: v, toVersion: v + 1, event: 'mutate',
        fromGate: 'no-lane', toGate: 'lane-set', ts: `2026-01-0${v + 1}T00:00:00.000Z`,
      });
    }
    const lines = readFileSync(transitionLogPath(statePath, 't'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).toVersion, 1);
    assert.equal(JSON.parse(lines[1]).toVersion, 2);
    assert.equal(JSON.parse(lines[2]).toVersion, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
