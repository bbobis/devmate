// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMPLEMENTATION_AGENTS,
  LANE_IMPL_REQUIREMENTS,
  isImplementationDispatch,
  evaluateImplementationDispatch,
} from '../../../lib/workflow/dispatch-gate.mjs';
import { PERSONA_MAP } from '../../../lib/workflow/orchestrator.mjs';

/**
 * Minimal TaskState fixture.
 * @param {Partial<import('../../../lib/types.mjs').TaskState>} [overrides]
 * @returns {import('../../../lib/types.mjs').TaskState}
 */
function makeState(overrides) {
  return {
    taskId: 't-1',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc123' },
    preImplStash: null,
    currentStep: 0,
    budget: 5,
    schemaVersion: 1,
    ...overrides,
  };
}

/** @param {import('../../../lib/types.mjs').TaskState} state */
const okState = (state) => ({ ok: /** @type {const} */ (true), state });

const SCOPE_OK = { present: true, nonEmpty: true };
const SCOPE_MISSING = { present: false, nonEmpty: false };

test('IMPLEMENTATION_AGENTS is frozen and mirrors fullstack + PERSONA_MAP keys', () => {
  assert.ok(Object.isFrozen(IMPLEMENTATION_AGENTS));
  assert.deepEqual(
    [...new Set(IMPLEMENTATION_AGENTS)].sort(),
    [...new Set(['fullstack', ...Object.keys(PERSONA_MAP)])].sort(),
  );
});

test('LANE_IMPL_REQUIREMENTS is frozen and artifact-based per lane', () => {
  assert.ok(Object.isFrozen(LANE_IMPL_REQUIREMENTS));
  assert.equal(LANE_IMPL_REQUIREMENTS.feature.spec, true);
  // #92: the feature lane demanded a spec but no edit boundary — @fullstack could
  // start with nothing bounding which files it touched. All three lanes now
  // require the contract.
  assert.equal(LANE_IMPL_REQUIREMENTS.feature.scope, true);
  assert.equal(LANE_IMPL_REQUIREMENTS.bug.diagnosis, true);
  assert.equal(LANE_IMPL_REQUIREMENTS.bug.scope, true);
  assert.equal(LANE_IMPL_REQUIREMENTS.chore.scope, true);
});

test('isImplementationDispatch — implementation agents and their aliases → true', () => {
  for (const name of [
    'fullstack',
    '@fullstack',
    'fullstack.agent',
    'backend',
    'backend.agent',
    'frontend',
    'frontend.agent',
    'editor',
    'EDITOR',
    '  backend  ',
  ]) {
    assert.equal(isImplementationDispatch(name), true, `expected impl for ${JSON.stringify(name)}`);
  }
});

test('isImplementationDispatch — analysis agents and unseen names → false', () => {
  for (const name of [
    'discovery.agent',
    'rubber-duck',
    'security',
    'planner',
    'frontend-tester',
    '',
    'unknown',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isImplementationDispatch(name), false, `expected non-impl for ${JSON.stringify(name)}`);
  }
});

test('evaluate — missing task.json (state not found) → denied naming init-task-state', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: { ok: false, errors: ['State file not found: .devmate/state/task.json'] },
    scope: SCOPE_MISSING,
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /init-task-state/);
  assert.match(result.reason, /missing or unreadable/);
  assert.match(result.reason, /State file not found/);
});

test('evaluate — malformed task.json (state not ok) → denied with the read error', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'backend',
    stateResult: { ok: false, errors: ['Malformed JSON: unexpected token'] },
    scope: SCOPE_MISSING,
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /missing or unreadable/);
  assert.match(result.reason, /Malformed JSON: unexpected token/);
});

test('evaluate — gate not impl-started → denied naming impl-started and the gate', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ workflowGate: 'plan-approved' })),
    scope: SCOPE_OK,
    diagnosisValid: true,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /impl-started/);
  assert.match(result.reason, /plan-approved/);
});

test('evaluate — feature with spec metadata and a scope contract → allowed', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    // #92: the feature lane's edit boundary is now required at dispatch, exactly
    // as it always was for bug and chore.
    scope: SCOPE_OK,
    stateResult: okState(makeState()),
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'allowed');
  assert.equal(result.reason, '');
});

test('evaluate — feature with spec metadata but NO scope contract → denied naming scope.md', () => {
  // INVERTED (#92): the fixture above used to pass SCOPE_MISSING with the comment
  // "feature does not require scope", encoding the fail-open — a feature-lane
  // @fullstack could be dispatched with no file-level boundary at all.
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState()),
    scope: SCOPE_MISSING,
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /scope\.md/);
});

test('evaluate — feature missing spec metadata → denied naming spec artifact metadata', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ artifactHashes: {} })),
    scope: SCOPE_OK,
    diagnosisValid: true,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /spec artifact metadata/);
  assert.match(result.reason, /approve spec/);
});

test('evaluate — feature with spec but missing specDigest → denied', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'frontend',
    stateResult: okState(makeState({ artifactHashes: { spec: '.devmate/session/spec.md' } })),
    scope: SCOPE_OK,
    diagnosisValid: true,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /spec artifact metadata/);
});

test('evaluate — bug with valid diagnosis and scope → allowed', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ lane: 'bug', artifactHashes: {} })),
    scope: SCOPE_OK,
    diagnosisValid: true,
  });
  assert.equal(result.decision, 'allowed');
});

test('evaluate — bug missing diagnosis → denied naming diagnosis.json', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ lane: 'bug', artifactHashes: {} })),
    scope: SCOPE_OK,
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /diagnosis\.json/);
});

test('evaluate — bug missing scope → denied naming scope.md', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ lane: 'bug', artifactHashes: {} })),
    scope: SCOPE_MISSING,
    diagnosisValid: true,
  });
  assert.equal(result.decision, 'denied');
  assert.match(result.reason, /scope\.md/);
});

test('evaluate — chore with scope → allowed; chore without scope → denied', () => {
  const withScope = evaluateImplementationDispatch({
    agentName: 'editor',
    stateResult: okState(makeState({ lane: 'chore', artifactHashes: {} })),
    scope: SCOPE_OK,
    diagnosisValid: false,
  });
  assert.equal(withScope.decision, 'allowed');

  const noScope = evaluateImplementationDispatch({
    agentName: 'editor',
    stateResult: okState(makeState({ lane: 'chore', artifactHashes: {} })),
    scope: SCOPE_MISSING,
    diagnosisValid: false,
  });
  assert.equal(noScope.decision, 'denied');
  assert.match(noScope.reason, /scope\.md/);
});

test('evaluate — unknown lane has no artifact requirement (gate + task only)', () => {
  const result = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: okState(makeState({ lane: /** @type {any} */ ('mystery'), artifactHashes: {} })),
    scope: SCOPE_MISSING,
    diagnosisValid: false,
  });
  assert.equal(result.decision, 'allowed');
});
