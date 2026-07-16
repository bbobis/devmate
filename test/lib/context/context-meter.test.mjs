// @ts-check
/**
 * #87: the context meter — the one quantity the session budget is allowed to
 * count, because it is the only one that (a) has a producer in production and
 * (b) actually enters the model's context window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextMeterPath,
  emptyMeter,
  readContextMeter,
  recordToolResult,
  rememberReport,
  resetContextMeter,
  toolResponseTokens,
} from '../../../lib/context/context-meter.mjs';

/** @returns {Promise<string>} Path to a task.json in a fresh temp dir. */
async function mkTaskState() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'context-meter-'));
  const taskStatePath = join(dir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify({ taskId: 't-1' }), 'utf8');
  return taskStatePath;
}

test('toolResponseTokens — measures the string the host feeds back to the model', () => {
  assert.equal(toolResponseTokens('x'.repeat(4000)), 1000); // 4 bytes/token
  assert.equal(toolResponseTokens(''), 0);
});

test('toolResponseTokens — an unmeasurable response counts as zero, never throws', () => {
  assert.equal(toolResponseTokens(undefined), 0);
  assert.equal(toolResponseTokens(null), 0);

  // A hook must not crash on a shape it did not expect.
  /** @type {Record<string, unknown>} */
  const circular = {};
  circular['self'] = circular;
  assert.equal(toolResponseTokens(circular), 0);

  // A non-string response is still measured, via its serialization.
  assert.ok(toolResponseTokens({ result: 'ok' }) > 0);
});

test('readContextMeter — absent / malformed meter reads as zeroed, never throws', async () => {
  const taskStatePath = await mkTaskState();
  assert.deepEqual(await readContextMeter(taskStatePath), emptyMeter());

  await fsp.writeFile(contextMeterPath(taskStatePath), 'not json at all', 'utf8');
  assert.deepEqual(await readContextMeter(taskStatePath), emptyMeter());

  await fsp.writeFile(contextMeterPath(taskStatePath), JSON.stringify({ contextTokens: -5 }), 'utf8');
  assert.equal((await readContextMeter(taskStatePath)).contextTokens, 0, 'a negative count is not a count');
});

test('recordToolResult — accumulates across tool calls', async () => {
  const taskStatePath = await mkTaskState();
  await recordToolResult(taskStatePath, 'x'.repeat(4000));
  await recordToolResult(taskStatePath, 'y'.repeat(8000));

  const meter = await readContextMeter(taskStatePath);
  assert.equal(meter.contextTokens, 3000);
  assert.equal(meter.toolResults, 2);
});

test('recordToolResult — a zero-cost response does not churn the meter file', async () => {
  const taskStatePath = await mkTaskState();
  await recordToolResult(taskStatePath, undefined);

  assert.equal(
    await fsp.access(contextMeterPath(taskStatePath)).then(() => true, () => false),
    false,
    'nothing entered context, so there is nothing to persist',
  );
});

test('rememberReport — persists the last reported key without disturbing the count', async () => {
  const taskStatePath = await mkTaskState();
  await recordToolResult(taskStatePath, 'x'.repeat(4000));
  await rememberReport(taskStatePath, 'warn:Tool results in context:4');

  const meter = await readContextMeter(taskStatePath);
  assert.equal(meter.lastReportId, 'warn:Tool results in context:4');
  assert.equal(meter.contextTokens, 1000, 'the count survives a report');
});

test('resetContextMeter — zeroes the count; compaction drops what it counted', async () => {
  const taskStatePath = await mkTaskState();
  await recordToolResult(taskStatePath, 'x'.repeat(40_000));
  assert.equal((await readContextMeter(taskStatePath)).contextTokens, 10_000);

  await resetContextMeter(taskStatePath);
  assert.deepEqual(await readContextMeter(taskStatePath), emptyMeter());
});
