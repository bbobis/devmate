// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectNoProgress } from '../../../lib/loop/no-progress.mjs';
import { runLoopGuard } from '../../../lib/loop/loop-guard.mjs';
import { SCHEMA_VERSION, readTraceFile } from '../../../lib/loop/trace-schema.mjs';

/** @typedef {import('../../../lib/types.mjs').LoopAttemptEvent} LoopAttemptEvent */
/** @typedef {import('../../../lib/types.mjs').LoopHaltEvent} LoopHaltEvent */
/** @typedef {import('../../../lib/types.mjs').AnyLoopEvent} AnyLoopEvent */

/**
 * Build a minimal valid LoopAttemptEvent.
 * @param {string} attemptId
 * @param {string} outputDigest
 * @returns {LoopAttemptEvent}
 */
function makeAttempt(attemptId, outputDigest) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'loop_attempt',
    attemptId,
    taskId: 'task-1',
    ts: new Date().toISOString(),
    tier: 1,
    command: ['npm', 'run', 'verify'],
    exitCode: 1,
    outputDigest,
    fullOutputPath: '/tmp/out.txt',
  };
}

/**
 * Initialise a bare git repo in `dir` so `git diff` commands work.
 * @param {string} dir
 */
function gitInit(dir) {
  spawnSync('git', ['init', dir], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  // Create an initial empty commit so HEAD exists and `git diff HEAD` works
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
}

// ---- Pure detectNoProgress tests ----

test('first failure — no prior entries: returns noProgress: false', () => {
  const result = detectNoProgress({
    currentAttemptId: 'attempt-1',
    currentDigest: 'abc123',
    traceEvents: [],
  });
  assert.equal(result.noProgress, false);
  assert.equal(result.matchedAttemptId, null);
  assert.equal(result.currentDigest, 'abc123');
});

test('first failure — prior entries with different digest: returns noProgress: false', () => {
  const result = detectNoProgress({
    currentAttemptId: 'attempt-2',
    currentDigest: 'abc123',
    traceEvents: [makeAttempt('attempt-1', 'xyz999')],
  });
  assert.equal(result.noProgress, false);
  assert.equal(result.matchedAttemptId, null);
});

test('repeated same failure: returns noProgress: true with matchedAttemptId', () => {
  const result = detectNoProgress({
    currentAttemptId: 'attempt-2',
    currentDigest: 'abc123',
    traceEvents: [makeAttempt('attempt-1', 'abc123')],
  });
  assert.equal(result.noProgress, true);
  assert.equal(result.matchedAttemptId, 'attempt-1');
});

test('self-comparison guard: same attemptId + same digest → noProgress: false', () => {
  const result = detectNoProgress({
    currentAttemptId: 'attempt-1',
    currentDigest: 'abc123',
    traceEvents: [makeAttempt('attempt-1', 'abc123')],
  });
  assert.equal(result.noProgress, false);
  assert.equal(result.matchedAttemptId, null);
});

test('changed failure: two prior entries both differ from current → noProgress: false', () => {
  const result = detectNoProgress({
    currentAttemptId: 'attempt-3',
    currentDigest: 'new-digest',
    traceEvents: [
      makeAttempt('attempt-1', 'digest-a'),
      makeAttempt('attempt-2', 'digest-b'),
    ],
  });
  assert.equal(result.noProgress, false);
  assert.equal(result.matchedAttemptId, null);
});

// ---- Integration: runLoopGuard no-progress halt ----

test('integration — runLoopGuard halt on no-progress: writes loop_halt with reason NO_PROGRESS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-progress-test-'));
  try {
    gitInit(dir);

    const traceFile = join(dir, 'loop-trace.jsonl');
    const priorEvent = makeAttempt('prior-attempt-1', 'repeated-digest');
    writeFileSync(traceFile, JSON.stringify(priorEvent) + '\n', 'utf8');

    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'current-attempt-2',
      maxFiles: 9999,
      repoRoot: dir,
      sinceRef: 'HEAD',
      currentDigest: 'repeated-digest',
    });

    assert.equal(result.allowed, false);
    assert.equal(result.haltReason, 'NO_PROGRESS');

    const { events } = readTraceFile(traceFile);
    const haltEvents = events.filter((e) => e.type === 'loop_halt');
    assert.equal(haltEvents.length, 1);
    const halt = /** @type {LoopHaltEvent} */ (haltEvents[0]);
    assert.equal(halt.reason, 'NO_PROGRESS');
    assert.equal(halt.priorAttemptId, 'prior-attempt-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration — runLoopGuard continues on first failure: empty trace → allowed: true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-progress-empty-'));
  try {
    mkdirSync(dir, { recursive: true });
    gitInit(dir);

    const traceFile = join(dir, 'loop-trace.jsonl');

    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'first-attempt',
      maxFiles: 9999,
      repoRoot: dir,
      sinceRef: 'HEAD',
      currentDigest: 'some-digest',
    });

    assert.equal(result.allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
