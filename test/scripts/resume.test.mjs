// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/resume.mjs';

/** @returns {Promise<string>} a fresh tmp trace dir */
async function makeTraceDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-resume-cli-'));
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
 * Read the JSONL lines of a task trace.
 * @param {string} traceDir
 * @param {string} taskId
 * @returns {Promise<string[]>}
 */
async function readLines(traceDir, taskId) {
  const file = path.join(traceDir, `${taskId}.jsonl`);
  const contents = await fsp.readFile(file, 'utf8');
  return contents.split('\n').filter((l) => l.length > 0);
}

/** @param {string} t @param {string} s @param {string} ts */
const baseOf = (t, s, ts) => ({ taskId: t, stepId: s, ts, schemaVersion: 1 });

/** Capture process.stdout.write while running fn. @param {() => Promise<number>} fn */
async function captureExit(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  /** @type {string[]} */
  const out = [];
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string | Uint8Array} */ s) => {
      out.push(typeof s === 'string' ? s : String(s));
      return true;
    }
  );
  try {
    const code = await fn();
    return { code, out: out.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

test('missing --task → exit 1 with usage', async () => {
  const { code, out } = await captureExit(() => main([]));
  assert.equal(code, 1);
  assert.match(out, /Usage: resume/);
});

test('proceed → exit 0', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-proceed';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'setup', artifactPaths: [] },
    { ...baseOf(t, 's2', '2026-06-24T10:01:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' },
  ]);
  const { code, out } = await captureExit(() => main(['--task', t, '--trace-dir', traceDir]));
  assert.equal(code, 0);
  assert.match(out, /action: proceed/);
  assert.match(out, /nextStepId: s2/);
});

test('blocked_halt without --strategy-change → exit 2', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-halt';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'loop_halt', reason: 'max', attempt: 3, last_error: 'boom' },
  ]);
  const { code, out } = await captureExit(() => main(['--task', t, '--trace-dir', traceDir]));
  assert.equal(code, 2);
  assert.match(out, /strategy-change/);
});

test('blocked_halt with --strategy-change → exit 0 and a step_complete strategy-change line appended', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-strat';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'loop_halt', reason: 'max', attempt: 3, last_error: 'boom' },
  ]);
  const before = (await readLines(traceDir, t)).length;
  const { code } = await captureExit(() => main(['--task', t, '--trace-dir', traceDir, '--strategy-change']));
  assert.equal(code, 0);

  const lines = await readLines(traceDir, t);
  assert.equal(lines.length, before + 1);
  const appended = JSON.parse(lines[lines.length - 1]);
  assert.equal(appended.type, 'step_complete');
  assert.match(appended.label, /-strategy-change$/);
  assert.equal(Array.isArray(appended.artifactPaths), true);
  // New, distinct stepId per spec (a fresh approach, not a re-dispatch of the halted step).
  assert.equal(appended.stepId !== 's1', true);
});

test('--strategy-change with --dry-run → exit 0 and NO line appended', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-dry';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'loop_halt', reason: 'max', attempt: 3, last_error: 'boom' },
  ]);
  const before = (await readLines(traceDir, t)).length;
  const { code, out } = await captureExit(() =>
    main(['--task', t, '--trace-dir', traceDir, '--strategy-change', '--dry-run']),
  );
  assert.equal(code, 0);
  assert.match(out, /dry-run/i);
  const after = (await readLines(traceDir, t)).length;
  assert.equal(after, before, 'dry-run must not write any trace events');
});

test('confirm_needed → exit 2 without --confirm; exit 0 with --confirm', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-confirm';
  const good = { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'action', actionType: 'write', path: 'a.mjs', digest: 'abc0000000000000' };
  await fsp.writeFile(path.join(traceDir, `${t}.jsonl`), JSON.stringify(good) + '\n{ bad json\n', 'utf8');

  const r1 = await captureExit(() => main(['--task', t, '--trace-dir', traceDir]));
  assert.equal(r1.code, 2);
  assert.match(r1.out, /action: confirm_needed/);

  const r2 = await captureExit(() => main(['--task', t, '--trace-dir', traceDir, '--confirm']));
  assert.equal(r2.code, 0);
});

test('already_complete → exit 0', async () => {
  const traceDir = await makeTraceDir();
  const t = 'cli-done';
  await writeTrace(traceDir, t, [
    { ...baseOf(t, 's1', '2026-06-24T10:00:00.000Z'), type: 'step_complete', label: 'a', artifactPaths: [] },
  ]);
  const { code, out } = await captureExit(() => main(['--task', t, '--trace-dir', traceDir]));
  assert.equal(code, 0);
  assert.match(out, /action: already_complete/);
});
