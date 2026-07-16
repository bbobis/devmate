// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/create-handoff.mjs';

/** @returns {Promise<{ traceDir: string, handoffDir: string }>} */
async function makeDirs() {
  const traceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-ch-trace-'));
  const handoffDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-ch-handoff-'));
  return { traceDir, handoffDir };
}

const base = { taskId: 'feat-1', schemaVersion: 1 };
/** @param {string} stepId @param {string} ts */
const loopHalt = (stepId, ts) => ({ ...base, type: 'loop_halt', stepId, reason: 'r', attempt: 3, last_error: 'e', ts });

/** @param {string} dir @param {string} taskId @param {string[]} lines */
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

test('--task --reason halt against a halted trace → exit 0, both paths printed, files exist', async () => {
  const { traceDir, handoffDir } = await makeDirs();
  await writeTrace(traceDir, 'feat-1', [JSON.stringify(loopHalt('s1', '2026-06-24T12:00:00Z'))]);

  const { code, out } = await capture(() =>
    main(['--task', 'feat-1', '--reason', 'halt', '--trace-dir', traceDir, '--handoff-dir', handoffDir]),
  );
  assert.equal(code, 0);
  assert.match(out, /jsonPath: /);
  assert.match(out, /mdPath: /);

  // Extract the json path and confirm the file exists + reflects halt.
  const m = out.match(/jsonPath: (.+)/);
  assert.ok(m);
  const json = JSON.parse(await fsp.readFile(m[1].trim(), 'utf8'));
  assert.equal(json.currentState, 'halted');
  assert.ok(json.blockers.some((/** @type {string} */ b) => b.includes('s1')));
});

test('--purpose override is applied', async () => {
  const { traceDir, handoffDir } = await makeDirs();
  await writeTrace(traceDir, 'feat-1', [JSON.stringify(loopHalt('s1', '2026-06-24T12:00:00Z'))]);
  const { code, out } = await capture(() =>
    main(['--task', 'feat-1', '--reason', 'manual', '--purpose', 'Custom purpose', '--trace-dir', traceDir, '--handoff-dir', handoffDir]),
  );
  assert.equal(code, 0);
  const m = out.match(/jsonPath: (.+)/);
  assert.ok(m);
  const json = JSON.parse(await fsp.readFile(m[1].trim(), 'utf8'));
  assert.equal(json.purpose, 'Custom purpose');
  assert.equal(json.currentState, 'in_progress');
});

test('bad usage (missing reason) → exit 1', async () => {
  const { code, out } = await capture(() => main(['--task', 'feat-1']));
  assert.equal(code, 1);
  assert.match(out, /Usage:/);
});
