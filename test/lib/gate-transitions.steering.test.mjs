// @ts-check
/**
 * E10-05: steering edges make mid-workflow scope changes legal transitions.
 * Each new edge is exercised three ways — legal accept (precondition artifact
 * present in a temp state dir), precondition-fail reject (artifact missing),
 * and illegal-edge reject (event fired from a gate that does not accept it) —
 * plus the park/resume round-trip returning to the recorded gate and the
 * preserve-taskId/completed-work guarantees. Temp dirs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARKABLE_GATES,
  STEERING,
  flattenTransitions,
  legalTransitions,
  transitionGate,
} from '../../lib/gate-transitions.mjs';
import { isLegalTransition } from '../../lib/gatectl.mjs';
import {
  RESUME_POINTER_FILENAME,
  SCOPE_CHANGE_NOTE_FILENAME,
  checkGatePrecondition,
} from '../../lib/gate-preconditions.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */

/** @returns {Promise<string>} a fresh empty state dir */
async function makeStateDir() {
  const root = await mkdtemp(join(tmpdir(), 'gate-steer-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(stateDir, { recursive: true });
  return stateDir;
}

/**
 * Minimal TaskState fixture with completed-work markers to assert preservation.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {TaskState}
 */
function makeState(lane, gate) {
  return /** @type {TaskState} */ ({
    taskId: 'task-steer-001',
    lane,
    workflowGate: gate,
    artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'deadbeef' },
    preImplStash: 'stash@{0}',
    currentStep: 4,
    budget: 7,
    specFiles: ['lib/service/user.mjs', 'ui/components/button.mjs'],
    schemaVersion: 1,
  });
}

/**
 * Seed the session spec.md the HITL-2 spec-draft gate precondition requires —
 * on the revise-scope path the spec exists mid-implementation by definition.
 * @param {string} stateDir
 * @returns {Promise<void>}
 */
async function seedSpec(stateDir) {
  const sessionDir = join(stateDir, '..', 'session');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'spec.md'), '# Spec\n', 'utf8');
}

/**
 * Write a valid scope-change note into the state dir.
 * @param {string} stateDir
 * @param {string} [taskId]
 */
