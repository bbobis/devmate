// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrReviewResult } from '../../../lib/workflow/contracts.mjs';

/**
 * A well-formed PrReviewArtifact. Overridable per-test.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function makeArtifact(over = {}) {
  return {
    taskId: 'feat-1',
    lane: 'feature',
    schemaVersion: 1,
    returnedAt: '2026-07-12T00:00:00.000Z',
    contextDigest: 'a'.repeat(64),
    verdict: 'APPROVE',
    findings: [
      {
        severity: 'medium',
        category: 'quality',
        evidence: { path: 'lib/a.mjs', lineRange: '10-20' },
        finding: 'shallow wrapper',
        recommendation: 'inline it',
      },
    ],
    alignment: { ok: true, outOfScopeFiles: [], unlistedFiles: [], missingRegressionTest: false },
    unverified: ['[UNVERIFIED] could not confirm auth path'],
    ...over,
  };
}

test('accepts a well-formed APPROVE artifact', () => {
  const r = validatePrReviewResult(makeArtifact());
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('accepts REQUEST_CHANGES with a non-empty reason', () => {
  const r = validatePrReviewResult(makeArtifact({ verdict: 'REQUEST_CHANGES: scope breach in lib/x.mjs' }));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('rejects a bad severity', () => {
  const r = validatePrReviewResult(
    makeArtifact({
      findings: [
        { severity: 'critical', category: 'quality', evidence: { path: 'lib/a.mjs' }, finding: 'x', recommendation: 'y' },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('severity')));
});

test('rejects a bad category', () => {
  const r = validatePrReviewResult(
    makeArtifact({
      findings: [
        { severity: 'low', category: 'perf', evidence: { path: 'lib/a.mjs' }, finding: 'x', recommendation: 'y' },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('category')));
});

test('rejects an empty evidence.path', () => {
  const r = validatePrReviewResult(
    makeArtifact({
      findings: [
        { severity: 'low', category: 'quality', evidence: { path: '   ' }, finding: 'x', recommendation: 'y' },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('evidence.path')));
});

test('rejects a malformed verdict', () => {
  const r = validatePrReviewResult(makeArtifact({ verdict: 'MAYBE' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('verdict')));
});

test('rejects REQUEST_CHANGES with an empty reason', () => {
  const r = validatePrReviewResult(makeArtifact({ verdict: 'REQUEST_CHANGES:   ' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('verdict')));
});

test('rejects an untagged unverified[] entry', () => {
  const r = validatePrReviewResult(makeArtifact({ unverified: ['no marker here'] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('[UNVERIFIED]')));
});

test('rejects a non-1 schemaVersion', () => {
  const r = validatePrReviewResult(makeArtifact({ schemaVersion: 2 }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('schemaVersion')));
});

test('rejects a non-object artifact', () => {
  assert.equal(validatePrReviewResult(null).ok, false);
  assert.equal(validatePrReviewResult([]).ok, false);
});
