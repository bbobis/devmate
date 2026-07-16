// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHandoffInput,
  reasonToState,
} from '../../../lib/handoff/build-handoff-input.mjs';

test('reasonToState maps trigger reasons to handoff states', () => {
  assert.equal(reasonToState('halt'), 'halted');
  assert.equal(reasonToState('compaction'), 'compacted');
  assert.equal(reasonToState('manual'), 'in_progress');
  assert.equal(reasonToState('session_end'), 'in_progress');
});

test('buildHandoffInput carries a trace pointer and derives state from reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhi-'));
  try {
    const input = await buildHandoffInput('feat-x', { reason: 'session_end', traceDir: dir });
    assert.equal(input.taskId, 'feat-x');
    assert.equal(input.currentState, 'in_progress');
    assert.match(input.purpose, /session_end/);
    assert.equal(input.evidencePointers.length, 1);
    assert.equal(input.evidencePointers[0].path_or_url, '.devmate/state/trace/feat-x.jsonl');
    assert.equal(input.suggestedNextSkill, null);
    assert.deepEqual(input.decisions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildHandoffInput surfaces a blocked step from the trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhi-halt-'));
  try {
    const halt = {
      taskId: 'feat-1',
      schemaVersion: 1,
      type: 'loop_halt',
      stepId: 's1',
      reason: 'r',
      attempt: 3,
      last_error: 'e',
      ts: '2026-06-24T12:00:00Z',
    };
    writeFileSync(join(dir, 'feat-1.jsonl'), JSON.stringify(halt) + '\n', 'utf8');

    const input = await buildHandoffInput('feat-1', { reason: 'halt', traceDir: dir });
    assert.equal(input.currentState, 'halted');
    assert.ok(input.blockers.some((b) => b.includes('s1')), 'blocker should name the halted step');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
