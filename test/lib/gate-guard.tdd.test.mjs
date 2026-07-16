// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTddPreCondition,
  applyTddGuardTransition,
  evaluateGuard,
  DEFAULT_TEST_GLOBS,
  INITIAL_TDD_GUARD,
} from '../../lib/gate-guard-core.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').TddGuardState} TddGuardState */
/** @typedef {import('../../lib/types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../../lib/types.mjs').ConfigResult} ConfigResult */

const TEST_GLOBS = ['test/**', '**/*.test.mjs'];

/** @returns {TddGuardState} */
function fresh() {
  return { ...INITIAL_TDD_GUARD };
}

/** @param {Partial<TaskState>} [over] @returns {TaskState} */
function makeState(over) {
  return {
    taskId: 'T1',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

/** @returns {ConfigResult} */
function makeConfig() {
  /** @type {DevmateConfig} */
  const config = {
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['lib/**', 'test/**'] },
    ],
    testGlobs: TEST_GLOBS,
  };
  return { ok: true, config };
}

describe('evaluateTddPreCondition (pure)', () => {
  it('test file write returns allow', () => {
    const r = evaluateTddPreCondition('test/foo.test.mjs', fresh(), TEST_GLOBS);
    assert.equal(r, 'allow');
  });

  it('first non-test source write without prior test returns block', () => {
    const r = evaluateTddPreCondition('lib/foo.mjs', fresh(), TEST_GLOBS);
    assert.equal(r, 'block');
  });

  it('subsequent non-test writes without prior test also return block', () => {
    const after1 = applyTddGuardTransition(fresh(), 'block', 'lib/foo.mjs', TEST_GLOBS);
    const r = evaluateTddPreCondition('lib/bar.mjs', after1, TEST_GLOBS);
    assert.equal(r, 'block');
  });

  it('non-test write after test write returns allow (resets counter)', () => {
    const afterTest = applyTddGuardTransition(fresh(), 'allow', 'test/foo.test.mjs', TEST_GLOBS);
    assert.equal(afterTest.testFileWritten, true);
    const r = evaluateTddPreCondition('lib/foo.mjs', afterTest, TEST_GLOBS);
    assert.equal(r, 'allow');
  });

  it('overrideGranted=true returns allow regardless of test state', () => {
    const overridden = { ...fresh(), overrideGranted: true, consecutiveNonTestWrites: 99 };
    const r = evaluateTddPreCondition('lib/foo.mjs', overridden, TEST_GLOBS);
    assert.equal(r, 'allow');
  });

  it('config file (non-source extension) returns allow (not subject to rule)', () => {
    const r1 = evaluateTddPreCondition('devmate.config.json', fresh(), TEST_GLOBS);
    const r2 = evaluateTddPreCondition('package.json', fresh(), TEST_GLOBS);
    const r3 = evaluateTddPreCondition('docs/foo.md', fresh(), TEST_GLOBS);
    assert.equal(r1, 'allow');
    assert.equal(r2, 'allow');
    assert.equal(r3, 'allow');
  });

  it('pure function: same inputs always return same output', () => {
    const a = evaluateTddPreCondition('lib/foo.mjs', fresh(), TEST_GLOBS);
    const b = evaluateTddPreCondition('lib/foo.mjs', fresh(), TEST_GLOBS);
    const c = evaluateTddPreCondition('lib/foo.mjs', fresh(), TEST_GLOBS);
    assert.equal(a, 'block');
    assert.equal(b, 'block');
    assert.equal(c, 'block');
  });

  it('uses DEFAULT_TEST_GLOBS when caller provides no override', () => {
    const r = evaluateTddPreCondition(
      'src/foo.test.mjs',
      fresh(),
      DEFAULT_TEST_GLOBS.slice(),
    );
    assert.equal(r, 'allow');
  });
});

describe('applyTddGuardTransition', () => {
  it('test path always sets testFileWritten=true and resets counter', () => {
    const prev = { testFileWritten: false, consecutiveNonTestWrites: 5, overrideGranted: false };
    const next = applyTddGuardTransition(prev, 'allow', 'test/x.test.mjs', TEST_GLOBS);
    assert.equal(next.testFileWritten, true);
    assert.equal(next.consecutiveNonTestWrites, 0);
  });

  it('block on source path increments the counter when no test has been written', () => {
    const prev = fresh();
    const next = applyTddGuardTransition(prev, 'block', 'lib/foo.mjs', TEST_GLOBS);
    assert.equal(next.consecutiveNonTestWrites, 1);
  });

  it('non-source path leaves the state unchanged', () => {
    const prev = { testFileWritten: false, consecutiveNonTestWrites: 1, overrideGranted: false };
    const next = applyTddGuardTransition(prev, 'block', 'docs/readme.md', TEST_GLOBS);
    assert.deepEqual(next, prev);
  });

  it('allow after test resets counter back to 0', () => {
    const prev = { testFileWritten: true, consecutiveNonTestWrites: 1, overrideGranted: false };
    const next = applyTddGuardTransition(prev, 'allow', 'lib/foo.mjs', TEST_GLOBS);
    assert.equal(next.consecutiveNonTestWrites, 0);
  });
});

describe('evaluateGuard Rule 7 integration', () => {
  // #92: Rule 6 runs BEFORE the TDD rule and now fails closed — a source edit at
  // any gate where editing is permitted needs the lane's edit boundary. Every
  // fixture below therefore carries the contract covering the files it writes,
  // so what these tests exercise is still the TDD pre-condition and not the
  // missing scope contract that would otherwise deny first.
  const scope = /** @type {import('../../lib/types.mjs').ParsedScope} */ ({
    lane: 'feature',
    allowedPaths: ['lib/foo.mjs'],
    allowedGlobs: ['test/**'],
  });

  it('rule not evaluated when gate is not impl-started', () => {
    const state = makeState({
      workflowGate: 'verification-passed',
      tddGuard: { testFileWritten: false, consecutiveNonTestWrites: 1, overrideGranted: false },
    });
    const r = evaluateGuard(
      { tool_name: 'write_file', path: 'lib/foo.mjs' },
      state,
      makeConfig(),
      { scope },
    );
    assert.equal(r.decision, 'allow');
  });

  it('denies the first non-test source write during impl-started', () => {
    const state = makeState({
      tddGuard: { testFileWritten: false, consecutiveNonTestWrites: 0, overrideGranted: false },
    });
    const r = evaluateGuard(
      { tool_name: 'write_file', path: 'lib/foo.mjs' },
      state,
      makeConfig(),
      { scope },
    );
    assert.equal(r.decision, 'deny');
    assert.match(r.reason ?? '', /TDD pre-condition/);
  });

  it('override path is honored', () => {
    const state = makeState({
      tddGuard: { testFileWritten: false, consecutiveNonTestWrites: 5, overrideGranted: true, overrideReason: 'migration' },
    });
    const r = evaluateGuard(
      { tool_name: 'write_file', path: 'lib/foo.mjs' },
      state,
      makeConfig(),
      { scope },
    );
    assert.equal(r.decision, 'allow');
  });

  it('test file write is allowed even with no prior test recorded', () => {
    const state = makeState({ tddGuard: { ...INITIAL_TDD_GUARD } });
    const r = evaluateGuard(
      { tool_name: 'write_file', path: 'test/foo.test.mjs' },
      state,
      makeConfig(),
      { scope },
    );
    assert.equal(r.decision, 'allow');
  });
});
