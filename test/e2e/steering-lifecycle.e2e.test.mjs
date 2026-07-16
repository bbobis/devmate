// @ts-check
/**
 * END-TO-END: the steering and lifecycle edges (E10-05) — `revise-scope`,
 * `re-plan`, `new-requirements`, `park`, `resume`, `abandon` — driven through
 * the REAL runtime callers, asserting that every edge continues the SAME task
 * (taskId and completed work preserved), re-checks its target precondition,
 * and REFUSES cleanly (naming the missing artifact) instead of dead-ending
 * when its precondition artifact is absent.
 *
 * ## How the edges are driven
 *
 * Steering events have no approval phrase: the documented runtime caller is
 * the `gatectl workflow set <event>` CLI (docs/gates.md § Steering transitions
 * and § Subcommand syntax), run in the integrated terminal. So each edge here
 * spawns the real `scripts/gatectl.mjs` as a subprocess with cwd = the
 * workspace's own `.devmate/` folder — the same doubled-path hazard the hooks
 * face (#76) — and the oracle is what landed on disk, never the CLI's word.
 *
 * Park/resume across sessions additionally runs the real `SessionStart` hook
 * (`scripts/session-start.mjs`): a "new session" is a fresh SessionStart over
 * the same workspace, which is exactly what a user does overnight. Its stdout
 * `additionalContext` is model-visible, so the resume plan + reconciliation
 * are testable as hook output.
 *
 * ## What is and isn't seeded
 *
 * Nothing under `state/` is pre-seeded — every workspace bootstraps via the
 * real SessionStart and earns its gates from compliant subagent returns
 * through the real registered hooks (the feature-lane journey recipe). The
 * hand-written artifacts are exactly the ones a human/steering flow writes by
 * design: `spec.md` (spec-writer holds an edit tool), the spec metadata
 * (emulating `lib/workflow/agents/spec-writer.mjs`'s writeMetadata, which no
 * hook drives), `scope-change.json` and `resume-pointer.json` (the captured
 * steering evidence the preconditions demand — writing them IS the protocol
 * under test), and the leaked `activeSubagents` counter (simulating the
 * hard-interrupt DN-6 reconciles).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_SESSION_ID as SESSION_ID,
  readState,
  readTraceEvents,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  subagentDispatch,
} from './session-harness.mjs';

/** A second host session over the same workspace (park/resume overnight). */
const SECOND_SESSION_ID = '2b7de777-9277-4306-b85f-3b498dab8337';

/** The one path this workspace makes editable (config: `repo-a/lib/**`). */
const EDIT_PATH = 'repo-a/lib/app.mjs';

/** Compliant agent contract bodies — the feature-lane journey recipe. */
const ROUTER_RETURN = { lane: 'feature', budgetClass: 'standard', confidence: 0.94 };

const DISCOVERY_RETURN = {
  claims: [{ fact: 'The request handler lives here.', path: EDIT_PATH, confidence: 'high' }],
  unverified: ['[UNVERIFIED] the downstream cache is invalidated on write'],
};

const GRILL_RETURN = {
  mode: 'grill',
  assumptions: ['The caller is authenticated.'],
  missingRequirements: [],
  edgeCases: ['An empty request body.'],
  cornerCases: [],
  securityRisks: ['Unbounded input size.'],
  uxRisks: [],
  blockingQuestions: [],
  recommendedDecisions: ['Reject bodies over the configured cap.'],
  unverifiedItems: ['[UNVERIFIED] the current body-size cap'],
};

