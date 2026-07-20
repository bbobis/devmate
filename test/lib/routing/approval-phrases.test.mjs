// @ts-check
/**
 * #125: the single-source approval-phrase map and its lane-aware resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVE_PLAN,
  APPROVE_PR,
  APPROVE_SPEC,
  ESCALATE_CHORE_PREFIX,
  HUMAN_GATE_PHRASES,
  NO_TDD_PREFIX,
  RE_PLAN_PREFIX,
  REVISE_SCOPE_PREFIX,
  REVISE_SPEC_PREFIX,
  approvalPhraseForGate,
} from '../../../lib/routing/approval-phrases.mjs';

test('phrase literals are the exact strings the approval listener matches', () => {
  assert.equal(APPROVE_SPEC, 'approve spec');
  assert.equal(APPROVE_PLAN, 'approve plan');
  assert.equal(APPROVE_PR, 'approve pr');
  assert.equal(REVISE_SPEC_PREFIX, 'revise spec:');
  assert.equal(NO_TDD_PREFIX, 'approve no-tdd');
});

test('HUMAN_GATE_PHRASES maps exactly the three human-approval gates', () => {
  assert.deepEqual(HUMAN_GATE_PHRASES, {
    'spec-draft': APPROVE_SPEC,
    'plan-approved': APPROVE_PLAN,
    'verification-passed': APPROVE_PR,
  });
  assert.ok(Object.isFrozen(HUMAN_GATE_PHRASES));
});

test('approvalPhraseForGate is lane-aware at plan-approved', () => {
  assert.equal(approvalPhraseForGate('plan-approved', 'bug'), APPROVE_PLAN);
  assert.equal(approvalPhraseForGate('plan-approved', 'chore'), APPROVE_PLAN);
  // Feature plan-approved accepts only draft-spec (HITL-2) — no phrase fires.
  assert.equal(approvalPhraseForGate('plan-approved', 'feature'), null);
});

test('approvalPhraseForGate is lane-aware at verification-passed', () => {
  assert.equal(approvalPhraseForGate('verification-passed', 'feature'), APPROVE_PR);
  assert.equal(approvalPhraseForGate('verification-passed', 'bug'), APPROVE_PR);
  // Chore's only exit from verification-passed is complete → done; the lane
  // never enters pr-ready, so no phrase may be advertised there.
  assert.equal(approvalPhraseForGate('verification-passed', 'chore'), null);
});

test('approvalPhraseForGate resolves spec-draft for every lane', () => {
  for (const lane of /** @type {const} */ (['feature', 'bug', 'chore'])) {
    assert.equal(approvalPhraseForGate('spec-draft', lane), APPROVE_SPEC);
  }
});

test('approvalPhraseForGate returns null at non-human gates', () => {
  assert.equal(approvalPhraseForGate('impl-started', 'feature'), null);
  assert.equal(approvalPhraseForGate('no-lane', 'bug'), null);
  assert.equal(approvalPhraseForGate('done', 'chore'), null);
  assert.equal(approvalPhraseForGate('parked', 'feature'), null);
});

test('#164: the steering and escalation prefixes are single-sourced here too', () => {
  assert.equal(REVISE_SCOPE_PREFIX, 'revise scope:');
  assert.equal(RE_PLAN_PREFIX, 're-plan:');
  assert.equal(ESCALATE_CHORE_PREFIX, 'escalate chore to feature');
});
