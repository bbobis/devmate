// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVerification,
  resolveUnitTestCommand,
  CANONICAL_CATEGORIES,
} from '../../../lib/config/verification.mjs';

test('normalizeVerification - undefined/null/non-object yields empty checks', () => {
  assert.deepEqual(normalizeVerification(undefined), { checks: [] });
  assert.deepEqual(normalizeVerification(null), { checks: [] });
  assert.deepEqual(normalizeVerification(/** @type {any} */ ('nope')), { checks: [] });
});

test('normalizeVerification - checks[] is canonical and wins over legacy keys', () => {
  const checks = [{ id: 'unit-test', command: 'npm test', category: 'unit-test' }];
  const out = normalizeVerification({ checks, unitTest: 'legacy-should-be-ignored' });
  assert.deepEqual(out.checks, checks);
});

test('normalizeVerification - synthesizes checks from legacy keys in fixed order', () => {
  const out = normalizeVerification({ unitTest: 'ut', typeCheck: 'tc', e2e: 'e' });
  assert.deepEqual(out.checks, [
    { id: 'unit-test', command: 'ut', category: 'unit-test', source: 'verification.unitTest' },
    { id: 'type-check', command: 'tc', category: 'type-check', source: 'verification.typeCheck' },
    { id: 'e2e', command: 'e', category: 'e2e', source: 'verification.e2e' },
  ]);
});

test('normalizeVerification - skips blank legacy keys', () => {
  const out = normalizeVerification({ unitTest: 'ut', typeCheck: '   ', e2e: '' });
  assert.deepEqual(out.checks.map((c) => c.id), ['unit-test']);
});

test('normalizeVerification - empty checks[] is canonical (no legacy) → empty', () => {
  assert.deepEqual(normalizeVerification({ checks: [] }), { checks: [] });
});

test('normalizeVerification - an explicit EMPTY checks[] wins over legacy keys', () => {
  // Regression: an explicit checks: [] must honor "no checks" and NOT resurrect
  // legacy unitTest/typeCheck/e2e (which would silently re-enable commands and
  // suppress the TDD-gate-disabled warning).
  assert.deepEqual(
    normalizeVerification({ checks: [], unitTest: 'npm test', e2e: 'cypress' }),
    { checks: [] },
  );
  assert.equal(
    resolveUnitTestCommand(/** @type {any} */ ({ verification: { checks: [], unitTest: 'npm test' } })),
    null,
  );
});

test('resolveUnitTestCommand - finds the first unit-test category check', () => {
  const config = {
    verification: {
      checks: [
        { id: 'lint', command: 'run-lint', category: 'lint' },
        { id: 'unit-test', command: 'run-units', category: 'unit-test' },
        { id: 'unit-test-2', command: 'other-units', category: 'unit-test' },
      ],
    },
  };
  assert.equal(resolveUnitTestCommand(/** @type {any} */ (config)), 'run-units');
});

test('resolveUnitTestCommand - resolves the legacy unitTest key', () => {
  assert.equal(
    resolveUnitTestCommand(/** @type {any} */ ({ verification: { unitTest: 'legacy-ut' } })),
    'legacy-ut',
  );
});

test('resolveUnitTestCommand - null when no unit-test command configured', () => {
  assert.equal(
    resolveUnitTestCommand(/** @type {any} */ ({ verification: { checks: [{ id: 'lint', command: 'l', category: 'lint' }] } })),
    null,
  );
  assert.equal(resolveUnitTestCommand(/** @type {any} */ ({})), null);
});

test('CANONICAL_CATEGORIES - documents the conventional vocabulary and is frozen', () => {
  assert.ok(CANONICAL_CATEGORIES.includes('unit-test'));
  assert.ok(CANONICAL_CATEGORIES.includes('lint'));
  assert.ok(Object.isFrozen(CANONICAL_CATEGORIES));
});