const PLANNER_RETURN = {
  tasks: [
    {
      description: 'Add the size cap to the request handler.',
      tddApproach: 'Write a failing test for an over-cap body, then clamp it.',
      persona: 'backend',
      ac: ['AC1: a body over the cap is rejected with a 413.'],
      files: [EDIT_PATH],
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

const CRITIQUE_RETURN = {
  mode: 'critique',
  missingAcceptanceCriteria: [],
  missingTests: [],
  riskySequencing: [],
  unlistedFiles: [],
  backwardsCompatRisks: [],
  rollbackRisk: 'Low — the change is additive and behind a size check.',
  verdict: 'APPROVE_PLAN',
};

/** The two ordered AC labels the spec (and task.json) carry. */
const AC_LABELS = [
  'a body over the configured cap is rejected with a 413.',
  'the cap is configurable via settings.',
];

/**
 * The spec the human reviews: two ACs (so "AC1 done, AC2 remains" is
 * assertable after a revise-scope round trip) and a `## Files that will
 * change` section (parsed by continueApprovedFeature to seed workstreams).
 */
const SPEC_MD = [
  '# Spec: request body size cap',
  '',
  '## Acceptance criteria',
  '',
  `- [ ] AC1: ${AC_LABELS[0]}`,
  `- [ ] AC2: ${AC_LABELS[1]}`,
  '',
  '## Files that will change',
  '',
  `- \`${EDIT_PATH}\``,
  '',
].join('\n');

/**
 * A spec WITHOUT a files section and with no specFiles metadata: `approve
 * spec` then durably reaches `spec-approved` but continuation fails — the
 * realistic in-the-wild state that leaves a task parked-at-spec-approved
 * material for the resume-into-human-gate case.
 */
const SPEC_MD_NO_FILES = [
  '# Spec: request body size cap',
  '',
  '## Acceptance criteria',
  '',
  `- [ ] AC1: ${AC_LABELS[0]}`,
  '',
].join('\n');

/**
 * A plain (non-runSubagent) PostToolUse: stamps the spec digest and walks the
 * lane chain — how a spec written with an edit tool advances the gate.
 * @returns {Record<string, unknown>}
 */
function plainToolReturn() {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    tool_name: 'str_replace_editor',
    tool_input: { path: '.devmate/session/spec.md' },
    tool_response: 'ok',
    tool_use_id: 'toolu_spec_write__vscode-1',
  };
}

/**
 * Run the real `gatectl workflow set <event>` CLI exactly as the integrated
 * terminal would: a subprocess whose cwd is the workspace's own `.devmate/`.
 * @param {{ hostCwd: string }} ws
 * @param {string} event
 * @param {string[]} [extraArgs]  e.g. --actor/--evidence for human gates.
 * @returns {{ script: string, status: number, stdout: string, stderr: string }}
 */
function gatectl(ws, event, extraArgs = []) {
  return spawnHook('scripts/gatectl.mjs', ['workflow', 'set', event, ...extraArgs], {}, ws.hostCwd);
}

/**
 * Fire the real SessionStart hook — a "new session" over this workspace.
 * @param {{ hostCwd: string }} ws
 * @param {string} sessionId
 * @returns {{ script: string, status: number, stdout: string, stderr: string }[]}
 */
function sessionStart(ws, sessionId) {
  return replaySession(
    [{ hook_event_name: 'SessionStart', session_id: sessionId, source: 'new' }],
    ws.hostCwd,
  );
}

/** @param {{ root: string }} ws @param {string} name */
function stateArtifact(ws, name) {
  return join(ws.root, '.devmate', 'state', name);
}

/** @param {{ root: string }} ws @param {string} taskId */
function tracePath(ws, taskId) {
  return join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`);
}

/** Persist the captured scope-change note revise-scope requires (E10-05). */
/** @param {{ root: string }} ws @param {string} taskId */
function writeScopeChangeNote(ws, taskId) {
  writeFileSync(
    stateArtifact(ws, 'scope-change.json'),
    JSON.stringify({
      taskId,
      note: 'The cap must also apply to multipart bodies.',
      capturedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
}

/** Persist the resume pointer a park requires (E10-05). */
/** @param {{ root: string }} ws @param {string} taskId @param {string} gate */
function writeResumePointer(ws, taskId, gate) {
  writeFileSync(
    stateArtifact(ws, 'resume-pointer.json'),
    JSON.stringify({ taskId, gate, parkedAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  );
}

/**
 * Drive a freshly seeded workspace to the named feature-lane stage through
 * the real hooks (the journey recipe). Stages are cumulative prefixes.
 * @param {ReturnType<typeof seedMonorootWorkspace>} ws
 * @param {'lane-set'|'plan-done'|'spec-draft'|'impl-started'} stage
 * @param {{ spec?: string, specMetadata?: boolean }} [opts]
 *   spec:         markdown written to spec.md (default SPEC_MD).
 *   specMetadata: emulate spec-writer's writeMetadata (specFiles +
 *                 acceptanceCriteria persisted to task.json). Default true.
 */
function driveFeatureTo(ws, stage, opts = {}) {
  sessionStart(ws, SESSION_ID);

  replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_RETURN), ws.hostCwd);
  if (stage === 'lane-set') return;

  replaySession(
    [
      ...subagentDispatch('toolu_discovery_1', 'discovery', DISCOVERY_RETURN),
      ...subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_RETURN),
      ...subagentDispatch('toolu_planner_1', 'planner', PLANNER_RETURN),
      ...subagentDispatch('toolu_critique_1', 'rubber-duck', CRITIQUE_RETURN),
    ],
    ws.hostCwd,
  );
  if (stage === 'plan-done') return;

  // spec-writer wrote spec.md with its edit tool; the metadata it is
  // contracted to persist (specFiles + the ordered AC list — see
  // lib/workflow/agents/spec-writer.mjs writeMetadata) is emulated here
  // because no hook drives that agent module. A plain PostToolUse then stamps
  // the digest and walks plan-done → spec-draft.
  mkdirSync(join(ws.root, '.devmate', 'session'), { recursive: true });
  writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), opts.spec ?? SPEC_MD, 'utf8');
  if (opts.specMetadata !== false) {
    const state = readState(ws.root);
    writeFileSync(
      stateArtifact(ws, 'task.json'),
      JSON.stringify({ ...state, specFiles: [EDIT_PATH], acceptanceCriteria: AC_LABELS }),
      'utf8',
    );
  }
  replaySession([plainToolReturn()], ws.hostCwd);
  if (stage === 'spec-draft') return;

  // Human: "approve spec" → spec-approved, then continueApprovedFeature runs
  // start-impl → impl-started.
  replaySession(
    [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve spec' }],
    ws.hostCwd,
  );
}

/** Every gate_transition event currently in the task's trace. */
/** @param {{ root: string }} ws @param {string} taskId */
function gateTransitions(ws, taskId) {
  if (!existsSync(tracePath(ws, taskId))) return [];
  return readTraceEvents(tracePath(ws, taskId)).filter((e) => e.type === 'gate_transition');
}

// ---------------------------------------------------------------------------
// revise-scope + re-plan: the mid-implementation steering edges
// ---------------------------------------------------------------------------

describe('E2E steering — revise-scope and re-plan from impl-started', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'impl-started');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: reached impl-started');

    // AC1 lands via the real script: records impl-AC1 in the trace and
    // refreshes artifactHashes.specDigest for the checkbox-flipped spec.
    const acRun = spawnHook('scripts/complete-ac.mjs', ['--ac', '1', '--repo-root', ws.root], {}, ws.root);
    assert.equal(acRun.status, 0, `complete-ac.mjs failed:\n${acRun.stdout}${acRun.stderr}`);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses revise-scope without a captured scope-change note, naming the missing path', () => {
    const r = gatectl(ws, 'revise-scope');
    assert.notEqual(r.status, 0, `revise-scope succeeded with no scope-change note:\n${r.stdout}`);
    // The full workspace-anchored path, not just the filename: a doubled-path
    // regression (#76 class) would name the artifact at the WRONG root and
    // still contain the bare name.
    assert.ok(
      (r.stdout + r.stderr).includes(stateArtifact(ws, 'scope-change.json')),
      `the refusal does not name the missing artifact at this workspace's state dir:\n${r.stdout}${r.stderr}`,
    );
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'the gate moved on a refused transition');
  });

  it('revise-scope with a captured note returns to spec-draft on the SAME task, retaining AC1', () => {
    writeScopeChangeNote(ws, taskId);
    const r = gatectl(ws, 'revise-scope');
    assert.equal(r.status, 0, `revise-scope refused:\n${r.stdout}${r.stderr}`);

    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'spec-draft');
    assert.equal(state.taskId, taskId, 'revise-scope restarted the task instead of continuing it');

    // Completed work is preserved: the impl-AC1 completion is still traced.
    const ac1 = readTraceEvents(tracePath(ws, taskId)).find(
      (e) => e.type === 'step_complete' && e.stepId === 'impl-AC1',
    );
    assert.ok(ac1, 'the impl-AC1 completion vanished from the trace across revise-scope');
  });

  it('re-approval flows back to impl-started and the resume plan dispatches only AC2+', () => {
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve spec' }],
      ws.hostCwd,
    );
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 're-approval did not reopen implementation');
    assert.equal(readState(ws.root).taskId, taskId);

    // A fresh session over the same workspace computes the resume plan; it
    // must join the trace's AC1 completion with the persisted AC list and
    // point at AC2 — never re-dispatch the completed criterion (docs/resume.md).
    sessionStart(ws, SESSION_ID);
    const plan = JSON.parse(readFileSync(stateArtifact(ws, 'resume-plan.json'), 'utf8'));
    assert.equal(plan.taskId, taskId);
    assert.equal(plan.implProgress.done, 1);
    assert.equal(plan.implProgress.total, 2);
    assert.equal(plan.implProgress.nextId, 2, 'the resume plan re-dispatches a completed AC');
    assert.ok(
      plan.message.includes('1/2 ACs complete, next AC2'),
      `the resume message does not report per-AC progress: ${plan.message}`,
    );
  });

  it('refuses re-plan when the critique evidence is gone (precondition re-checked)', () => {
    const critiquePath = stateArtifact(ws, 'critique-result.json');
    const saved = readFileSync(critiquePath, 'utf8');
    rmSync(critiquePath);
    try {
      const r = gatectl(ws, 're-plan');
      assert.notEqual(r.status, 0, `re-plan succeeded without critique evidence:\n${r.stdout}`);
      assert.ok(
        (r.stdout + r.stderr).includes('critique'),
        `the refusal does not name the missing critique evidence:\n${r.stdout}${r.stderr}`,
      );
      assert.equal(readState(ws.root).workflowGate, 'impl-started', 'the gate moved on a refused transition');
    } finally {
      writeFileSync(critiquePath, saved, 'utf8');
    }
  });

  it('re-plan returns to plan-done on the same task once the critique evidence is back', () => {
    const r = gatectl(ws, 're-plan');
    assert.equal(r.status, 0, `re-plan refused:\n${r.stdout}${r.stderr}`);
    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'plan-done');
    assert.equal(state.taskId, taskId);
  });
});

