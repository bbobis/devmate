// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateDevmateConfig,
  loadDevmateConfig,
  findPersona,
  getPersonaTestGlobs,
  resolveDelegationFloorMode,
  resolvePersonaScopeMode,
  resolveDelegationFloorRequirements,
  resolveStaleTaskHours,
  resolveAcCoverageGateMode,
  resolvePrReviewGateMode,
  DEFAULT_STALE_TASK_HOURS,
} from '../../../lib/config/devmate-config.mjs';

test('resolveStaleTaskHours - uses a positive numeric override', () => {
  assert.equal(resolveStaleTaskHours({ staleTaskHours: 12 }), 12);
});

test('resolveStaleTaskHours - falls back to default for missing/invalid values', () => {
  assert.equal(resolveStaleTaskHours({}), DEFAULT_STALE_TASK_HOURS);
  assert.equal(resolveStaleTaskHours(null), DEFAULT_STALE_TASK_HOURS);
  assert.equal(resolveStaleTaskHours({ staleTaskHours: 0 }), DEFAULT_STALE_TASK_HOURS);
  assert.equal(resolveStaleTaskHours({ staleTaskHours: -5 }), DEFAULT_STALE_TASK_HOURS);
  assert.equal(resolveStaleTaskHours({ staleTaskHours: 'soon' }), DEFAULT_STALE_TASK_HOURS);
});

