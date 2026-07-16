// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTrace } from '../../../lib/trace/read-trace.mjs';

/** @returns {Promise<string>} a fresh tmp trace dir */
async function makeTraceDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-readtrace-'));
}

const base = { taskId: 'feat-1', schemaVersion: 1 };

/**
 * Build a step_complete event.
 * @param {string} stepId
 * @param {string} label
 * @param {string} ts
 */
function stepComplete(stepId, label, ts) {
  return { ...base, type: 'step_complete', stepId, label, artifactPaths: ['a'], ts };
}
/**
 * Build a loop_halt event.
 * @param {string} stepId
 * @param {string} ts
 */
function loopHalt(stepId, ts) {
  return { ...base, type: 'loop_halt', stepId, reason: 'r', attempt: 3, last_error: 'e', ts };
}
/**
 * Build an action event.
 * @param {string} stepId
 * @param {string} ts
 */
function action(stepId, ts) {
  return { ...base, type: 'action', stepId, actionType: 'write', path: 'p', digest: 'd', ts };
}
/**
 * Build a compaction event.
 * @param {string} stepId
 * @param {string} ts
 */
function compaction(stepId, ts) {
  return { ...base, type: 'compaction', stepId, artifactPath: 'p', entriesBefore: 9, entriesAfter: 4, ts };
}

/**
 * Write a trace file from raw JSONL lines.
 * @param {string} dir
 * @param {string} taskId
 * @param {string[]} lines
 */
async function writeTrace(dir, taskId, lines) {
  await fsp.writeFile(path.join(dir, `${taskId}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

test('repeated step labels with distinct stepIds → two distinct completed steps', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(stepComplete('s1', 'compile', '2026-06-24T12:00:00Z')),
    JSON.stringify(stepComplete('s2', 'compile', '2026-06-24T12:01:00Z')),
  ]);
  const { steps } = await readTrace('feat-1', { traceDir: dir });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.stepId).sort(), ['s1', 's2']);
  assert.ok(steps.every((s) => s.completed));
});

test('repeated stepId → grouped into one step; lastEventType reflects later event', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(action('s1', '2026-06-24T12:00:00Z')),
    JSON.stringify(stepComplete('s1', 'compile', '2026-06-24T12:01:00Z')),
  ]);
  const { steps } = await readTrace('feat-1', { traceDir: dir });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].lastEventType, 'step_complete');
  assert.equal(steps[0].completed, true);
});

test('malformed lines counted with 1-based line numbers; valid lines still parsed', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(action('s1', '2026-06-24T12:00:00Z')), // line 1 valid
    'not json',                                            // line 2 malformed
    JSON.stringify(stepComplete('s2', 'x', '2026-06-24T12:02:00Z')), // line 3 valid
    '{ bad json',                                          // line 4 malformed
    JSON.stringify(compaction('s3', '2026-06-24T12:04:00Z')), // line 5 valid
  ]);
  const { summary, steps } = await readTrace('feat-1', { traceDir: dir });
  assert.equal(summary.malformedCount, 2);
  assert.deepEqual(summary.malformedLines, [2, 4]);
  assert.equal(steps.length, 3);
});

test('resume from pass: last event step_complete → lastCompleted set, blocked null, nextLegalAction null', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(action('s1', '2026-06-24T12:00:00Z')),
    JSON.stringify(stepComplete('s1', 'compile', '2026-06-24T12:01:00Z')),
  ]);
  const { summary } = await readTrace('feat-1', { traceDir: dir });
  assert.ok(summary.lastCompleted);
  assert.equal(summary.currentBlocked, null);
  assert.equal(summary.nextLegalAction, null);
});

test('resume from halt: last event loop_halt → currentBlocked set, nextLegalAction has stepId', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(action('s1', '2026-06-24T12:00:00Z')),
    JSON.stringify(loopHalt('s1', '2026-06-24T12:01:00Z')),
  ]);
  const { summary } = await readTrace('feat-1', { traceDir: dir });
  assert.ok(summary.currentBlocked);
  assert.equal(summary.currentBlocked?.stepId, 's1');
  assert.match(summary.nextLegalAction ?? '', /s1/);
});

test('resume from compaction: ends with compaction, no complete/halt → blocked null, restart hint', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(action('s1', '2026-06-24T12:00:00Z')),
    JSON.stringify(compaction('s1', '2026-06-24T12:01:00Z')),
  ]);
  const { summary } = await readTrace('feat-1', { traceDir: dir });
  assert.equal(summary.currentBlocked, null);
  assert.equal(summary.nextLegalAction, 'start first step');
});

test('empty / missing trace file → empty steps and start-first-step summary', async () => {
  const dir = await makeTraceDir();
  // No file written at all.
  const result = await readTrace('nope', { traceDir: dir });
  assert.deepEqual(result, {
    steps: [],
    summary: {
      lastCompleted: null,
      currentBlocked: null,
      nextLegalAction: 'start first step',
      malformedCount: 0,
      malformedLines: [],
    },
    totalLines: 0,
  });
});

test('halt followed by later step_complete (same stepId) → not blocked', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(loopHalt('s1', '2026-06-24T12:00:00Z')),
    JSON.stringify(stepComplete('s1', 'compile', '2026-06-24T12:01:00Z')),
  ]);
  const { summary, steps } = await readTrace('feat-1', { traceDir: dir });
  assert.equal(steps[0].halted, false);
  assert.equal(steps[0].completed, true);
  assert.equal(summary.currentBlocked, null);
  assert.ok(summary.lastCompleted);
});