async function writeScopeChangeNote(stateDir, taskId = 'task-steer-001') {
  await writeFile(
    join(stateDir, SCOPE_CHANGE_NOTE_FILENAME),
    JSON.stringify({
      taskId,
      note: 'Drop the CSV export; add JSON streaming instead.',
      capturedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

/**
 * Write a valid resume pointer into the state dir.
 * @param {string} stateDir
 * @param {WorkflowGate} gate
 * @param {string} [taskId]
 */
async function writeResumePointerArtifact(stateDir, gate, taskId = 'task-steer-001') {
  await writeFile(
    join(stateDir, RESUME_POINTER_FILENAME),
    JSON.stringify({ taskId, gate, parkedAt: new Date().toISOString() }),
    'utf8',
  );
}

/** @returns {Record<string, unknown>} a strict-valid critique artifact */
function validCritique() {
  return {
    taskId: 'task-steer-001',
    mode: 'critique',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    missingAcceptanceCriteria: [],
    missingTests: [],
    riskySequencing: [],
    unlistedFiles: [],
    backwardsCompatRisks: [],
    rollbackRisk: 'low',
    verdict: 'APPROVE_PLAN',
  };
}

/** @returns {Record<string, unknown>} a strict-valid grill artifact */
function validGrill() {
  return {
    taskId: 'task-steer-001',
    mode: 'grill',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    assumptions: [],
    missingRequirements: [],
    edgeCases: [],
    cornerCases: [],
    securityRisks: [],
    uxRisks: [],
    blockingQuestions: [],
    recommendedDecisions: [],
    unverifiedItems: ['[UNVERIFIED] example'],
  };
}

// ---- revise-scope: impl-started -> spec-draft ----

test('revise-scope: impl-started -> spec-draft accepted with a captured scope-change note', async () => {
  const stateDir = await makeStateDir();
  await seedSpec(stateDir);
  await writeScopeChangeNote(stateDir);
  const result = await transitionGate(makeState('feature', 'impl-started'), 'revise-scope', { stateDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.from, 'impl-started');
  assert.equal(result.to, 'spec-draft');
  assert.ok(result.state);
  assert.equal(result.state.workflowGate, 'spec-draft');
  assert.equal(result.state.currentStep, 0, 'step index resets within the re-entered gate');
});

test('revise-scope preserves taskId and completed work in the returned state', async () => {
  const stateDir = await makeStateDir();
  await seedSpec(stateDir);
  await writeScopeChangeNote(stateDir);
  const before = makeState('feature', 'impl-started');
  const result = await transitionGate(before, 'revise-scope', { stateDir });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.state);
  assert.equal(result.state.taskId, before.taskId, 'taskId is preserved — never a restart');
  assert.deepEqual(
    /** @type {{ specFiles?: string[] }} */ (result.state).specFiles,
    ['lib/service/user.mjs', 'ui/components/button.mjs'],
    'persisted spec file list (completed workstream input) is not discarded',
  );
  assert.deepEqual(result.state.artifactHashes, before.artifactHashes, 'spec metadata carries over');
  assert.equal(result.state.budget, before.budget, 'budget is not reset');
  assert.equal(result.state.preImplStash, before.preImplStash, 'pre-impl stash ref is preserved');
});

test('revise-scope refused without the scope-change note (precondition fail)', async () => {
  const stateDir = await makeStateDir();
  const result = await transitionGate(makeState('feature', 'impl-started'), 'revise-scope', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /scope-change note/);
});

test('revise-scope refused when the note belongs to another task', async () => {
  const stateDir = await makeStateDir();
  await writeScopeChangeNote(stateDir, 'some-other-task');
  const result = await transitionGate(makeState('feature', 'impl-started'), 'revise-scope', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /belongs to task "some-other-task"/);
});

test('revise-scope is illegal from a gate other than impl-started', async () => {
  const stateDir = await makeStateDir();
  await writeScopeChangeNote(stateDir);
  const result = await transitionGate(makeState('feature', 'verification-passed'), 'revise-scope', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Illegal transition/);
});

test('normal forward path into spec-draft does not require a scope-change note', async () => {
  const noSpecDir = await makeStateDir();
  // HITL-2: the target gate now has its own precondition — a non-empty
  // spec.md — but the revise-scope event requirement must not leak here.
  const noSpec = await checkGatePrecondition('spec-draft', { stateDir: noSpecDir, lane: 'feature' });
  assert.equal(noSpec.ok, false, 'spec-draft without spec.md is refused (HITL-2)');
  assert.match(noSpec.missing.join(' '), /spec\.md/);
  // The event-scoped precondition must not leak onto the plain target gate:
  // spec-draft re-entry (spec-draft -> spec-draft via the recovery loop) and
  // the plan-done -> spec-draft forward step carry no revise-scope event.
  const stateDir = await makeStateDir();
  await seedSpec(stateDir);
  const verdict = await checkGatePrecondition('spec-draft', { stateDir, lane: 'feature' });
  assert.equal(verdict.ok, true, 'spec-draft with spec.md and no steering event passes without a note');
});

// ---- re-plan: impl-started -> plan-done ----

test('re-plan: impl-started -> plan-done accepted when the critique evidence exists', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, 'critique-result.json'), JSON.stringify(validCritique()), 'utf8');
  const result = await transitionGate(makeState('feature', 'impl-started'), 're-plan', { stateDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.from, 'impl-started');
  assert.equal(result.to, 'plan-done');
  assert.ok(result.state);
  assert.equal(result.state.taskId, 'task-steer-001', 're-plan preserves taskId');
});

test('re-plan refused without critique evidence (plan-done precondition)', async () => {
  const stateDir = await makeStateDir();
  const result = await transitionGate(makeState('feature', 'impl-started'), 're-plan', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /critique result/);
});

test('re-plan is illegal from pr-ready', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, 'critique-result.json'), JSON.stringify(validCritique()), 'utf8');
  const result = await transitionGate(makeState('feature', 'pr-ready'), 're-plan', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Illegal transition/);
});

// ---- new-requirements: spec-draft -> grill-done (pre-impl backward step) ----

test('new-requirements: spec-draft -> grill-done accepted when the grill evidence exists', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, 'grill-result.json'), JSON.stringify(validGrill()), 'utf8');
  const result = await transitionGate(makeState('feature', 'spec-draft'), 'new-requirements', { stateDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.from, 'spec-draft');
  assert.equal(result.to, 'grill-done');
});

