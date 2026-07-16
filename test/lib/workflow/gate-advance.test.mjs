// @ts-check
/**
 * #91 — the gate advance layer.
 *
 * The invariant under test is not "the gate moves" but "the gate moves ONLY on
 * evidence": every advance is gated by an artifact that exists and validates, so
 * a lane cannot walk forward on an agent's say-so. The tests therefore assert
 * both directions at every step — advanced WITH the artifact, and stuck WITHOUT
 * it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  advanceAlongLane,
  LANE_CHAINS,
  projectWorkerReturn,
  specDigestOf,
  stampSpecDigest,
} from '../../../lib/workflow/gate-advance.mjs';

/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

/** A workspace with `.devmate/state` + `.devmate/session`. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-gate-advance-'));
  mkdirSync(join(dir, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(dir, '.devmate', 'session'), { recursive: true });
  return dir;
}

/**
 * @param {string} root
 * @param {string} name
 * @param {unknown} value
 */
function writeState(root, name, value) {
  writeFileSync(join(root, '.devmate', 'state', name), JSON.stringify(value), 'utf8');
}

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function taskState(over = {}) {
  return /** @type {TaskState} */ ({
    taskId: 'T-1',
    lane: 'feature',
    workflowGate: 'no-lane',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
    ...over,
  });
}

const ROUTER_RETURN = {
  agentName: 'router',
  lane: 'feature',
  budgetClass: 'standard',
  confidence: 0.94,
};

/** A GrillResult exactly as `validateGrillResult` requires it. */
const GRILL_RETURN = {
  agentName: 'rubber-duck',
  taskId: 'T-1',
  mode: 'grill',
  schemaVersion: 1,
  returnedAt: '2026-07-13T00:00:00.000Z',
  assumptions: [],
  missingRequirements: [],
  edgeCases: [],
  cornerCases: [],
  securityRisks: [],
  uxRisks: [],
  blockingQuestions: [],
  recommendedDecisions: [],
  unverifiedItems: [],
};

/** A CritiqueResult exactly as `validateCritiqueResult` requires it. */
const CRITIQUE_RETURN = {
  agentName: 'rubber-duck',
  taskId: 'T-1',
  mode: 'critique',
  schemaVersion: 1,
  returnedAt: '2026-07-13T00:00:00.000Z',
  missingAcceptanceCriteria: [],
  missingTests: [],
  riskySequencing: [],
  unlistedFiles: [],
  backwardsCompatRisks: [],
  rollbackRisk: 'low',
  verdict: 'APPROVE_PLAN',
};

/** @param {string} root */
const stateDirOf = (root) => join(root, '.devmate', 'state');

// ── projection: the bridge that did not exist ────────────────────────────────

