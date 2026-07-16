// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTraceEvent } from '../../../lib/trace/schema.mjs';

/** Base fields shared by every event. */
const base = {
  stepId: 'step-abc-123',
  taskId: 'feat-1',
  ts: '2026-06-24T12:00:00.000Z',
  schemaVersion: 1,
};

/** One valid example per type. */
const VALID = {
  action: { ...base, type: 'action', actionType: 'write', path: 'src/x.mjs', digest: 'sha256:aa' },
  gate_transition: { ...base, type: 'gate_transition', from: 'plan-approved', to: 'impl-started', gate: 'impl-started' },
  loop_attempt: { ...base, type: 'loop_attempt', attempt: 1, command: ['npm', 'test'], exitCode: 0, digest: 'sha256:bb' },
  loop_halt: { ...base, type: 'loop_halt', reason: 'max attempts', attempt: 3, last_error: 'tests failed' },
  step_complete: { ...base, type: 'step_complete', label: 'verify', artifactPaths: ['a.txt'] },
  fact_write: { ...base, type: 'fact_write', factKey: 'k', scope: 'task', sourcePointer: 'mem.jsonl:3' },
  compaction: { ...base, type: 'compaction', artifactPath: 'trace.jsonl', entriesBefore: 100, entriesAfter: 40 },
  budget_warning: { ...base, type: 'budget_warning', field: 'tokens', current: 90, limit: 100 },
  contract_violation: {
    ...base,
    type: 'contract_violation',
    contract: 'WorkerReturn',
    path: '.devmate/state/worker-returns/x.json',
    errors: ['workerId must be a non-empty string'],
  },
  discovery_merge: { ...base, type: 'discovery_merge', inputs: 2, merged: 8, dropped: 3, conflicts: 1 },
};

test('accepts a valid event of each covered type', () => {
  for (const [type, event] of Object.entries(VALID)) {
    const result = validateTraceEvent(event);
    assert.equal(result.ok, true, `${type} should validate; errors: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  }
});

test('rejects an unknown type value', () => {
  const result = validateTraceEvent({ ...base, type: 'bogus' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('type')));
});

test('rejects a missing stepId', () => {
  const { stepId, ...rest } = VALID.action;
  void stepId;
  const result = validateTraceEvent(rest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('stepId')));
});

test('rejects a loop_halt missing last_error', () => {
  const { last_error, ...rest } = VALID.loop_halt;
  void last_error;
  const result = validateTraceEvent(rest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('last_error')));
});

test('rejects a loop_attempt missing exitCode', () => {
  const { exitCode, ...rest } = VALID.loop_attempt;
  void exitCode;
  const result = validateTraceEvent(rest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('exitCode')));
});

test('rejects a non-object event', () => {
  assert.equal(validateTraceEvent(null).ok, false);
  assert.equal(validateTraceEvent('nope').ok, false);
  assert.equal(validateTraceEvent([]).ok, false);
});

test('rejects a loop_attempt whose command is not an array', () => {
  const result = validateTraceEvent({ ...VALID.loop_attempt, command: 'npm test' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('command')));
});

test('rejects a discovery_merge missing any count field', () => {
  for (const field of ['inputs', 'merged', 'dropped', 'conflicts']) {
    const event = /** @type {Record<string, unknown>} */ ({ ...VALID.discovery_merge });
    delete event[field];
    const result = validateTraceEvent(event);
    assert.equal(result.ok, false, `discovery_merge without ${field} must be invalid`);
    assert.ok(result.errors.some((e) => e.includes(field)), `error names ${field}`);
  }
});

test('rejects a discovery_merge with a non-number count', () => {
  const result = validateTraceEvent({ ...VALID.discovery_merge, dropped: 'three' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('dropped')));
});