// ---------------------------------------------------------------------------
// new-requirements + the "new unrelated task mid-flight" protocol
// ---------------------------------------------------------------------------

describe('E2E steering — new-requirements from spec-draft; a new task never silently resets', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'spec-draft');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'spec-draft', 'precondition: reached spec-draft');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('a clearly new task mid-flight does NOT silently reset the workflow', () => {
    const transitionsBefore = gateTransitions(ws, taskId).length;

    replaySession(
      [
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: SESSION_ID,
          prompt: 'start a new task: migrate the database to postgres',
        },
      ],
      ws.hostCwd,
    );

    // The current task stays until the park/abandon confirmation the gate
    // conversation protocol demands (docs/workflow.md): same task, same gate,
    // no new gate_transition — and the deterministic turn router DEFERS the
    // classification to the orchestrator rather than deciding to reset.
    const state = readState(ws.root);
    assert.equal(state.taskId, taskId, 'a new prompt replaced the in-flight task');
    assert.equal(state.workflowGate, 'spec-draft', 'a new prompt moved the in-flight gate');
    assert.equal(gateTransitions(ws, taskId).length, transitionsBefore, 'a new prompt traced a gate move');

    const intent = JSON.parse(readFileSync(stateArtifact(ws, 'turn-intent.json'), 'utf8'));
    assert.equal(intent.deferred, true, 'the deterministic stage decided a mid-flight reset on its own');
  });

  it('refuses new-requirements when the grill evidence is gone (precondition re-checked)', () => {
    const grillPath = stateArtifact(ws, 'grill-result.json');
    const saved = readFileSync(grillPath, 'utf8');
    rmSync(grillPath);
    try {
      const r = gatectl(ws, 'new-requirements');
      assert.notEqual(r.status, 0, `new-requirements succeeded without grill evidence:\n${r.stdout}`);
      assert.ok(
        (r.stdout + r.stderr).includes('grill'),
        `the refusal does not name the missing grill evidence:\n${r.stdout}${r.stderr}`,
      );
      assert.equal(readState(ws.root).workflowGate, 'spec-draft', 'the gate moved on a refused transition');
    } finally {
      writeFileSync(grillPath, saved, 'utf8');
    }
  });

  it('new-requirements steps back to grill-done on the same task', () => {
    const r = gatectl(ws, 'new-requirements');
    assert.equal(r.status, 0, `new-requirements refused:\n${r.stdout}${r.stderr}`);
    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'grill-done');
    assert.equal(state.taskId, taskId);
  });
});

