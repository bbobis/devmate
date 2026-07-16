// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEGAL_TRANSITIONS, GateTransitionError, advanceGate, isLegalTransition } from '../../lib/gatectl.mjs';

/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

describe('gatectl', () => {
  describe('LEGAL_TRANSITIONS table', () => {
    it('plan-done → spec-draft is a legal transition', () => {
      assert.ok(LEGAL_TRANSITIONS['plan-done'].includes('spec-draft'));
    });

    it('spec-draft → spec-approved is a legal transition', () => {
      assert.ok(LEGAL_TRANSITIONS['spec-draft'].includes('spec-approved'));
    });

    it('spec-approved → spec-draft (rollback) is a legal transition', () => {
      assert.ok(LEGAL_TRANSITIONS['spec-approved'].includes('spec-draft'));
    });

    it('spec-approved → impl-started is a legal transition', () => {
      assert.ok(LEGAL_TRANSITIONS['spec-approved'].includes('impl-started'));
    });

    it('spec-invalidated → spec-draft is a legal transition', () => {
      assert.ok(LEGAL_TRANSITIONS['spec-invalidated'].includes('spec-draft'));
    });

    it('done is a terminal gate with no successors', () => {
      assert.deepEqual(Array.from(LEGAL_TRANSITIONS['done']), []);
    });

    it('LEGAL_TRANSITIONS covers all 12 expected gates', () => {
      /** @type {WorkflowGate[]} */
      const expected = [
        'no-lane', 'lane-set', 'discovery-done', 'grill-done', 'plan-done',
        'spec-draft', 'spec-approved', 'spec-invalidated',
        'impl-started', 'verification-passed', 'pr-ready', 'done',
      ];
      for (const gate of expected) {
        assert.ok(gate in LEGAL_TRANSITIONS, `missing gate: ${gate}`);
      }
    });
  });

  describe('advanceGate', () => {
    it('legal transition returns next gate', () => {
      const next = advanceGate('plan-done', 'spec-draft');
      assert.equal(next, 'spec-draft');
    });

    it('spec-draft → spec-approved returns spec-approved', () => {
      const next = advanceGate('spec-draft', 'spec-approved');
      assert.equal(next, 'spec-approved');
    });

    it('spec-approved → impl-started returns impl-started', () => {
      const next = advanceGate('spec-approved', 'impl-started');
      assert.equal(next, 'impl-started');
    });

    it('spec-draft allows re-entry (spec-draft → spec-draft)', () => {
      const next = advanceGate('spec-draft', 'spec-draft');
      assert.equal(next, 'spec-draft');
    });

    it('spec-invalidated recovery: spec-invalidated → spec-draft', () => {
      const next = advanceGate('spec-invalidated', 'spec-draft');
      assert.equal(next, 'spec-draft');
    });

    it('illegal transition (e.g. spec-draft → done) throws GateTransitionError', () => {
      assert.throws(
        () => advanceGate('spec-draft', 'done'),
        (err) => {
          assert.ok(err instanceof GateTransitionError);
          assert.ok(err.message.includes('spec-draft'));
          assert.ok(err.message.includes('done'));
          return true;
        },
      );
    });

    it('GateTransitionError carries from, to, and legal fields', () => {
      let caught;
      try {
        advanceGate('spec-draft', 'done');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof GateTransitionError);
      assert.equal(caught.from, 'spec-draft');
      assert.equal(caught.to, 'done');
      assert.ok(Array.isArray(caught.legal));
    });
  });

  describe('isLegalTransition', () => {
    it('returns true for plan-done → spec-draft', () => {
      assert.equal(isLegalTransition('plan-done', 'spec-draft'), true);
    });

    it('returns false for spec-draft → done', () => {
      assert.equal(isLegalTransition('spec-draft', 'done'), false);
    });

    it('returns false for done → anything', () => {
      assert.equal(isLegalTransition('done', 'spec-draft'), false);
      assert.equal(isLegalTransition('done', 'impl-started'), false);
    });
  });
});
