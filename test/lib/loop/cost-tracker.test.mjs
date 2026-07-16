// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateAttemptTokens, sumCumulativeCost } from '../../../lib/loop/cost-tracker.mjs';
import { runLoopGuard } from '../../../lib/loop/loop-guard.mjs';
import { SCHEMA_VERSION, readTraceFile } from '../../../lib/loop/trace-schema.mjs';

/** @typedef {import('../../../lib/types.mjs').LoopAttemptEvent} LoopAttemptEvent */
/** @typedef {import('../../../lib/types.mjs').LoopHaltEvent} LoopHaltEvent */
/** @typedef {import('../../../lib/types.mjs').AnyLoopEvent} AnyLoopEvent */

/**
 * Build a minimal valid LoopAttemptEvent with an optional tokenEstimate.
 * @param {string} attemptId
 * @param {number} [estimate]
 * @returns {LoopAttemptEvent}
 */
function makeAttempt(attemptId, estimate) {
  /** @type {LoopAttemptEvent} */
  const event = {
    schemaVersion: SCHEMA_VERSION,
    type: 'loop_attempt',
    attemptId,
    taskId: 'task-1',
    ts: new Date().toISOString(),
    tier: 1,
    command: ['npm', 'run', 'verify'],
    exitCode: 1,
    outputDigest: 'digest-' + attemptId,
    fullOutputPath: '/tmp/out.txt',
  };
  if (estimate !== undefined) {
    event.tokenEstimate = estimate;
  }
  return event;
}

/**
 * Initialise a bare git repo in `dir` so countChangedFiles does not crash.
 * @param {string} dir
 */
function gitInit(dir) {
  spawnSync('git', ['init', dir], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
}

// ---- Pure estimateAttemptTokens tests ----

test('estimateAttemptTokens: 400 bytes -> 100 tokens', () => {
  assert.equal(estimateAttemptTokens({ outputBytes: 400 }), 100);
});

test('estimateAttemptTokens: 0 bytes -> 0', () => {
  assert.equal(estimateAttemptTokens({ outputBytes: 0 }), 0);
});

test('estimateAttemptTokens: 1 byte -> 1', () => {
  assert.equal(estimateAttemptTokens({ outputBytes: 1 }), 1);
});

// ---- Pure sumCumulativeCost tests ----

test('sumCumulativeCost — no cap: two attempts (50+80) -> totalEstimatedTokens 130, capExceeded false', () => {
  const events = /** @type {AnyLoopEvent[]} */ ([
    makeAttempt('a1', 50),
    makeAttempt('a2', 80),
  ]);
  const result = sumCumulativeCost(events);
  assert.equal(result.totalEstimatedTokens, 130);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.capExceeded, false);
  assert.equal(result.capLimit, undefined);
});

test('sumCumulativeCost — below cap: total 130, cap 200 -> capExceeded false', () => {
  const events = /** @type {AnyLoopEvent[]} */ ([
    makeAttempt('a1', 50),
    makeAttempt('a2', 80),
  ]);
  const result = sumCumulativeCost(events, { capLimit: 200 });
  assert.equal(result.totalEstimatedTokens, 130);
  assert.equal(result.capExceeded, false);
  assert.equal(result.capLimit, 200);
});

test('sumCumulativeCost — at cap: total 200, cap 200 -> capExceeded true', () => {
  const events = /** @type {AnyLoopEvent[]} */ ([
    makeAttempt('a1', 120),
    makeAttempt('a2', 80),
  ]);
  const result = sumCumulativeCost(events, { capLimit: 200 });
  assert.equal(result.totalEstimatedTokens, 200);
  assert.equal(result.capExceeded, true);
});

test('sumCumulativeCost — missing tokenEstimate: entry without field contributes 0', () => {
  const events = /** @type {AnyLoopEvent[]} */ ([
    makeAttempt('a1'),       // no tokenEstimate
    makeAttempt('a2', 40),
  ]);
  const result = sumCumulativeCost(events, { capLimit: 100 });
  assert.equal(result.totalEstimatedTokens, 40);
  assert.equal(result.capExceeded, false);
});

// ---- Integration: runLoopGuard cost cap ----

test('runLoopGuard — cap exceeded: cumulative 500, cap 400 -> allowed false, haltReason COST_CAP_EXCEEDED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-cap-exceeded-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'loop-trace.jsonl');
    // Two prior attempts totalling 500 tokens
    const a1 = makeAttempt('prior-1', 300);
    const a2 = makeAttempt('prior-2', 200);
    writeFileSync(traceFile, JSON.stringify(a1) + '\n' + JSON.stringify(a2) + '\n', 'utf8');

    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'current-3',
      maxFiles: 9999,
      repoRoot: dir,
      sinceRef: 'HEAD',
      maxLoopTokens: 400,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.haltReason, 'COST_CAP_EXCEEDED');

    const { events } = readTraceFile(traceFile);
    const halts = events.filter((e) => e.type === 'loop_halt');
    assert.equal(halts.length, 1);
    const halt = /** @type {LoopHaltEvent} */ (halts[0]);
    assert.equal(halt.reason, 'COST_CAP_EXCEEDED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLoopGuard — cap disabled: same trace, no maxLoopTokens -> allowed true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-cap-disabled-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'loop-trace.jsonl');
    const a1 = makeAttempt('prior-1', 300);
    const a2 = makeAttempt('prior-2', 200);
    writeFileSync(traceFile, JSON.stringify(a1) + '\n' + JSON.stringify(a2) + '\n', 'utf8');

    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'current-3',
      maxFiles: 9999,
      repoRoot: dir,
      sinceRef: 'HEAD',
      // maxLoopTokens intentionally omitted
    });

    assert.equal(result.allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLoopGuard — cap not reached: cumulative 300, cap 400 -> allowed true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-cap-below-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'loop-trace.jsonl');
    const a1 = makeAttempt('prior-1', 150);
    const a2 = makeAttempt('prior-2', 150);
    writeFileSync(traceFile, JSON.stringify(a1) + '\n' + JSON.stringify(a2) + '\n', 'utf8');

    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'current-3',
      maxFiles: 9999,
      repoRoot: dir,
      sinceRef: 'HEAD',
      maxLoopTokens: 400,
    });

    assert.equal(result.allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