// ---------------------------------------------------------------------------
// park / resume across sessions
// ---------------------------------------------------------------------------

describe('E2E lifecycle — park at lane-set, reconcile across a session boundary, resume', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'lane-set');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'lane-set', 'precondition: reached lane-set');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses to park without a persisted resume pointer, naming the missing path', () => {
    const r = gatectl(ws, 'park');
    assert.notEqual(r.status, 0, `park succeeded with no resume pointer:\n${r.stdout}`);
    // Full workspace-anchored path (see the revise-scope refusal note).
    assert.ok(
      (r.stdout + r.stderr).includes(stateArtifact(ws, 'resume-pointer.json')),
      `the refusal does not name the missing artifact at this workspace's state dir:\n${r.stdout}${r.stderr}`,
    );
    assert.equal(readState(ws.root).workflowGate, 'lane-set', 'the gate moved on a refused transition');
  });

  it('parks once the pointer exists, and a NEW session reconciles a leaked subagent counter', () => {
    writeResumePointer(ws, taskId, 'lane-set');
    const r = gatectl(ws, 'park');
    assert.equal(r.status, 0, `park refused:\n${r.stdout}${r.stderr}`);
    assert.equal(readState(ws.root).workflowGate, 'parked');

    // Simulate the DN-6 hard-interrupt residue: a session died mid-dispatch,
    // so SubagentStop never fired and the counter leaked.
    const parked = readState(ws.root);
    writeFileSync(stateArtifact(ws, 'task.json'), JSON.stringify({ ...parked, activeSubagents: 2 }), 'utf8');

    // Overnight: a NEW session over the same workspace.
    sessionStart(ws, SECOND_SESSION_ID);

    const state = readState(ws.root);
    assert.equal(state.taskId, taskId, 'a fresh session replaced a parked (non-terminal) task');
    assert.equal(state.workflowGate, 'parked', 'a fresh session moved a parked gate');
    assert.equal(state.activeSubagents, 0, 'the leaked activeSubagents counter was not reconciled');

    const reconciled = readTraceEvents(tracePath(ws, taskId)).find((e) => e.type === 'subagent_reconciled');
    assert.ok(reconciled, 'no subagent_reconciled trace event was written');
    assert.equal(reconciled.previous, 2, 'the reconcile event does not record the leaked value');
  });

  it('resume returns to the exact recorded gate on the same task', () => {
    const r = gatectl(ws, 'resume');
    assert.equal(r.status, 0, `resume refused:\n${r.stdout}${r.stderr}`);
    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'lane-set', 'resume did not return to the recorded gate');
    assert.equal(state.taskId, taskId);
  });

  it('abandon from parked is terminal', () => {
    writeResumePointer(ws, taskId, 'lane-set');
    assert.equal(gatectl(ws, 'park').status, 0, 'precondition: re-park for the abandon-from-parked case');

    const r = gatectl(ws, 'abandon');
    assert.equal(r.status, 0, `abandon refused from parked:\n${r.stdout}${r.stderr}`);
    assert.equal(readState(ws.root).workflowGate, 'abandoned');
  });
});

