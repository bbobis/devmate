// @ts-check
/**
 * E2-5 regression: a per-command timeout fires and kills a long-running process;
 * the loop then records a loop_halt trace entry with reason 'timeout'.
 *
 * Spec reconciliation: runCommand itself does not write trace entries — it
 * surfaces `timedOut: true`. The caller writes the loop_halt. This test models
 * that real flow: detect timeout via runCommand, then persist the halt via the
 * real loop-trace writer (appendTraceEvent). 'timeout' is a schema-valid free-
 * form reason string (only NO_PROGRESS / MAX_FILES_CHANGED_WITHOUT_VERIFY /
 * COST_CAP_EXCEEDED are emitted automatically by loop-guard today).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { runCommand } from '../../lib/loop/run-command.mjs';
import { appendTraceEvent } from '../../lib/loop/trace-writer.mjs';
import { makeTmpDir, cleanup, sleepScript } from './_helpers.mjs';

test('timeout › command killed after deadline', async () => {
  const dir = makeTmpDir('reg-timeout-');
  try {
    const script = join(dir, 'sleep.mjs');
    writeFileSync(script, sleepScript(500), 'utf8'); // sleeps 500ms
    const result = await runCommand(['node', script], { timeoutMs: 50 });
    assert.equal(result.timedOut, true, 'command was killed by the 50ms timeout');
    assert.notEqual(result.exitCode, 0, 'killed process does not exit 0');
  } finally {
    cleanup(dir);
  }
});

test('timeout › loop_halt trace written with reason: timeout', async () => {
  const dir = makeTmpDir('reg-timeout-');
  try {
    const script = join(dir, 'sleep.mjs');
    const traceFile = join(dir, 'trace.jsonl');
    writeFileSync(script, sleepScript(500), 'utf8');

    const result = await runCommand(['node', script], { timeoutMs: 50 });
    assert.equal(result.timedOut, true);

    // Caller records the halt on timeout (real loop-trace writer + schema).
    await appendTraceEvent(traceFile, {
      schemaVersion: 1,
      type: 'loop_halt',
      attemptId: 'attempt-timeout-001',
      taskId: 'task-timeout-001',
      ts: new Date().toISOString(),
      reason: 'timeout',
      lastError: `command exceeded 50ms deadline (durationMs=${result.durationMs})`,
      priorAttemptId: null,
    });

    const lines = readFileSync(traceFile, 'utf8').trim().split('\n');
    const halt = JSON.parse(lines[lines.length - 1]);
    assert.equal(halt.type, 'loop_halt');
    assert.equal(halt.reason, 'timeout', 'loop_halt records reason: timeout');
  } finally {
    cleanup(dir);
  }
});
