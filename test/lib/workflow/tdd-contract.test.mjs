// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTddContract, buildTddPreamble } from '../../../lib/workflow/tdd-contract.mjs';

test('tdd-contract › assertTddContract passes on valid plan with all tddApproach fields', () => {
  const plan = {
    tasks: [
      {
        id: 'AC-1',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/foo.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  };
  assert.doesNotThrow(() => assertTddContract(plan));
});

test('tdd-contract › assertTddContract throws with task id in message when tddApproach missing', () => {
  const plan = {
    tasks: [{ id: 'AC-2' }],
  };
  assert.throws(
    () => assertTddContract(plan),
    /Task AC-2 is missing tddApproach\.testFiles/,
  );
});

test('tdd-contract › assertTddContract throws when tddApproach.testFiles is empty array', () => {
  const plan = {
    tasks: [
      {
        id: 'AC-3',
        tddApproach: {
          testType: 'unit',
          testFiles: [],
          redSummary: 'fails',
        },
      },
    ],
  };
  assert.throws(
    () => assertTddContract(plan),
    /Task AC-3 is missing tddApproach\.testFiles/,
  );
});

test('tdd-contract › buildTddPreamble includes configured verification command', () => {
  const text = buildTddPreamble(
    [
      {
        testType: 'unit',
        testFiles: ['src/foo.spec.ts'],
        redSummary: 'fails first',
      },
    ],
    {
      schemaVersion: 1,
      personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
      verification: { unitTest: 'run-unit-tests' },
    },
  );

  assert.match(text, /TDD_PREAMBLE_REQUIRED/);
  assert.match(text, /run-unit-tests/);
});

test('tdd-contract › buildTddPreamble resolves the unit-test command from checks[]', () => {
  const text = buildTddPreamble(
    [{ testType: 'unit', testFiles: ['src/foo.spec.ts'], redSummary: 'fails first' }],
    {
      schemaVersion: 1,
      personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
      verification: {
        checks: [
          { id: 'lint', command: 'run-lint', category: 'lint' },
          { id: 'unit-test', command: 'run-unit-from-checks', category: 'unit-test' },
        ],
      },
    },
  );

  assert.match(text, /run-unit-from-checks/);
  assert.doesNotMatch(text, /run-lint/);
});

test('tdd-contract › buildTddPreamble marks the unit command NOT CONFIGURED when no unit-test check', () => {
  const text = buildTddPreamble(
    [{ testType: 'unit', testFiles: ['src/foo.spec.ts'], redSummary: 'fails first' }],
    {
      schemaVersion: 1,
      personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
      verification: { checks: [{ id: 'lint', command: 'run-lint', category: 'lint' }] },
    },
  );

  assert.match(text, /Unit test command: \[NOT CONFIGURED\]/);
});