describe('E2E lifecycle — resume re-checks the recorded gate\'s own precondition', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'plan-done');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'plan-done', 'precondition: reached plan-done');

    writeResumePointer(ws, taskId, 'plan-done');
    assert.equal(gatectl(ws, 'park').status, 0, 'precondition: park at plan-done');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses resume when the recorded gate\'s evidence is gone', () => {
    const critiquePath = stateArtifact(ws, 'critique-result.json');
    const saved = readFileSync(critiquePath, 'utf8');
    rmSync(critiquePath);
    try {
      const r = gatectl(ws, 'resume');
      assert.notEqual(r.status, 0, `resume succeeded without the recorded gate's evidence:\n${r.stdout}`);
      assert.ok(
        (r.stdout + r.stderr).includes('critique'),
        `the refusal does not name the missing evidence:\n${r.stdout}${r.stderr}`,
      );
      assert.equal(readState(ws.root).workflowGate, 'parked', 'a refused resume moved the gate');
    } finally {
      writeFileSync(critiquePath, saved, 'utf8');
    }
  });

  it('resumes to plan-done once the evidence is back', () => {
    const r = gatectl(ws, 'resume');
    assert.equal(r.status, 0, `resume refused:\n${r.stdout}${r.stderr}`);
    assert.equal(readState(ws.root).workflowGate, 'plan-done');
    assert.equal(readState(ws.root).taskId, taskId);
  });
});

