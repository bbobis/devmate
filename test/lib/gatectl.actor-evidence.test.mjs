// @ts-check
/**
 * E10-03 (#339): human-gate transitions carry an actor + evidence audit trail.
 *
 * Covers the API path (`advanceHumanGate` in lib/gatectl.mjs), the trace
 * schema extension (optional actor/evidence on gate_transition), and the
 * exact-phrase hook fast path stamping `actor: "hook-exact-phrase"`.
 * Temp dirs only — the repo tree is never written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceGate,
  advanceHumanGate,
  GateTransitionError,
  HUMAN_APPROVAL_GATES,
  HumanGateAuditError,
  isHumanApprovalGate,
} from '../../lib/gatectl.mjs';
import { validateTraceEvent } from '../../lib/trace/schema.mjs';
import { handleUserPromptSubmit } from '../../hooks/approval-listener.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: 'task-ae',
    lane: 'feature',
    workflowGate: 'spec-draft',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 3,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp repo root with task.json (and spec.md so the spec-approved
 * precondition passes). Returns paths plus a cleanup function.
 * @param {Partial<TaskState>} [stateOverrides]
 * @returns {{ root: string, statePath: string, tracePath: string, cleanup: () => void }}
 */
function makeFixture(stateOverrides) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-actor-evidence-'));
  const stateDir = join(root, '.devmate', 'state');
  const sessionDir = join(root, '.devmate', 'session');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const state = makeState(stateOverrides);
  const statePath = join(stateDir, 'task.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  writeFileSync(join(sessionDir, 'spec.md'), '# Spec\n\n## Out of scope\n', 'utf8');
  return {
    root,
    statePath,
    tracePath: join(stateDir, 'trace', `${state.taskId}.jsonl`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Read a JSONL trace file and parse each line.
 * @param {string} path
 * @returns {Array<Record<string, unknown>>}
 */
function readTrace(path) {
  if (!existsSync(path)) return [];
  return /** @type {Record<string, unknown>[]} */ (parseJsonl(readFileSync(path, 'utf8')));
}

test('advanceHumanGate — spec-draft → spec-approved without evidence throws HumanGateAuditError, no side effects', async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      advanceHumanGate('spec-draft', 'spec-approved', {
        actor: 'orchestrator',
        evidence: '',
        root: fx.root,
      }),
      (/** @type {unknown} */ err) =>
        err instanceof HumanGateAuditError && err.target === 'spec-approved',
    );
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    assert.equal(state.workflowGate, 'spec-draft', 'gate must not move');
    assert.deepEqual(readTrace(fx.tracePath), [], 'no trace event must be written');
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — missing actor is rejected just like missing evidence', async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      advanceHumanGate('spec-draft', 'spec-approved', {
        actor: '   ',
        evidence: 'yes please ship it',
        root: fx.root,
      }),
      HumanGateAuditError,
    );
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — with actor + evidence persists the gate and writes an audited gate_transition event', async () => {
  const fx = makeFixture();
  try {
    const result = await advanceHumanGate('spec-draft', 'spec-approved', {
      actor: 'orchestrator',
      evidence: 'looks good, go ahead',
      root: fx.root,
    });
    assert.equal(result.from, 'spec-draft');
    assert.equal(result.to, 'spec-approved');
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    assert.equal(state.workflowGate, 'spec-approved');
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]['type'], 'gate_transition');
    assert.equal(events[0]['from'], 'spec-draft');
    assert.equal(events[0]['to'], 'spec-approved');
    assert.equal(events[0]['gate'], 'spec-approved');
    assert.equal(events[0]['actor'], 'orchestrator');
    assert.equal(events[0]['evidence'], 'looks good, go ahead');
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — illegal edge spec-draft → pr-ready is rejected even with a full audit pair', async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      advanceHumanGate('spec-draft', 'pr-ready', {
        actor: 'orchestrator',
        evidence: 'ship it',
        root: fx.root,
      }),
      GateTransitionError,
    );
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    assert.equal(state.workflowGate, 'spec-draft');
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — unproven transition is rejected by the gate precondition (spec.md missing)', async () => {
  const fx = makeFixture();
  try {
    rmSync(join(fx.root, '.devmate', 'session', 'spec.md'));
    await assert.rejects(
      advanceHumanGate('spec-draft', 'spec-approved', {
        actor: 'orchestrator',
        evidence: 'approved',
        root: fx.root,
      }),
      /precondition|spec\.md not found/i,
    );
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    assert.equal(state.workflowGate, 'spec-draft');
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — stale caller belief (task.json at a different gate) throws without side effects', async () => {
  const fx = makeFixture({ workflowGate: 'verification-passed' });
  try {
    await assert.rejects(
      advanceHumanGate('spec-draft', 'spec-approved', {
        actor: 'orchestrator',
        evidence: 'approved',
        root: fx.root,
      }),
      /stale gate/,
    );
    assert.deepEqual(readTrace(fx.tracePath), []);
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — verification-passed → pr-ready succeeds with an audit pair', async () => {
  const fx = makeFixture({ workflowGate: 'verification-passed' });
  try {
    const result = await advanceHumanGate('verification-passed', 'pr-ready', {
      actor: 'orchestrator',
      evidence: 'PR approved, merge it',
      root: fx.root,
    });
    assert.equal(result.to, 'pr-ready');
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]['actor'], 'orchestrator');
    assert.equal(events[0]['evidence'], 'PR approved, merge it');
  } finally {
    fx.cleanup();
  }
});

