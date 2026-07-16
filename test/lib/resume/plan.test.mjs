// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResumePlan } from '../../../lib/resume/plan.mjs';
import { writeHandoff } from '../../../lib/handoff/write-handoff.mjs';

/** @returns {Promise<string>} a fresh tmp trace dir */
async function makeTraceDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-resume-'));
}

/**
 * Write trace events (one per line) to <traceDir>/<taskId>.jsonl.
 * @param {string} traceDir
 * @param {string} taskId
 * @param {object[]} events
 * @returns {Promise<void>}
 */
async function writeTrace(traceDir, taskId, events) {
  const file = path.join(traceDir, `${taskId}.jsonl`);
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.writeFile(file, body, 'utf8');
}

/**
 * Build a base event with shared fields.
 * @param {string} taskId
 * @param {string} stepId
 * @param {string} ts
 * @returns {{ taskId: string, stepId: string, ts: string, schemaVersion: number }}
 */
const baseOf = (taskId, stepId, ts) => ({ taskId, stepId, ts, schemaVersion: 1 });

test('resume from pass: trace ends with step_complete → proceed, next is following uncompleted step', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-pass';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'setup', artifactPaths: [] },
    // s2 started (action) but NOT completed → it is the next step.
    { ...baseOf(t, 's2', '2026-06-24T10:01:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' },
  ]);

  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'proceed');
  assert.equal(plan.nextStepId, 's2');
  assert.equal(plan.handoffAvailable, false);
});

test('never repeats completed step: 3 completed steps → nextStepId is none of them', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-3done';
  const done = ['s1', 's2', 's3'];
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'a', artifactPaths: [] },
    { ...baseOf(t, 's2', '2026-06-24T10:01:00.000Z'), type: 'step_complete', label: 'b', artifactPaths: [] },
    { ...baseOf(t, 's3', '2026-06-24T10:02:00.000Z'), type: 'step_complete', label: 'c', artifactPaths: [] },
  ]);

  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'already_complete');
  assert.ok(!done.includes(/** @type {string} */ (plan.nextStepId ?? '')));
  assert.equal(plan.nextStepId, null);
});

test('blocked_halt: trace ends with loop_halt and no later step_complete', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-halt';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'setup', artifactPaths: [] },
    { ...baseOf(t, 's2', '2026-06-24T10:01:00.000Z'), type: 'loop_halt', reason: 'max_attempts', attempt: 3, last_error: 'boom' },
  ]);

  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'blocked_halt');
  assert.equal(plan.nextStepId, 's2');
  assert.match(plan.message, /halted/);
});

test('resume from compaction: ends with compaction, no halt/complete → proceed', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-compact';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'compaction', artifactPath: 'h.json', entriesBefore: 10, entriesAfter: 3 },
  ]);

  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'proceed');
  assert.equal(plan.nextStepId, 's1');
});

test('malformed lines → confirm_needed', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-malformed';
  const file = path.join(traceDir, `${t}.jsonl`);
  const good = { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' };
  await fsp.writeFile(file, JSON.stringify(good) + '\n' + '{ not valid json\n', 'utf8');

  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'confirm_needed');
  assert.match(plan.message, /malformed/);
});

test('already complete: all steps step_complete → already_complete', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-allcomplete';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'a', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.action, 'already_complete');
});

test('manual checkpoint resume: handoff present (halted) → handoffAvailable true, blocked_halt', async () => {
  const traceDir = await makeTraceDir();
  const handoffDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-handoff-'));
  const t = 'feat-handoff';

  // Halted trace.
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'loop_halt', reason: 'manual', attempt: 1, last_error: 'paused' },
  ]);

  // Matching handoff artifact in halted state with blockers.
  await writeHandoff(
    {
      taskId: t,
      purpose: 'finish the thing',
      currentState: 'halted',
      decisions: ['use approach A'],
      openQuestions: ['which db?'],
      evidencePointers: [],
      suggestedNextSkill: null,
      blockers: ['waiting on review'],
    },
    { handoffDir },
  );

  const plan = await buildResumePlan(t, { traceDir, handoffDir });
  assert.equal(plan.handoffAvailable, true);
  assert.equal(plan.action, 'blocked_halt');
  assert.ok(plan.handoff);
  assert.equal(plan.handoff?.currentState, 'halted');
});