describe('E2E lifecycle — resume into a human-approval gate keeps the audit pair', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    // A spec with no files section: "approve spec" durably reaches
    // spec-approved but continuation fails — the realistic state a task
    // parks from at that gate.
    driveFeatureTo(ws, 'impl-started', { spec: SPEC_MD_NO_FILES, specMetadata: false });
    taskId = readState(ws.root).taskId;
    assert.equal(
      readState(ws.root).workflowGate,
      'spec-approved',
      'precondition: approval persisted but continuation failed, leaving spec-approved',
    );

    writeResumePointer(ws, taskId, 'spec-approved');
    assert.equal(gatectl(ws, 'park').status, 0, 'precondition: park at spec-approved');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses a resume into spec-approved without the actor/evidence audit pair', () => {
    const r = gatectl(ws, 'resume');
    assert.notEqual(r.status, 0, `resume entered a human gate with no audit pair:\n${r.stdout}`);
    assert.ok(
      (r.stdout + r.stderr).includes('--actor'),
      `the refusal does not name the required audit flags:\n${r.stdout}${r.stderr}`,
    );
    assert.equal(readState(ws.root).workflowGate, 'parked', 'a refused resume moved the gate');
  });

  it('resumes into spec-approved with the audit pair, and traces it', () => {
    const r = gatectl(ws, 'resume', ['--actor', 'human-terminal', '--evidence', 'resume the parked spec task']);
    assert.equal(r.status, 0, `audited resume refused:\n${r.stdout}${r.stderr}`);
    assert.equal(readState(ws.root).workflowGate, 'spec-approved');

    const audited = gateTransitions(ws, taskId).find(
      (e) => e.to === 'spec-approved' && e.from === 'parked',
    );
    assert.ok(audited, 'no gate_transition trace event for the audited resume');
    assert.equal(audited.actor, 'human-terminal');
    assert.equal(audited.evidence, 'resume the parked spec task');
  });
});

