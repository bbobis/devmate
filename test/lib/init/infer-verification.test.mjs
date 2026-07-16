// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferVerificationChecks, MAX_INFERRED_CHECKS } from '../../../lib/init/infer-verification.mjs';

/** @typedef {import('../../../lib/types.mjs').VerificationCandidate} VerificationCandidate */

/**
 * @param {Partial<VerificationCandidate>} over
 * @returns {VerificationCandidate}
 */
function candidate(over) {
  return { command: 'cmd', category: 'unit-test', source: 'package.json#scripts.test', confidence: 0.9, ...over };
}

test('inferVerificationChecks - promotes recognized categories with stable ids + source', () => {
  const checks = inferVerificationChecks([
    candidate({ command: 'npm test', category: 'unit-test', source: 'package.json#scripts.test' }),
    candidate({ command: 'npm run lint', category: 'lint', source: 'package.json#scripts.lint' }),
  ]);
  assert.deepEqual(checks, [
    { id: 'unit-test', command: 'npm test', category: 'unit-test', source: 'package.json#scripts.test' },
    { id: 'lint', command: 'npm run lint', category: 'lint', source: 'package.json#scripts.lint' },
  ]);
});

test('inferVerificationChecks - drops unknown-category candidates', () => {
  const checks = inferVerificationChecks([
    candidate({ command: 'make deploy', category: 'unknown', source: 'Makefile#deploy' }),
    candidate({ command: 'npm test', category: 'unit-test' }),
  ]);
  assert.deepEqual(checks.map((c) => c.id), ['unit-test']);
});

test('inferVerificationChecks - dedupes by normalized command (first/highest-confidence wins)', () => {
  const checks = inferVerificationChecks([
    candidate({ command: 'npm test', category: 'unit-test', source: 'package.json#scripts.test', confidence: 0.95 }),
    candidate({ command: 'npm test', category: 'unit-test', source: '.github/workflows/ci.yml#run', confidence: 0.4 }),
  ]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].source, 'package.json#scripts.test');
});

test('inferVerificationChecks - suffixes duplicate category ids deterministically', () => {
  const checks = inferVerificationChecks([
    candidate({ command: 'npm test', category: 'unit-test' }),
    candidate({ command: 'pytest', category: 'unit-test', source: 'pyproject.toml' }),
  ]);
  assert.deepEqual(checks.map((c) => c.id), ['unit-test', 'unit-test-2']);
});

test('inferVerificationChecks - caps at MAX_INFERRED_CHECKS', () => {
  const many = Array.from({ length: MAX_INFERRED_CHECKS + 5 }, (_, i) =>
    candidate({ command: `npm run lint-${i}`, category: 'lint', source: `package.json#scripts.lint-${i}` }),
  );
  assert.equal(inferVerificationChecks(many).length, MAX_INFERRED_CHECKS);
});

test('inferVerificationChecks - empty input yields empty list', () => {
  assert.deepEqual(inferVerificationChecks([]), []);
});