test('internal/auto gate advances need no audit pair (no regression)', () => {
  // The auto paths (advanceGate / transitionGate) are untouched by E10-03.
  assert.equal(advanceGate('plan-done', 'spec-draft'), 'spec-draft');
  assert.equal(advanceGate('spec-approved', 'impl-started'), 'impl-started');
  assert.deepEqual([...HUMAN_APPROVAL_GATES], ['spec-approved', 'pr-ready']);
  assert.equal(isHumanApprovalGate('spec-approved'), true);
  assert.equal(isHumanApprovalGate('pr-ready'), true);
  assert.equal(isHumanApprovalGate('impl-started'), false);
});

test('trace schema — gate_transition accepts optional actor/evidence and rejects wrong kinds', () => {
  const base = {
    type: 'gate_transition',
    taskId: 't1',
    stepId: 's1',
    ts: new Date().toISOString(),
    schemaVersion: 1,
    from: 'spec-draft',
    to: 'spec-approved',
    gate: 'spec-approved',
  };
  assert.equal(validateTraceEvent(base).ok, true, 'event without audit pair stays valid');
  assert.equal(
    validateTraceEvent({ ...base, actor: 'orchestrator', evidence: 'yes' }).ok,
    true,
    'event with audit pair is valid',
  );
  const bad = validateTraceEvent({ ...base, actor: 42 });
  assert.equal(bad.ok, false, 'non-string actor must be rejected when present');
  assert.match(bad.errors.join('; '), /actor/);
});

test('hook fast path — exact phrase "approve pr" stamps actor hook-exact-phrase with the raw prompt as evidence', async () => {
  const fx = makeFixture({ workflowGate: 'verification-passed' });
  try {
    const result = await handleUserPromptSubmit({
      prompt: '  Approve PR  ',
      root: fx.root,
    });
    assert.equal(result.action, 'gate_advanced');
    assert.equal(result.gate, 'pr-ready');
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]['type'], 'gate_transition');
    assert.equal(events[0]['actor'], 'hook-exact-phrase');
    assert.equal(events[0]['evidence'], 'Approve PR', 'evidence carries the trimmed raw prompt');
  } finally {
    fx.cleanup();
  }
});

test('advanceHumanGate — a parked task refuses approval phrases outright (#20): resume is the only way out', async () => {
  // The flattened table lists every parkable gate as a successor of `parked`
  // so `resume`'s dynamic target is representable. That fan-out must never
  // double as an approval edge: with spec.md on disk, parked → spec-approved
  // and parked → pr-ready would otherwise pass edge legality AND their
  // preconditions, un-parking the task while skipping resume's re-check of
  // the recorded gate.
  const { root, statePath, tracePath, cleanup } = makeFixture({ workflowGate: 'parked' });
  try {
    await assert.rejects(
      advanceHumanGate('parked', 'spec-approved', {
        actor: 'hook-exact-phrase',
        evidence: 'approve spec',
        root,
      }),
      /parked.*[Rr]esume/s,
    );
    await assert.rejects(
      advanceHumanGate('parked', 'pr-ready', {
        actor: 'hook-exact-phrase',
        evidence: 'approve pr',
        root,
      }),
      /parked.*[Rr]esume/s,
    );

    // No side effects: the gate stays parked and nothing was traced.
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(persisted.workflowGate, 'parked');
    assert.deepEqual(readTrace(tracePath), []);
  } finally {
    cleanup();
  }
});