test('compaction artifact is consumed: compactionAvailable true and surfaced in the message', async () => {
  const traceDir = await makeTraceDir();
  const compactionDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-compaction-'));
  const t = 'feat-compacted';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'setup', artifactPaths: [] },
    { ...baseOf(t, 's2', '2026-06-24T10:01:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' },
  ]);
  // A self-sufficient compaction artifact (goal + nextAction + a pointer).
  await fsp.writeFile(
    path.join(compactionDir, 'compaction-2026-06-24T10-02-00.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      goal: 'ship the resume wiring',
      nextAction: 'run the verify suite',
      evidencePointers: [{ path: 'lib/x.mjs', why: 'r' }],
    }),
    'utf8',
  );

  const plan = await buildResumePlan(t, { traceDir, compactionDir });
  assert.equal(plan.compactionAvailable, true);
  assert.ok(plan.compaction, 'the loaded artifact is attached to the plan');
  assert.match(plan.message, /compaction resume-brief/);
});

test('no compactionDir → compactionAvailable false (opt-in)', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-nocompact';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' },
  ]);
  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.compactionAvailable, false);
});

test('implProgress: reports done/total and next AC from the trace + AC list', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-ac-progress';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 'impl-AC1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'first', artifactPaths: [] },
    { ...baseOf(t, 'impl-AC2', '2026-06-24T10:01:00.000Z'), type: 'step_complete', label: 'second', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, {
    traceDir,
    acceptanceCriteria: ['first', 'second', 'third'],
  });
  assert.ok(plan.implProgress);
  assert.equal(plan.implProgress.done, 2);
  assert.equal(plan.implProgress.total, 3);
  assert.equal(plan.implProgress.nextId, 3);
  assert.equal(plan.implProgress.nextLabel, 'third');
  assert.match(plan.message, /Implementation: 2\/3 ACs complete, next AC3: third/);
});

test('implProgress: a completed AC is never re-emitted as the next step', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-ac-noredo';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 'impl-AC1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'first', artifactPaths: [] },
    { ...baseOf(t, 'impl-AC2', '2026-06-24T10:01:00.000Z'), type: 'step_complete', label: 'second', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, { traceDir, acceptanceCriteria: ['first', 'second'] });
  assert.notEqual(plan.nextStepId, 'impl-AC1');
  assert.notEqual(plan.nextStepId, 'impl-AC2');
  assert.equal(plan.implProgress?.nextId, null);
});

test('implProgress: absent when no AC list and no impl-AC completions', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-ac-none';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'setup', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, { traceDir });
  assert.equal(plan.implProgress, undefined);
});

test('implProgress: outstanding ACs override an already_complete trace to proceed', async () => {
  // Trace holds only completed impl-AC events (no incomplete step), so the
  // coarse view is "all steps complete" — but 2 of 4 ACs remain.
  const traceDir = await makeTraceDir();
  const t = 'feat-ac-override';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 'impl-AC1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'a', artifactPaths: [] },
    { ...baseOf(t, 'impl-AC3', '2026-06-24T10:01:00.000Z'), type: 'step_complete', label: 'c', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, {
    traceDir,
    acceptanceCriteria: ['a', 'b', 'c', 'd'],
  });
  assert.equal(plan.action, 'proceed', 'not already_complete while ACs remain');
  assert.equal(plan.nextStepId, 'impl-AC2');
  assert.equal(plan.nextStepLabel, 'b');
  assert.equal(plan.implProgress?.done, 2);
});

test('implProgress: all ACs complete stays already_complete', async () => {
  const traceDir = await makeTraceDir();
  const t = 'feat-ac-alldone';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 'impl-AC1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'a', artifactPaths: [] },
    { ...baseOf(t, 'impl-AC2', '2026-06-24T10:01:00.000Z'), type: 'step_complete', label: 'b', artifactPaths: [] },
  ]);
  const plan = await buildResumePlan(t, { traceDir, acceptanceCriteria: ['a', 'b'] });
  assert.equal(plan.action, 'already_complete');
  assert.equal(plan.implProgress?.nextId, null);
});
