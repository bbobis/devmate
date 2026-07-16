// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transitionGate, legalTransitions, TRANSITIONS } from '../../lib/gate-transitions.mjs';

// These suites exercise the transition-table semantics only; artifact
// preconditions (E9-15/E9-13) are covered by their own suites, so inject a
// permissive precondition to keep the table tests hermetic.
/** @type {{ checkPrecondition: () => Promise<{ ok: boolean, missing: string[] }> }} */
const NO_PRECONDITIONS = { checkPrecondition: async () => ({ ok: true, missing: [] }) };

/**
 * @param {import('../../lib/types.mjs').Lane} lane
 * @param {import('../../lib/types.mjs').WorkflowGate} workflowGate
 * @param {number} [currentStep]
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function makeState(lane, workflowGate, currentStep = 1) {
  return {
    taskId: 'test-task',
    lane,
    workflowGate,
    artifactHashes: {},
    preImplStash: null,
    currentStep,
    budget: 10,
    schemaVersion: 1,
  };
}

describe('gate-transitions', () => {
  describe('feature lane', () => {
    it('plan-approved + approve-plan -> illegal (event not defined for gate)', async () => {
      const result = await transitionGate(makeState('feature', 'plan-approved'), 'approve-plan', NO_PRECONDITIONS);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes('plan-approved'), `error should mention gate: ${result.error}`);
    });

    it('plan-approved + start-impl -> illegal (HITL-2: the spec-gate bypass edge is gone)', async () => {
      const result = await transitionGate(makeState('feature', 'plan-approved', 5), 'start-impl', NO_PRECONDITIONS);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes('spec-draft'), `legal alternative not listed: ${result.error}`);
    });

    it('plan-approved + draft-spec -> spec-draft; currentStep resets to 0', async () => {
      const result = await transitionGate(makeState('feature', 'plan-approved', 5), 'draft-spec', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'spec-draft');
      assert.equal(result.state.currentStep, 0);
      assert.equal(result.from, 'plan-approved');
      assert.equal(result.to, 'spec-draft');
    });

    it('spec-approved + start-impl -> impl-started (the only start-impl entry on the feature lane)', async () => {
      const result = await transitionGate(makeState('feature', 'spec-approved', 5), 'start-impl', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'impl-started');
      assert.equal(result.state.currentStep, 0);
    });

    it('bug/chore plan-approved + draft-spec -> illegal (lane-owned feature edge does not leak)', async () => {
      for (const lane of /** @type {import('../../lib/types.mjs').Lane[]} */ (['bug', 'chore'])) {
        const result = await transitionGate(makeState(lane, 'plan-approved'), 'draft-spec', NO_PRECONDITIONS);
        assert.equal(result.ok, false, `draft-spec must be illegal for ${lane}`);
      }
    });

    it('impl-started + pass-verification -> verification-passed', async () => {
      const result = await transitionGate(makeState('feature', 'impl-started'), 'pass-verification', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'verification-passed');
    });

    it('verification-passed + mark-pr-ready -> pr-ready', async () => {
      const result = await transitionGate(makeState('feature', 'verification-passed'), 'mark-pr-ready', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'pr-ready');
    });

    it('pr-ready + complete -> done', async () => {
      const result = await transitionGate(makeState('feature', 'pr-ready'), 'complete', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'done');
    });
  });

  describe('bug lane \u2014 full happy path', () => {
    it('plan-approved -> impl-started -> verification-passed -> pr-ready -> done', async () => {
      let state = makeState('bug', 'plan-approved');

      let r = await transitionGate(state, 'start-impl', NO_PRECONDITIONS);
      assert.equal(r.ok, true);
      assert.ok(r.state);
      state = r.state;
      assert.equal(state.workflowGate, 'impl-started');

      r = await transitionGate(state, 'pass-verification', NO_PRECONDITIONS);
      assert.equal(r.ok, true);
      assert.ok(r.state);
      state = r.state;
      assert.equal(state.workflowGate, 'verification-passed');

      r = await transitionGate(state, 'mark-pr-ready', NO_PRECONDITIONS);
      assert.equal(r.ok, true);
      assert.ok(r.state);
      state = r.state;
      assert.equal(state.workflowGate, 'pr-ready');

      r = await transitionGate(state, 'complete', NO_PRECONDITIONS);
      assert.equal(r.ok, true);
      assert.ok(r.state);
      state = r.state;
      assert.equal(state.workflowGate, 'done');
    });
  });

  describe('chore lane', () => {
    it('verification-passed + complete -> done (skips pr-ready)', async () => {
      const result = await transitionGate(makeState('chore', 'verification-passed'), 'complete', NO_PRECONDITIONS);
      assert.equal(result.ok, true);
      assert.ok(result.state);
      assert.equal(result.state.workflowGate, 'done');
    });

    it('verification-passed + mark-pr-ready -> { ok: false } listing complete as legal', async () => {
      const result = await transitionGate(makeState('chore', 'verification-passed'), 'mark-pr-ready', NO_PRECONDITIONS);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes('done'), `error should list 'done' as legal: ${result.error}`);
    });
  });

  describe('illegal event error messages', () => {
    it('error message contains current gate name and lists legal alternatives', async () => {
      const result = await transitionGate(makeState('feature', 'impl-started'), 'approve-plan', NO_PRECONDITIONS);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes('impl-started'), `gate not in error: ${result.error}`);
      assert.ok(result.error && result.error.includes('verification-passed'), `legal gate not in error: ${result.error}`);
    });

    it('unknown lane returns { ok: false } with informative error', async () => {
      const state = makeState('feature', 'plan-approved');
      // @ts-ignore \u2014 intentional bad lane for test
      state.lane = 'unknown-lane';
      const result = await transitionGate(state, 'start-impl', NO_PRECONDITIONS);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.includes('unknown-lane'), `error: ${result.error}`);
    });
  });

  describe('legalTransitions', () => {
    it('legalTransitions(feature, done) -> []', async () => {
      const result = legalTransitions('feature', 'done');
      assert.deepEqual(result, []);
    });

    it('legalTransitions(chore, verification-passed) -> includes done, does not include pr-ready', async () => {
      const result = legalTransitions('chore', 'verification-passed');
      assert.ok(result.includes('done'), `should include done: ${JSON.stringify(result)}`);
      assert.ok(!result.includes('pr-ready'), `should not include pr-ready: ${JSON.stringify(result)}`);
    });

    it('legalTransitions returns [] for done in all lanes', async () => {
      const lanes = /** @type {import('../../lib/types.mjs').Lane[]} */ (Object.keys(TRANSITIONS));
      for (const lane of lanes) {
        const result = legalTransitions(lane, 'done');
        assert.deepEqual(result, [], `expected [] for lane ${lane} at done`);
      }
    });
  });

  describe('TRANSITIONS coverage', () => {
    it('TRANSITIONS covers all three lanes', async () => {
      assert.ok('feature' in TRANSITIONS);
      assert.ok('bug' in TRANSITIONS);
      assert.ok('chore' in TRANSITIONS);
    });

    it('each lane has an entry for every gate from E1-1', async () => {
      const gates = /** @type {import('../../lib/types.mjs').WorkflowGate[]} */ (
        ['plan-approved', 'impl-started', 'verification-passed', 'pr-ready', 'done']
      );
      const lanes = /** @type {import('../../lib/types.mjs').Lane[]} */ (['feature', 'bug', 'chore']);
      for (const lane of lanes) {
        for (const gate of gates) {
          assert.ok(gate in TRANSITIONS[lane], `missing gate ${gate} in lane ${lane}`);
        }
      }
    });
  });
});
