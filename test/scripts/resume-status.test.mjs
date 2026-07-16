// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/resume-status.mjs';

/** @returns {Promise<string>} a fresh tmp trace dir */
async function makeTraceDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-resumestatus-'));
}

const base = { taskId: 'feat-1', schemaVersion: 1 };
/** @param {string} stepId @param {string} ts */
const stepComplete = (stepId, ts) => ({ ...base, type: 'step_complete', stepId, label: 'compile', artifactPaths: ['a'], ts });
/** @param {string} stepId @param {string} ts */
const loopHalt = (stepId, ts) => ({ ...base, type: 'loop_halt', stepId, reason: 'r', attempt: 3, last_error: 'e', ts });

/**
 * @param {string} dir
 * @param {string} taskId
 * @param {string[]} lines
 */
async function writeTrace(dir, taskId, lines) {
  await fsp.writeFile(path.join(dir, `${taskId}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

/**
 * @param {() => Promise<number>} fn
 * @returns {Promise<{ code: number, out: string }>}
 */
async function capture(fn) {
  /** @type {string[]} */
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  /** @type {typeof process.stdout.write} */
  const stub = (/** @type {any} */ chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stdout.write = stub;
  try {
    const code = await fn();
    return { code, out: out.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

test('clean trace (completed, no halt/malformed) → exit 0', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [JSON.stringify(stepComplete('s1', '2026-06-24T12:00:00Z'))]);
  const { code, out } = await capture(() => main(['--task', 'feat-1', '--trace-dir', dir]));
  assert.equal(code, 0);
  assert.match(out, /lastCompleted: s1/);
  assert.match(out, /nextLegalAction: task complete/);
});

test('trace with loop_halt → exit 1', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [JSON.stringify(loopHalt('s1', '2026-06-24T12:00:00Z'))]);
  const { code, out } = await capture(() => main(['--task', 'feat-1', '--trace-dir', dir]));
  assert.equal(code, 1);
  assert.match(out, /currentBlocked: s1/);
});

test('trace with malformed line → exit 1', async () => {
  const dir = await makeTraceDir();
  await writeTrace(dir, 'feat-1', [
    JSON.stringify(stepComplete('s1', '2026-06-24T12:00:00Z')),
    'garbage line',
  ]);
  const { code, out } = await capture(() => main(['--task', 'feat-1', '--trace-dir', dir]));
  assert.equal(code, 1);
  assert.match(out, /malformedCount: 1/);
});

test('missing --task → usage and exit 1', async () => {
  const { code, out } = await capture(() => main([]));
  assert.equal(code, 1);
  assert.match(out, /Usage:/);
});
