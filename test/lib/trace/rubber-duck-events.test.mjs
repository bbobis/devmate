// @ts-check

/**
 * E11-3: Trace events for the rubber-duck grill and critique stages.
 *
 * Covers:
 *   - schema acceptance of `grill_complete`, `critique_complete`, `plan_revised`
 *   - `appendTraceEvent` writes each new event type as a single JSONL line that
 *     round-trips through `JSON.parse`
 *   - `appendTraceEvent` throws `UnknownTraceEventError` for an unknown `type`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateTraceEvent,
  UnknownTraceEventError,
  isKnownTraceEventType,
} from '../../../lib/trace/schema.mjs';
import { appendTraceEvent, traceFilePath } from '../../../lib/trace/append.mjs';

/** @returns {Promise<string>} a fresh tmp root dir */
async function makeTmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-rubberduck-trace-'));
}

const base = {
  stepId: 'step-rd-1',
  taskId: 'feat-rd',
  ts: '2026-06-24T12:00:00.000Z',
  schemaVersion: 1,
};

const GRILL = {
  ...base,
  type: 'grill_complete',
  assumptions: ['user always provides input'],
  edgeCases: ['empty input', 'unicode names'],
  cornerCases: ['concurrent edits'],
  blockingQuestions: ['What is the max input size?'],
};

const CRITIQUE_APPROVE = {
  ...base,
  stepId: 'step-rd-2',
  type: 'critique_complete',
  verdict: 'APPROVE_PLAN',
  missingTests: [],
  risks: [],
  iterationNumber: 1,
};

const CRITIQUE_REVISION = {
  ...base,
  stepId: 'step-rd-3',
  type: 'critique_complete',
  verdict: 'REQUEST_REVISION:Missing edge case for empty input',
  missingTests: ['empty input rejection'],
  risks: ['unbounded memory on huge input'],
  iterationNumber: 1,
};

const PLAN_REVISED = {
  ...base,
  stepId: 'step-rd-4',
  type: 'plan_revised',
  revision: 1,
  reason: 'Missing edge case for empty input',
};

test('schema validates a grill_complete event with all four list fields', () => {
  const result = validateTraceEvent(GRILL);
  assert.equal(result.ok, true, `errors: ${result.errors.join('; ')}`);
  assert.deepEqual(result.errors, []);
});

test('schema validates a critique_complete event with APPROVE_PLAN verdict', () => {
  const result = validateTraceEvent(CRITIQUE_APPROVE);
  assert.equal(result.ok, true, `errors: ${result.errors.join('; ')}`);
});

test('schema validates a critique_complete event with REQUEST_REVISION verdict', () => {
  const result = validateTraceEvent(CRITIQUE_REVISION);
  assert.equal(result.ok, true, `errors: ${result.errors.join('; ')}`);
});

test('schema validates a plan_revised event with revision number and reason', () => {
  const result = validateTraceEvent(PLAN_REVISED);
  assert.equal(result.ok, true, `errors: ${result.errors.join('; ')}`);
});

test('schema rejects a grill_complete missing assumptions array', () => {
  const { assumptions: _w, ...rest } = GRILL;
  const result = validateTraceEvent(rest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('assumptions')));
});

test('schema rejects a critique_complete with non-number iterationNumber', () => {
  const result = validateTraceEvent({ ...CRITIQUE_APPROVE, iterationNumber: 'one' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('iterationNumber')));
});

test('schema rejects a plan_revised missing reason', () => {
  const { reason: _r, ...rest } = PLAN_REVISED;
  const result = validateTraceEvent(rest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('reason')));
});

test('isKnownTraceEventType recognises the three new event types', () => {
  assert.equal(isKnownTraceEventType('grill_complete'), true);
  assert.equal(isKnownTraceEventType('critique_complete'), true);
  assert.equal(isKnownTraceEventType('plan_revised'), true);
  assert.equal(isKnownTraceEventType('bogus_event'), false);
  assert.equal(isKnownTraceEventType(42), false);
});