describe('E2E lifecycle — parking is refused where nothing is in flight', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = seedMonorootWorkspace();
    sessionStart(ws, SESSION_ID);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses to park at no-lane even with a pointer persisted', () => {
    writeResumePointer(ws, readState(ws.root).taskId, 'no-lane');
    const r = gatectl(ws, 'park');
    assert.notEqual(r.status, 0, `park succeeded at no-lane:\n${r.stdout}`);
    assert.ok(
      (r.stdout + r.stderr).includes('does not accept event "park"'),
      `the refusal does not explain the illegal edge:\n${r.stdout}${r.stderr}`,
    );
    assert.equal(readState(ws.root).workflowGate, 'no-lane');
  });
});

// ---------------------------------------------------------------------------
// abandon: deliberate terminal, and what comes after
// ---------------------------------------------------------------------------

describe('E2E lifecycle — abandon mid-implementation, then a new task bootstraps cleanly', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'impl-started');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: reached impl-started');

    // Park/resume round trip at impl-started first (the 4th parked gate).
    writeResumePointer(ws, taskId, 'impl-started');
    assert.equal(gatectl(ws, 'park').status, 0, 'precondition: park at impl-started');
    assert.equal(readState(ws.root).workflowGate, 'parked');
    assert.equal(gatectl(ws, 'resume').status, 0, 'precondition: resume back to impl-started');
    assert.equal(readState(ws.root).workflowGate, 'impl-started');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('abandon from in-flight reaches the terminal gate on the same task', () => {
    const r = gatectl(ws, 'abandon');
    assert.equal(r.status, 0, `abandon refused:\n${r.stdout}${r.stderr}`);
    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'abandoned');
    assert.equal(state.taskId, taskId);
  });

  it('abandoned is terminal: no event moves it, including park', () => {
    for (const event of ['set-lane', 'park', 'resume', 'abandon']) {
      const r = gatectl(ws, event);
      assert.notEqual(r.status, 0, `event "${event}" escaped the terminal abandoned gate:\n${r.stdout}`);
      assert.ok(
        (r.stdout + r.stderr).includes(`does not accept event "${event}"`),
        `the refusal for "${event}" does not explain the illegal edge:\n${r.stdout}${r.stderr}`,
      );
    }
    assert.equal(readState(ws.root).workflowGate, 'abandoned');
  });

  it('a resumed SAME session keeps the terminal task — the deterministic id must not be reused', () => {
    // deriveTaskId is deterministic per session: replacing here would mint the
    // abandoned task's own id, and the "fresh" task would then OWN the old
    // trace and artifacts instead of refusing them.
    sessionStart(ws, SESSION_ID);
    const state = readState(ws.root);
    assert.equal(state.taskId, taskId, 'a same-session resume replaced the terminal task');
    assert.equal(state.workflowGate, 'abandoned');
  });

  it('a NEW session bootstraps a fresh task over the terminal state, inheriting nothing', () => {
    sessionStart(ws, SECOND_SESSION_ID);

    const state = readState(ws.root);
    assert.notEqual(state.taskId, taskId, 'the new session inherited the abandoned taskId');
    assert.equal(state.workflowGate, 'no-lane', 'the new task did not start at the pre-router gate');

    // Pinned answer to the issue's open question: the abandoned task's
    // session artifacts are left in place but IGNORED — they carry the old
    // taskId, so every ownership-checking precondition refuses them.
    assert.ok(
      existsSync(join(ws.root, '.devmate', 'session', 'spec.md')),
      'the abandoned task\'s spec.md was swept — this suite pins "left in place but ignored"',
    );
  });

  it('the new task earns its own gates: stale evidence from the abandoned task does not advance it', () => {
    // A fresh router return moves the NEW task to lane-set; the abandoned
    // task's discovery/grill/critique artifacts are still on disk, but the
    // chain must stop at lane-set because that stale evidence belongs to the
    // old taskId (ownership precondition), not because it is missing.
    assert.ok(existsSync(stateArtifact(ws, 'discovery-merged.json')), 'precondition: stale evidence exists');

    replaySession(subagentDispatch('toolu_router_2', 'router', ROUTER_RETURN), ws.hostCwd);

    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'lane-set', 'the new task did not stop at the stale-evidence boundary');
    assert.notEqual(state.taskId, taskId);
  });
});