test('validateDevmateConfig - valid config', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/api/**'] },
    ],
    verification: { unitTest: 'run-unit-tests' },
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - missing personas = fail', () => {
  const result = validateDevmateConfig({ schemaVersion: 1 });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - enforceDelegationFloor boolean is accepted', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    enforceDelegationFloor: true,
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - enforceDelegationFloor non-boolean = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    enforceDelegationFloor: 'yes',
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /enforceDelegationFloor/);
});

test('validateDevmateConfig - delegationFloor enum values accepted', () => {
  for (const m of ['off', 'warn', 'block']) {
    const result = validateDevmateConfig({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
      delegationFloor: m,
    });
    assert.equal(result.ok, true, `delegationFloor:${m} must validate`);
  }
});

test('validateDevmateConfig - delegationFloor invalid value = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    delegationFloor: 'nope',
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /delegationFloor/);
});

test('resolveDelegationFloorMode - string wins, boolean back-compat, default off', () => {
  assert.equal(resolveDelegationFloorMode({ delegationFloor: 'warn' }), 'warn');
  assert.equal(resolveDelegationFloorMode({ delegationFloor: 'block', enforceDelegationFloor: false }), 'block');
  assert.equal(resolveDelegationFloorMode({ enforceDelegationFloor: true }), 'block');
  // Explicit string mode wins over the legacy boolean.
  assert.equal(resolveDelegationFloorMode({ delegationFloor: 'off', enforceDelegationFloor: true }), 'off');
  assert.equal(resolveDelegationFloorMode({}), 'off');
  assert.equal(resolveDelegationFloorMode(null), 'off');
});

test('resolvePersonaScopeMode - string wins, default warn', () => {
  assert.equal(resolvePersonaScopeMode({ personaScope: 'off' }), 'off');
  assert.equal(resolvePersonaScopeMode({ personaScope: 'warn' }), 'warn');
  assert.equal(resolvePersonaScopeMode({ personaScope: 'block' }), 'block');
  // Absent / invalid / non-object → default warn.
  assert.equal(resolvePersonaScopeMode({}), 'warn');
  assert.equal(resolvePersonaScopeMode({ personaScope: 'nonsense' }), 'warn');
  assert.equal(resolvePersonaScopeMode(null), 'warn');
});

test('validateDevmateConfig - personaScope enum enforced when present', () => {
  const base = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }] };
  assert.equal(validateDevmateConfig({ ...base, personaScope: 'block' }).ok, true);
  const bad = validateDevmateConfig({ ...base, personaScope: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /personaScope/);
});

test('resolveAcCoverageGateMode - string wins, default off (AC-2, epic #416)', () => {
  assert.equal(resolveAcCoverageGateMode({ acCoverageGate: 'off' }), 'off');
  assert.equal(resolveAcCoverageGateMode({ acCoverageGate: 'warn' }), 'warn');
  assert.equal(resolveAcCoverageGateMode({ acCoverageGate: 'block' }), 'block');
  // Missing key / invalid value / non-object → default off (no legacy boolean).
  assert.equal(resolveAcCoverageGateMode({}), 'off');
  assert.equal(resolveAcCoverageGateMode({ acCoverageGate: 'nonsense' }), 'off');
  assert.equal(resolveAcCoverageGateMode(null), 'off');
});

test('validateDevmateConfig - acCoverageGate enum enforced when present', () => {
  const base = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }] };
  assert.equal(validateDevmateConfig({ ...base, acCoverageGate: 'block' }).ok, true);
  const bad = validateDevmateConfig({ ...base, acCoverageGate: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /acCoverageGate/);
});

test('resolvePrReviewGateMode - string wins, default off (PRR-3)', () => {
  assert.equal(resolvePrReviewGateMode({ prReviewGate: 'off' }), 'off');
  assert.equal(resolvePrReviewGateMode({ prReviewGate: 'warn' }), 'warn');
  assert.equal(resolvePrReviewGateMode({ prReviewGate: 'block' }), 'block');
  // Missing key / invalid value / non-object → default off (no legacy boolean).
  assert.equal(resolvePrReviewGateMode({}), 'off');
  assert.equal(resolvePrReviewGateMode({ prReviewGate: 'nonsense' }), 'off');
  assert.equal(resolvePrReviewGateMode(null), 'off');
});

test('validateDevmateConfig - prReviewGate enum enforced when present', () => {
  const base = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }] };
  assert.equal(validateDevmateConfig({ ...base, prReviewGate: 'block' }).ok, true);
  const bad = validateDevmateConfig({ ...base, prReviewGate: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /prReviewGate/);
});

test('validateDevmateConfig - delegationFloorRequirements valid shape accepted', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    delegationFloorRequirements: { feature: [['discovery'], ['planner']], chore: [] },
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - delegationFloorRequirements bad shapes = fail', () => {
  for (const bad of [{ feature: 'x' }, { feature: [[]] }, { feature: [['']] }, { feature: [123] }, []]) {
    const result = validateDevmateConfig({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
      delegationFloorRequirements: bad,
    });
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test('resolveDelegationFloorRequirements - returns the map or undefined', () => {
  assert.deepEqual(
    resolveDelegationFloorRequirements({ delegationFloorRequirements: { feature: [['discovery']] } }),
    { feature: [['discovery']] },
  );
  assert.equal(resolveDelegationFloorRequirements({}), undefined);
  assert.equal(resolveDelegationFloorRequirements({ delegationFloorRequirements: [] }), undefined);
  assert.equal(resolveDelegationFloorRequirements(null), undefined);
});

test('validateDevmateConfig - empty personas array = fail', () => {
  const result = validateDevmateConfig({ schemaVersion: 1, personas: [] });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - non-object = fail', () => {
  const result = validateDevmateConfig('invalid');
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - persona missing editableGlobs = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend' }],
  });
  assert.equal(result.ok, false);
});

test('loadDevmateConfig - missing file returns ok:false with init hint', () => {
  const result = loadDevmateConfig('/nonexistent/path/devmate.config.json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('devmate init') || result.error.includes('not found'));
  }
});

test('loadDevmateConfig - malformed JSON returns ok:false', () => {
  const tmpFile = join(tmpdir(), `devmate-config-test-${Date.now()}.json`);
  writeFileSync(tmpFile, '{ invalid json }', 'utf8');
  const result = loadDevmateConfig(tmpFile);
  assert.equal(result.ok, false);
  rmSync(tmpFile);
});

test('loadDevmateConfig - valid file returns ok:true with config', () => {
  const tmpFile = join(tmpdir(), `devmate-config-valid-${Date.now()}.json`);
  writeFileSync(
    tmpFile,
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/api/**'], testGlobs: ['**/*.spec.ts'] }],
      verification: { unitTest: 'run-unit-tests' },
    }),
    'utf8'
  );
  const result = loadDevmateConfig(tmpFile);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.personas[0].persona, 'backend');
  }
  rmSync(tmpFile);
});