test('appendTraceEvent — grill_complete event appended to trace.jsonl with correct shape', async () => {
  const root = await makeTmpRoot();
  const result = await appendTraceEvent(/** @type {any} */ (GRILL), { root });
  assert.equal(result.ok, true);
  assert.equal(result.lineNumber, 1);

  const contents = await fsp.readFile(traceFilePath('feat-rd', root), 'utf8');
  const lines = contents.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, 'grill_complete');
  assert.deepEqual(parsed.edgeCases, ['empty input', 'unicode names']);
  assert.deepEqual(parsed.blockingQuestions, ['What is the max input size?']);
});

test('appendTraceEvent — critique_complete APPROVE_PLAN event appended with correct shape', async () => {
  const root = await makeTmpRoot();
  const result = await appendTraceEvent(/** @type {any} */ (CRITIQUE_APPROVE), { root });
  assert.equal(result.ok, true);
  const contents = await fsp.readFile(traceFilePath('feat-rd', root), 'utf8');
  const parsed = JSON.parse(contents.trim());
  assert.equal(parsed.type, 'critique_complete');
  assert.equal(parsed.verdict, 'APPROVE_PLAN');
  assert.equal(parsed.iterationNumber, 1);
});

test('appendTraceEvent — critique_complete REQUEST_REVISION event appended with verdict and reason', async () => {
  const root = await makeTmpRoot();
  const result = await appendTraceEvent(/** @type {any} */ (CRITIQUE_REVISION), { root });
  assert.equal(result.ok, true);
  const contents = await fsp.readFile(traceFilePath('feat-rd', root), 'utf8');
  const parsed = JSON.parse(contents.trim());
  assert.equal(parsed.type, 'critique_complete');
  assert.ok(parsed.verdict.startsWith('REQUEST_REVISION:'));
  assert.deepEqual(parsed.missingTests, ['empty input rejection']);
});

test('appendTraceEvent — plan_revised event appended with revision number and reason', async () => {
  const root = await makeTmpRoot();
  const result = await appendTraceEvent(/** @type {any} */ (PLAN_REVISED), { root });
  assert.equal(result.ok, true);
  const contents = await fsp.readFile(traceFilePath('feat-rd', root), 'utf8');
  const parsed = JSON.parse(contents.trim());
  assert.equal(parsed.type, 'plan_revised');
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.reason, 'Missing edge case for empty input');
});

test('appendTraceEvent — unknown event type throws UnknownTraceEventError', async () => {
  const root = await makeTmpRoot();
  const bogus = { ...base, type: 'totally_made_up' };
  await assert.rejects(
    () => appendTraceEvent(/** @type {any} */ (bogus), { root }),
    (err) => {
      assert.ok(err instanceof UnknownTraceEventError);
      assert.equal(/** @type {any} */ (err).typeValue, 'totally_made_up');
      return true;
    },
  );
});

test('appendTraceEvent — unknown event type does NOT create a trace file', async () => {
  const root = await makeTmpRoot();
  const bogus = { ...base, type: 'totally_made_up' };
  try {
    await appendTraceEvent(/** @type {any} */ (bogus), { root });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof UnknownTraceEventError);
  }
  // No trace file should exist for this task.
  await assert.rejects(fsp.access(traceFilePath('feat-rd', root)));
});

test('appendTraceEvent — three rubber-duck events appended to the same task → three JSONL lines', async () => {
  const root = await makeTmpRoot();
  await appendTraceEvent(/** @type {any} */ (GRILL), { root });
  await appendTraceEvent(/** @type {any} */ (CRITIQUE_REVISION), { root });
  await appendTraceEvent(/** @type {any} */ (PLAN_REVISED), { root });
  const contents = await fsp.readFile(traceFilePath('feat-rd', root), 'utf8');
  const lines = contents.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).type, 'grill_complete');
  assert.equal(JSON.parse(lines[1]).type, 'critique_complete');
  assert.equal(JSON.parse(lines[2]).type, 'plan_revised');
});
