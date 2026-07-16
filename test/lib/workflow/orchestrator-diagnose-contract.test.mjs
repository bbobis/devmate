// @ts-check
/**
 * Pinning test: keeps the assertDispatchResult('diagnose') payload rule in sync
 * with the DiagnosisResult typedef in lib/types.mjs and the @diagnose agent prompt.
 *
 * If the DiagnosisResult shape changes, this test must fail loudly in CI
 * rather than letting the mismatch stay silent.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDispatchResult } from '../../../lib/workflow/orchestrator.mjs';

/** @returns {Record<string, unknown>} */
function canonicalDiagnosisPayload() {
  return {
    bugScope: 'backend',
    suspectedLayer: 'Service layer null-check',
    reproCommand: 'node --test test/lib/workflow/bug-handoff.test.mjs',
    fixerRecommendation: 'Add null guard before cache access.',
    taskId: 'task-123',
    schemaVersion: 1,
  };
}

test('diagnose contract / canonical DiagnosisResult accepted by assertDispatchResult', () => {
  const result = assertDispatchResult('diagnose', {
    status: 'ok',
    payload: canonicalDiagnosisPayload(),
  });
  assert.equal(result.ok, true, `Expected ok, got error: ${result.error ?? ''}`);
});

test('diagnose contract / missing bugScope is rejected', () => {
  const payload = { ...canonicalDiagnosisPayload() };
  delete payload.bugScope;
  const result = assertDispatchResult('diagnose', { status: 'ok', payload });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /diagnose/i);
});

test('diagnose contract / missing reproCommand is rejected', () => {
  const payload = { ...canonicalDiagnosisPayload() };
  delete payload.reproCommand;
  const result = assertDispatchResult('diagnose', { status: 'ok', payload });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /diagnose/i);
});

test('diagnose contract / missing taskId is rejected', () => {
  const payload = { ...canonicalDiagnosisPayload() };
  delete payload.taskId;
  const result = assertDispatchResult('diagnose', { status: 'ok', payload });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /diagnose/i);
});

test('diagnose contract / old keys rootCause/affectedFiles/confidence are not sufficient', () => {
  // Guards against regression to the old (wrong) keys.
  const result = assertDispatchResult('diagnose', {
    status: 'ok',
    payload: { rootCause: 'npe', affectedFiles: ['src/app.mjs'], confidence: 0.9 },
  });
  assert.equal(result.ok, false);
});

test('diagnose contract / artifactPath alone still satisfies the guard', () => {
  const result = assertDispatchResult('diagnose', {
    status: 'ok',
    artifactPath: '.devmate/session/diagnosis.json',
  });
  assert.equal(result.ok, true);
});