test('new-requirements refused without grill evidence (grill-done precondition)', async () => {
  const stateDir = await makeStateDir();
  const result = await transitionGate(makeState('feature', 'spec-draft'), 'new-requirements', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /grill result/);
});

test('new-requirements is illegal from impl-started', async () => {
  const stateDir = await makeStateDir();
  await writeFile(join(stateDir, 'grill-result.json'), JSON.stringify(validGrill()), 'utf8');
  const result = await transitionGate(makeState('feature', 'impl-started'), 'new-requirements', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /does not accept event "new-requirements"/);
});

// ---- park / resume / abandon ----

test('park: impl-started -> parked accepted with a persisted resume pointer', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'impl-started');
  const result = await transitionGate(makeState('feature', 'impl-started'), 'park', { stateDir });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.to, 'parked');
  assert.ok(result.state);
  assert.equal(result.state.taskId, 'task-steer-001');
});

test('park refused without a persisted resume pointer (precondition fail)', async () => {
  const stateDir = await makeStateDir();
  const result = await transitionGate(makeState('feature', 'spec-draft'), 'park', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /resume pointer/);
});

test('park works from every parkable gate in every lane', async () => {
  const stateDir = await makeStateDir();
  for (const lane of /** @type {Lane[]} */ (['feature', 'bug', 'chore'])) {
    for (const gate of PARKABLE_GATES) {
      await writeResumePointerArtifact(stateDir, gate);
      const result = await transitionGate(makeState(lane, gate), 'park', { stateDir });
      assert.equal(result.ok, true, `${lane}/${gate}: ${result.error}`);
      assert.equal(result.to, 'parked');
    }
  }
});

test('park is illegal from done and from parked itself; no-lane stays unknown to the event path', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'impl-started');
  const fromDone = await transitionGate(makeState('feature', 'done'), 'park', { stateDir });
  assert.equal(fromDone.ok, false);
  assert.match(fromDone.error ?? '', /Illegal transition/);

  const fromParked = await transitionGate(makeState('feature', 'parked'), 'park', { stateDir });
  assert.equal(fromParked.ok, false);
  assert.match(fromParked.error ?? '', /does not accept event "park"/);

  const fromNoLane = await transitionGate(makeState('feature', 'no-lane'), 'park', { stateDir });
  assert.equal(fromNoLane.ok, false);
});

test('park -> resume round-trip returns to the recorded gate', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'impl-started');
  // HITL-2: resuming a feature task into impl-started re-checks the always-on
  // spec-artifact precondition, which reads task.json from the state dir.
  await writeFile(join(stateDir, 'task.json'), JSON.stringify(makeState('feature', 'parked')), 'utf8');

  const parked = await transitionGate(makeState('feature', 'impl-started'), 'park', { stateDir });
  assert.equal(parked.ok, true, parked.error);
  assert.ok(parked.state);

  const resumed = await transitionGate(parked.state, 'resume', { stateDir });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.from, 'parked');
  assert.equal(resumed.to, 'impl-started', 'resume returns to the gate recorded in the pointer');
  assert.ok(resumed.state);
  assert.equal(resumed.state.taskId, 'task-steer-001', 'the same task continues');
  assert.deepEqual(resumed.state.artifactHashes, parked.state.artifactHashes);
});

test('resume refused when no resume pointer exists', async () => {
  const stateDir = await makeStateDir();
  const result = await transitionGate(makeState('feature', 'parked'), 'resume', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Cannot resume: resume pointer not found/);
});

test('resume refused when the pointer belongs to another task', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'impl-started', 'some-other-task');
  const result = await transitionGate(makeState('feature', 'parked'), 'resume', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /belongs to task "some-other-task"/);
});

test('resume refused when the recorded gate is not parkable', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'done');
  const result = await transitionGate(makeState('feature', 'parked'), 'resume', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not a parkable gate/);
});

test('resume re-checks the target gate precondition on entry', async () => {
  // A task parked at plan-done can only resume once the critique evidence
  // still exists — entering a gate always enforces that gate's requirement.
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'plan-done');
  const refused = await transitionGate(makeState('feature', 'parked'), 'resume', { stateDir });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /critique result/);

  await writeFile(join(stateDir, 'critique-result.json'), JSON.stringify(validCritique()), 'utf8');
  const accepted = await transitionGate(makeState('feature', 'parked'), 'resume', { stateDir });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.to, 'plan-done');
});