test('validateDevmateConfig - verification.unitTest missing returns warning, not failure', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.some((warning) => warning.includes('verification.unitTest')));
  }
});

test('validateDevmateConfig - accepts a valid verification.checks list', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: {
      checks: [
        { id: 'unit-test', command: 'npm test', category: 'unit-test', source: 'package.json#scripts.test' },
        { id: 'lint', command: 'npm run lint', category: 'lint', optional: true },
      ],
    },
  });
  assert.equal(result.ok, true);
  // A checks[] unit-test entry satisfies the TDD gate — no warning.
  if (result.ok) {
    assert.ok(!result.warnings?.some((w) => w.includes('TDD gate disabled')));
  }
});

test('validateDevmateConfig - checks[] with no unit-test category warns (TDD gate disabled)', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: { checks: [{ id: 'lint', command: 'npm run lint', category: 'lint' }] },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.warnings?.some((w) => w.includes('TDD gate disabled')));
});

test('validateDevmateConfig - rejects a non-array verification.checks', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: { checks: 'nope' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /verification\.checks must be an array/);
});

test('validateDevmateConfig - rejects a check missing a required field', () => {
  for (const bad of [
    { id: 'x', command: 'cmd' }, // no category
    { id: 'x', category: 'lint' }, // no command
    { command: 'cmd', category: 'lint' }, // no id
    { id: '', command: 'cmd', category: 'lint' }, // empty id
  ]) {
    const result = validateDevmateConfig({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
      verification: { checks: [bad] },
    });
    assert.equal(result.ok, false, `expected reject for ${JSON.stringify(bad)}`);
  }
});

test('validateDevmateConfig - rejects duplicate check ids', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: {
      checks: [
        { id: 'lint', command: 'a', category: 'lint' },
        { id: 'lint', command: 'b', category: 'lint' },
      ],
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /duplicate id/);
});

test('validateDevmateConfig - rejects a non-boolean check.optional', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: { checks: [{ id: 'lint', command: 'a', category: 'lint', optional: 'yes' }] },
  });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - persona testGlobs accepts string arrays', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'frontend', editableGlobs: ['src/**'], testGlobs: ['**/*.spec.ts'] }],
    verification: { unitTest: 'run-unit-tests' },
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - persona testGlobs rejects non-array values', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'frontend', editableGlobs: ['src/**'], testGlobs: 'bad' }],
    verification: { unitTest: 'run-unit-tests' },
  });
  assert.equal(result.ok, false);
});

test('findPersona/getPersonaTestGlobs - return persona metadata helpers', () => {
  const config = {
    schemaVersion: 1,
    personas: [
      { persona: 'frontend', editableGlobs: ['src/**'], testGlobs: ['**/*.spec.ts'] },
    ],
    verification: { unitTest: 'run-unit-tests' },
  };
  const persona = findPersona(config, 'frontend');
  assert.equal(persona?.persona, 'frontend');
  assert.deepEqual(getPersonaTestGlobs(config, 'frontend'), ['**/*.spec.ts']);
});

// ---- E13-2 instructionFile validation ----

test('validateDevmateConfig - instructionFile=null is valid persona config', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/**'], instructionFile: null },
    ],
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - instructionFile as string path is valid persona config', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      {
        persona: 'backend',
        editableGlobs: ['src/**'],
        instructionFile: 'docs/devmate/backend-instructions.md',
      },
    ],
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - omitted instructionFile is valid (backwards compatible)', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/**'] },
    ],
  });
  assert.equal(result.ok, true);
});

test('validateDevmateConfig - instructionFile as number = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/**'], instructionFile: 42 },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('instructionFile'));
  }
});

test('validateDevmateConfig - instructionFile as empty string = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/**'], instructionFile: '   ' },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('instructionFile'));
  }
});
