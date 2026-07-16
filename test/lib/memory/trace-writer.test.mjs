// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl } from '../../../lib/json-io.mjs';
import { writeStepComplete } from '../../../lib/memory/trace-writer.mjs';

/** @returns {Promise<string>} */
async function mkTrace() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'trace-writer-'));
  return join(dir, 'trace.jsonl');
}

/**
 * @param {Partial<import('../../../lib/types.mjs').StepCompleteEntry>} [over]
 * @returns {import('../../../lib/types.mjs').StepCompleteEntry}
 */
function entry(over = {}) {
  return {
    event: 'step_complete',
    stepId: over.stepId ?? 's1',
    label: over.label ?? 'Do the thing',
    taskId: over.taskId ?? 't1',
    lane: over.lane ?? 'feature',
    artifacts: over.artifacts ?? [],
    ts: over.ts ?? Date.now(),
    ...(over.verifyOutput !== undefined ? { verifyOutput: over.verifyOutput } : {}),
  };
}

/**
 * @param {string} path
 * @returns {Promise<any[]>}
 */
async function readTrace(path) {
  const content = await fsp.readFile(path, 'utf8');
  return parseJsonl(content);
}

test('writeStepComplete — happy path with 2 artifacts', async () => {
  const trace = await mkTrace();
  const res = await writeStepComplete(
    entry({
      artifacts: [
        { path: 'src/a.mjs', kind: 'source-file' },
        { path: 'test/out.txt', kind: 'test-output', lineRange: '1-10' },
      ],
    }),
    trace,
  );
  assert.equal(res.ok, true);
  const lines = await readTrace(trace);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'step_complete');
  assert.equal(lines[0].artifacts.length, 2);
});

test('writeStepComplete — idempotency guard', async () => {
  const trace = await mkTrace();
  const first = await writeStepComplete(entry({ stepId: 'dup' }), trace);
  assert.equal(first.ok, true);
  const second = await writeStepComplete(entry({ stepId: 'dup' }), trace);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_complete');
  const lines = await readTrace(trace);
  assert.equal(lines.length, 1);
});

test('writeStepComplete — label too long rejects', async () => {
  const trace = await mkTrace();
  const res = await writeStepComplete(entry({ label: 'x'.repeat(81) }), trace);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /label/);
  await assert.rejects(fsp.stat(trace), /ENOENT/);
});

test('writeStepComplete — empty stepId rejects', async () => {
  const trace = await mkTrace();
  const res = await writeStepComplete(entry({ stepId: '' }), trace);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /stepId/);
});

test('writeStepComplete — artifact path escape rejects', async () => {
  const trace = await mkTrace();
  const res = await writeStepComplete(
    entry({ artifacts: [{ path: '../../etc/passwd', kind: 'source-file' }] }),
    trace,
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /\.\./);
});

test('writeStepComplete — verifyOutput truncated to 512', async () => {
  const trace = await mkTrace();
  const res = await writeStepComplete(
    entry({ verifyOutput: 'a'.repeat(600) }),
    trace,
  );
  assert.equal(res.ok, true);
  const lines = await readTrace(trace);
  assert.ok(lines[0].verifyOutput.length <= 512);
  assert.ok(lines[0].verifyOutput.endsWith('…'));
});

test('writeStepComplete — creates trace file if absent', async () => {
  const trace = await mkTrace();
  await assert.rejects(fsp.stat(trace), /ENOENT/);
  const res = await writeStepComplete(entry(), trace);
  assert.equal(res.ok, true);
  const lines = await readTrace(trace);
  assert.equal(lines.length, 1);
});