test('resume is illegal outside parked', async () => {
  const stateDir = await makeStateDir();
  await writeResumePointerArtifact(stateDir, 'impl-started');
  const result = await transitionGate(makeState('feature', 'impl-started'), 'resume', { stateDir });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /does not accept event "resume"/);
});

test('abandon: any in-flight gate and parked reach the abandoned terminal', async () => {
  const stateDir = await makeStateDir();
  for (const gate of /** @type {WorkflowGate[]} */ (['impl-started', 'spec-draft', 'parked'])) {
    const result = await transitionGate(makeState('feature', gate), 'abandon', { stateDir });
    assert.equal(result.ok, true, `${gate}: ${result.error}`);
    assert.equal(result.to, 'abandoned');
  }
});

test('abandoned is terminal: no event leaves it, and done still accepts no steering', async () => {
  const stateDir = await makeStateDir();
  const fromAbandoned = await transitionGate(makeState('feature', 'abandoned'), 'resume', { stateDir });
  assert.equal(fromAbandoned.ok, false);
  const abandonDone = await transitionGate(makeState('feature', 'done'), 'abandon', { stateDir });
  assert.equal(abandonDone.ok, false);
  assert.match(abandonDone.error ?? '', /none — terminal gate/);
});

// ---- single source of truth: projections agree ----

test('flattenTransitions unions the steering edges (single source of truth)', () => {
  const flat = flattenTransitions();
  assert.ok(flat['impl-started'].includes('spec-draft'), 'impl-started -> spec-draft projected');
  assert.ok(flat['impl-started'].includes('plan-done'), 'impl-started -> plan-done projected');
  assert.ok(flat['spec-draft'].includes('grill-done'), 'spec-draft -> grill-done projected');
  for (const gate of PARKABLE_GATES) {
    assert.ok(flat[gate].includes('parked'), `${gate} -> parked projected`);
    assert.ok(flat[gate].includes('abandoned'), `${gate} -> abandoned projected`);
    assert.ok(flat['parked'].includes(gate), `parked -> ${gate} (resume fan-out) projected`);
  }
  assert.deepEqual(flat['abandoned'], [], 'abandoned is a terminal key with no successors');
  assert.ok(!flat['done'].length, 'done stays terminal');
  assert.ok(!flat['no-lane'].includes('parked'), 'no-lane has no steering edges');
});

test('every steering pair is legal under the gatectl projection', () => {
  for (const [gate, gateTable] of Object.entries(STEERING)) {
    if (gateTable === undefined) continue;
    for (const [event, next] of Object.entries(gateTable)) {
      assert.ok(next !== undefined, `${gate}/${event} has a target`);
      assert.equal(
        isLegalTransition(/** @type {WorkflowGate} */ (gate), next),
        true,
        `${gate} --${event}--> ${next} must be legal under gatectl`,
      );
    }
  }
  for (const gate of PARKABLE_GATES) {
    assert.equal(isLegalTransition('parked', gate), true, `parked -> ${gate} legal under gatectl`);
  }
});

test('PARKABLE_GATES is exactly the set of gates with a park edge', () => {
  const withPark = Object.entries(STEERING)
    .filter(([, events]) => events !== undefined && events.park === 'parked')
    .map(([gate]) => gate);
  assert.deepEqual([...PARKABLE_GATES], withPark);
  assert.ok(!PARKABLE_GATES.includes(/** @type {WorkflowGate} */ ('no-lane')));
  assert.ok(!PARKABLE_GATES.includes(/** @type {WorkflowGate} */ ('done')));
  assert.ok(!PARKABLE_GATES.includes(/** @type {WorkflowGate} */ ('parked')));
  assert.ok(!PARKABLE_GATES.includes(/** @type {WorkflowGate} */ ('abandoned')));
});

test('legalTransitions lists steering successors alongside lane successors', () => {
  const atImpl = legalTransitions('feature', 'impl-started');
  for (const expected of ['verification-passed', 'spec-draft', 'plan-done', 'parked', 'abandoned']) {
    assert.ok(atImpl.includes(/** @type {WorkflowGate} */ (expected)), `impl-started lists ${expected}`);
  }
  assert.deepEqual(legalTransitions('feature', 'done'), [], 'done stays terminal');
  assert.deepEqual(legalTransitions('feature', 'abandoned'), [], 'abandoned is terminal');
});