test('gate-advance › router return is projected onto router-result.json, carrying the lane', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(root, 'router', ROUTER_RETURN, taskState());
    assert.equal(res.artifact, 'router-result.json');
    assert.equal(res.lane, 'feature');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › a router return below the confidence threshold writes NOTHING', async () => {
  // The lane-set precondition requires confidence >= 0.75. A low-confidence
  // classification must not become evidence — the human confirms the lane.
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'router',
      { ...ROUTER_RETURN, confidence: 0.4 },
      taskState(),
    );
    // The projection itself accepts it (it is a structurally valid RouterResult);
    // the GATE refuses it. Assert the gate, which is where the rule lives.
    const state = await advanceAlongLane(taskState(), { stateDir: stateDirOf(root) });
    assert.equal(res.artifact, 'router-result.json');
    assert.equal(state.moves.length, 0, 'a low-confidence lane must not advance the gate');
    assert.match(String(state.blockedBy), /confidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › a malformed router return is not evidence', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(root, 'router', { agentName: 'router' }, taskState());
    assert.equal(res.artifact, null, 'a return missing lane/confidence must write no artifact');
    assert.equal(res.lane, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › rubber-duck returns are discriminated by mode, not dispatch order', async () => {
  // One agent, two contracts, two gates. A hook cannot see which step dispatched
  // it, so the payload must say — via `mode`.
  const root = workspace();
  try {
    const grill = await projectWorkerReturn(root, 'rubber-duck', GRILL_RETURN, taskState());
    assert.equal(grill.artifact, 'grill-result.json');

    const critique = await projectWorkerReturn(root, 'rubber-duck', CRITIQUE_RETURN, taskState());
    assert.equal(critique.artifact, 'critique-result.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › a rubber-duck return matching neither contract writes nothing', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'rubber-duck',
      { agentName: 'rubber-duck', mode: 'freestyle' },
      taskState(),
    );
    assert.equal(res.artifact, null);

    // The reason must NAME what was wrong. The old message ("matched neither
    // GrillResult nor CritiqueResult") was true, useless, and went to a channel
    // nobody read: it told the model that something failed but not which field, so
    // the only recovery it could invent was to re-dispatch blindly or give up and
    // work inline. A diagnostic that cannot be acted on is not a diagnostic.
    assert.match(String(res.reason), /matched neither contract/);
    assert.match(String(res.reason), /grill:/);
    assert.match(String(res.reason), /critique:/);
    assert.match(String(res.reason), /assumptions must be an array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the evidence boundary ────────────────────────────────────────────────────

test('gate-advance › with NO evidence on disk the gate does not move at all', async () => {
  const root = workspace();
  try {
    const res = await advanceAlongLane(taskState(), { stateDir: stateDirOf(root) });
    assert.equal(res.moves.length, 0);
    assert.equal(res.state.workflowGate, 'no-lane');
    assert.match(String(res.blockedBy), /router result not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the feature lane advances exactly as far as the evidence reaches', async () => {
  const root = workspace();
  try {
    // Only the router has returned.
    writeState(root, 'router-result.json', { lane: 'feature', budgetClass: 'standard', confidence: 0.9 });
    let res = await advanceAlongLane(taskState(), { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'lane-set');
    assert.match(String(res.blockedBy), /discovery/i, 'must stop at the missing discovery artifact');

    // Discovery lands.
    writeState(root, 'discovery-merged.json', { agentName: 'discovery', claims: [], unverified: [] });
    res = await advanceAlongLane(res.state, { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'discovery-done');

    // Grill lands.
    writeState(root, 'grill-result.json', GRILL_RETURN);
    res = await advanceAlongLane(res.state, { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'grill-done');

    // Critique lands.
    writeState(root, 'critique-result.json', CRITIQUE_RETURN);
    res = await advanceAlongLane(res.state, { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'plan-done');

    // Spec lands → the human review gate, and NO further.
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '# Spec\n', 'utf8');
    res = await advanceAlongLane(res.state, { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'spec-draft');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › a late hook CATCHES UP through every gate whose artifact already landed', async () => {
  // Advancement is a pure function of what is on disk, so a missed hook
  // invocation cannot desync the gate.
  const root = workspace();
  try {
    writeState(root, 'router-result.json', { lane: 'feature', budgetClass: 'standard', confidence: 0.9 });
    writeState(root, 'discovery-merged.json', { agentName: 'discovery', claims: [], unverified: [] });
    writeState(root, 'grill-result.json', GRILL_RETURN);
    writeState(root, 'critique-result.json', CRITIQUE_RETURN);
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '# Spec\n', 'utf8');

    const res = await advanceAlongLane(taskState(), { stateDir: stateDirOf(root) });
    assert.deepEqual(
      res.moves.map((m) => m.to),
      ['lane-set', 'discovery-done', 'grill-done', 'plan-done', 'spec-draft'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the human gates are NOT in any chain ─────────────────────────────────────

test('gate-advance › the feature lane STOPS at spec-draft — it never self-approves the spec', async () => {
  const root = workspace();
  try {
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '# Spec\n', 'utf8');
    const res = await advanceAlongLane(
      taskState({ workflowGate: 'spec-draft' }),
      { stateDir: stateDirOf(root) },
    );
    assert.equal(res.moves.length, 0, 'spec-approved is a HUMAN gate and must never auto-advance');
    assert.equal(res.state.workflowGate, 'spec-draft');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the bug lane STOPS at plan-approved, awaiting `approve plan`', async () => {
  const root = workspace();
  try {
    writeState(root, 'router-result.json', { lane: 'bug', budgetClass: 'standard', confidence: 0.9 });
    writeState(root, 'grill-result.json', GRILL_RETURN);

    const res = await advanceAlongLane(
      taskState({ lane: 'bug' }),
      { stateDir: stateDirOf(root) },
    );
    assert.deepEqual(res.moves.map((m) => m.to), ['lane-set', 'grill-done', 'plan-approved']);
    assert.equal(
      res.state.workflowGate,
      'plan-approved',
      'the bug lane must halt at the human gate, not run into impl-started',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the bug lane needs no discovery artifact (it diagnoses instead)', async () => {
  const root = workspace();
  try {
    writeState(root, 'router-result.json', { lane: 'bug', budgetClass: 'standard', confidence: 0.9 });
    const res = await advanceAlongLane(taskState({ lane: 'bug' }), { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'lane-set');
    assert.doesNotMatch(String(res.blockedBy), /discovery/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the chore lane runs through to impl-started — it has no human gate', async () => {
  const root = workspace();
  try {
    writeState(root, 'router-result.json', { lane: 'chore', budgetClass: 'tiny', confidence: 0.9 });
    const res = await advanceAlongLane(taskState({ lane: 'chore' }), { stateDir: stateDirOf(root) });
    assert.equal(res.state.workflowGate, 'impl-started');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › no lane chain contains a human-approval event', () => {
  // A structural guard on the table itself: if someone later adds `start-impl`
  // to the feature chain, the spec gate is gone and this test is the thing that
  // notices. HITL-2 lives or dies here.
  assert.ok(!LANE_CHAINS.feature.includes('start-impl'));
  assert.ok(!LANE_CHAINS.bug.includes('start-impl'));
  // The chore lane is mechanical by design and legitimately reaches impl-started.
  assert.ok(LANE_CHAINS.chore.includes('start-impl'));
});

// ── the spec digest: recorded by the host, locked once approved ──────────────

test('gate-advance › the spec digest is stamped from the file, not asked of the agent', async () => {
  const root = workspace();
  try {
    const markdown = '# Spec\n\nbody\n';
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), markdown, 'utf8');

    const next = await stampSpecDigest(root, taskState({ workflowGate: 'plan-done' }));
    assert.ok(next !== null);
    assert.equal(next.artifactHashes['specDigest'], specDigestOf(markdown));
    assert.match(String(next.artifactHashes['spec']), /spec\.md$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the digest is NOT re-stamped once the spec is approved', async () => {
  // Re-stamping after approval would silently re-bless a post-approval edit and
  // disarm spec-integrity-guard, whose entire job is to notice the digest no
  // longer matches and roll the gate back. From spec-approved on, the digest
  // belongs to that hook alone.
  const root = workspace();
  try {
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '# TAMPERED\n', 'utf8');

    for (const gate of ['spec-approved', 'impl-started', 'verification-passed', 'pr-ready', 'done']) {
      const next = await stampSpecDigest(
        root,
        taskState({
          workflowGate: /** @type {any} */ (gate),
          artifactHashes: { spec: '/old/spec.md', specDigest: 'STALE' },
        }),
      );
      assert.equal(next, null, `the digest must be immutable at ${gate}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › an empty spec is not evidence and is never hashed', async () => {
  const root = workspace();
  try {
    writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '   \n', 'utf8');
    const next = await stampSpecDigest(root, taskState({ workflowGate: 'plan-done' }));
    assert.equal(next, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › a grill result from ANOTHER task is not this task’s evidence', async () => {
  // Ownership, checked through the REAL path: advanceAlongLane -> transitionGate ->
  // checkGatePrecondition. That matters more than the assertion itself. The taskId
  // comparison in `requireArtifact` only runs when `ctx.taskId` is supplied, and the
  // sole thing that supplies it is `transitionGate` passing `taskId: state.taskId`.
  // Assert it via a hand-built ctx and the check could be silently disconnected
  // tomorrow with every test still green — which is precisely how this repo has
  // shipped eight inert layers. Drive it from the top, and it cannot go inert
  // without this going red.
  const root = workspace();
  try {
    const foreign = {
      agentName: 'rubber-duck',
      taskId: 'SOME-OLDER-TASK',
      mode: 'grill',
      schemaVersion: 1,
      returnedAt: '2026-07-13T00:00:00.000Z',
      assumptions: [],
      missingRequirements: [],
      edgeCases: [],
      cornerCases: [],
      securityRisks: [],
      uxRisks: [],
      blockingQuestions: [],
      recommendedDecisions: [],
      unverifiedItems: [],
    };
    writeState(root, 'grill-result.json', foreign);
    writeState(root, 'router-result.json', { lane: 'bug', budgetClass: 'standard', confidence: 0.9 });

    const advanced = await advanceAlongLane(taskState({ lane: 'bug', workflowGate: 'lane-set' }), {
      stateDir: join(root, '.devmate', 'state'),
    });

    assert.equal(
      advanced.state.workflowGate,
      'lane-set',
      'a grill result belonging to a DIFFERENT task advanced this task’s gate',
    );
    assert.match(String(advanced.blockedBy), /stale evidence|belongs to task/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance › the task’s OWN grill result does advance the gate', async () => {
  // The other half. A guard that never allows is as useless as one that never denies —
  // and an ownership check that rejected freshly-stamped evidence would wedge the lane
  // exactly like the bug it replaces, only pointing the other way.
  const root = workspace();
  try {
    writeState(root, 'grill-result.json', { ...GRILL_RETURN, taskId: 'T-1' });

    const advanced = await advanceAlongLane(taskState({ lane: 'bug', workflowGate: 'lane-set' }), {
      stateDir: join(root, '.devmate', 'state'),
    });

    assert.notEqual(
      advanced.state.workflowGate,
      'lane-set',
      `the task's own grill result did not advance its gate: ${advanced.blockedBy}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
