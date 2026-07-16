// @ts-check
/**
 * END-TO-END: the human approval that opens implementation on the bug and chore
 * lanes.
 *
 * ## What was broken
 *
 * The bug and chore lanes have no spec gate, so their only move out of
 * `plan-approved` is `start-impl`. Both lane procedures instructed
 * `gatectl workflow set start-impl` — a command the orchestrator has never had a
 * tool to run, because it declares no `execute`. So the gate never moved,
 * `@fullstack` could never be dispatched (the PreToolUse gate-guard and the
 * SubagentStart budget guard both deny an implementation dispatch at
 * `plan-approved`), and **both lanes were dead ends**. Nothing in the test suite
 * noticed, because nothing ever ran a lane end to end.
 *
 * `approve plan` on UserPromptSubmit now advances it — in the hook, where the
 * host runs it, so the orchestrator still cannot advance its own gate.
 *
 * ## What must NOT happen
 *
 * The two negative suites below matter more than the positive ones:
 *
 *   1. **`approve plan` must be refused on the FEATURE lane.** There,
 *      `plan-approved -> impl-started` is precisely the spec-gate bypass HITL-2
 *      exists to block (observed in the wild, #58/#59). Note this is not
 *      hypothetical: `advanceGate` checks a flattened, LANE-AGNOSTIC table in
 *      which that edge IS legal — because bug/chore allow it. Using it here would
 *      have shipped the bypass. The handler uses `transitionGate`, which consults
 *      the lane-OWNED table, so the refusal comes from the transition table
 *      itself.
 *
 *   2. **Diagnose-before-fix must survive.** Advancing the bug lane's gate must
 *      not become a way around `@diagnose`: an implementation dispatch still
 *      requires a valid `diagnosis.json` and a `scope.md`, enforced at dispatch
 *      time by the SubagentStart guard.
 *
 * Every suite replays real hook events through real hook subprocesses in the real
 * monoroot layout, seeding nothing under `state/`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readJsonlSync } from '../../lib/json-io.mjs';
import {
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
} from './session-harness.mjs';

/**
 * Read a JSONL trace file into objects, via the canonical reader.
 * @param {string} filePath
 * @returns {Record<string, any>[]}
 */
function readTraceEvents(filePath) {
  return /** @type {Record<string, any>[]} */ (readJsonlSync(filePath));
}

const SESSION_ID = 'fd634936-8166-4295-a74f-2a397c9c5226';

/**
 * The minimum real event stream: SessionStart (which bootstraps task.json), then
 * the human's approval prompt.
 * @param {string} prompt
 * @returns {Record<string, unknown>[]}
 */
function sessionEvents(prompt) {
  return [
    {
      hook_event_name: 'SessionStart',
      session_id: SESSION_ID,
      source: 'new',
    },
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_ID,
      prompt,
    },
  ];
}

/**
 * Drive a bootstrapped task to the gate/lane a lane procedure would have reached
 * by the time the human is asked to approve the plan.
 *
 * Only the lane and the gate are set — deliberately NOT the artifacts. Seeding a
 * diagnosis here would hide whether diagnose-before-fix still holds.
 *
 * `currentStep` is set NON-ZERO on purpose. The bootstrap writes 0, so a test
 * that asserted "currentStep is 0 after the advance" against a 0 starting value
 * would pass without the advance ever resetting anything — proving nothing. This
 * makes the reset observable.
 *
 * @param {string} root
 * @param {'feature'|'bug'|'chore'} lane
 */
function setLaneAtPlanApproved(root, lane) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  const state = readState(root);
  writeFileSync(
    statePath,
    JSON.stringify({ ...state, lane, workflowGate: 'plan-approved', currentStep: 7 }),
    'utf8',
  );

  // #92: `impl-started` now requires the lane's scope contract, so a task can no
  // longer enter implementation with no edit boundary. In a real session the
  // gate-advance hook writes this from @planner's (or @diagnose's) typed return;
  // here we stand in for that return, because this test is about the APPROVAL
  // opening the gate, not about where the contract came from.
  const sessionDir = join(root, '.devmate', 'session', state.taskId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'scope.md'),
    ['---', `lane: ${lane}`, '---', '# Scope', '', '## Allowed paths', '- src/app.mjs', '', '## Allowed globs', ''].join('\n'),
    'utf8',
  );
}

/**
 * Replay SessionStart (bootstrapping state), put the task at plan-approved on a
 * lane, then submit the human prompt.
 * @param {'feature'|'bug'|'chore'} lane
 * @param {string} prompt
 */
function runLane(lane, prompt) {
  const ws = seedMonorootWorkspace();
  const [start, approve] = sessionEvents(prompt);

  replaySession([start], ws.hostCwd);
  setLaneAtPlanApproved(ws.root, lane);
  const ran = replaySession([approve], ws.hostCwd);

  return { ...ws, ran, output: ran.map((r) => r.stdout + r.stderr).join('\n') };
}

for (const lane of /** @type {const} */ (['bug', 'chore'])) {
  describe(`E2E — ${lane} lane: "approve plan" opens implementation`, () => {
    /** @type {ReturnType<typeof runLane>} */
    let run;

    before(() => {
      run = runLane(lane, 'approve plan');
    });

    after(() => {
      if (run?.root) rmSync(run.root, { recursive: true, force: true });
    });

    it('advances plan-approved -> impl-started', () => {
      // Before this, nothing could: the orchestrator was told to run
      // `gatectl workflow set start-impl` and has no terminal, so the lane simply
      // stopped here forever.
      const state = readState(run.root);
      assert.equal(state.workflowGate, 'impl-started');
    });

    it('resets currentStep, so a resumed session does not believe it is mid-step', () => {
      // `transitionGate` derives the next state with `currentStep: 0`. Persisting
      // only the gate name would carry the OLD step index into `impl-started` —
      // and the state anchor and the resume plan both read it, so a resumed
      // session would think it was already partway through a step it never began.
      const state = readState(run.root);
      assert.equal(state.currentStep, 0);
    });

    it('records the transition with the human message as evidence', () => {
      // A gate that moves without an auditable reason is exactly what the human
      // gate exists to prevent.
      const state = readState(run.root);
      const trace = join(run.root, '.devmate', 'state', 'trace', `${state.taskId}.jsonl`);
      const events = readTraceEvents(trace);
      const advance = events.find((e) => e.type === 'gate_transition' && e.to === 'impl-started');
      assert.ok(advance, `no gate_transition to impl-started in the trace: ${JSON.stringify(events)}`);
      assert.equal(advance.actor, 'hook-exact-phrase');
      assert.equal(advance.evidence, 'approve plan');
    });
  });
}

describe('E2E — feature lane: "approve plan" must NOT bypass the spec gate', () => {
  /** @type {ReturnType<typeof runLane>} */
  let run;

  before(() => {
    run = runLane('feature', 'approve plan');
  });

  after(() => {
    if (run?.root) rmSync(run.root, { recursive: true, force: true });
  });

  it('leaves the gate at plan-approved', () => {
    // HITL-2: on the feature lane the ONLY legal move out of plan-approved is
    // `draft-spec`. `start-impl` from here is the spec-gate bypass seen in the
    // wild (#58/#59). It must be refused even though the flattened,
    // lane-agnostic table `advanceGate` consults says the edge is legal.
    const state = readState(run.root);
    assert.equal(state.workflowGate, 'plan-approved');
    assert.notEqual(state.workflowGate, 'impl-started');
  });

  it('tells the human why, instead of ignoring the approval silently', () => {
    // A silently swallowed approval is how a human comes to believe a gate moved
    // when it did not — and then trusts work that was never gated.
    assert.match(run.output, /did not advance the gate/i);
    assert.match(run.output, /Illegal transition/i);
  });
});

describe('E2E — bug lane: advancing the gate does not defeat diagnose-before-fix', () => {
  /** @type {ReturnType<typeof runLane>} */
  let run;

  before(() => {
    run = runLane('bug', 'approve plan');
  });

  after(() => {
    if (run?.root) rmSync(run.root, { recursive: true, force: true });
  });

  it('still denies an @fullstack dispatch with no diagnosis and no scope', () => {
    // The gate is open, but the bug lane's real safety property is that a fix is
    // never written before the bug is reproduced. That is enforced at DISPATCH
    // time by the SubagentStart guard, which requires a valid diagnosis.json and
    // a scope.md. Opening the gate must not become a way around it.
    const state = readState(run.root);
    assert.equal(state.workflowGate, 'impl-started', 'precondition: the gate is open');

    const r = spawnHook(
      'hooks/subagent-budget-guard.mjs',
      ['start'],
      {
        hook_event_name: 'SubagentStart',
        session_id: SESSION_ID,
        agent_id: 'toolu_impl_1',
        agent_type: 'fullstack',
        cwd: run.hostCwd,
      },
      run.hostCwd,
    );

    assert.notEqual(r.status, 0, `the implementation dispatch was ALLOWED with no diagnosis:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /diagnos|scope/i);
  });

  it('allows the dispatch once the diagnosis and scope exist', () => {
    // The deny above must be about the missing artifacts, not about the guard
    // refusing everything — a guard that never allows is as useless as one that
    // never denies.
    const stateDir = join(run.root, '.devmate', 'state');
    const state = readState(run.root);

    // A DiagnosisResult that actually satisfies validateDiagnosisResult — a
    // hand-waved one would make this test pass for the wrong reason, since an
    // invalid diagnosis is treated exactly like a missing one (fail-closed).
    writeFileSync(
      join(stateDir, 'diagnosis.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: state.taskId,
        bugScope: 'backend',
        suspectedLayer: 'repo-a/lib/cursor.mjs',
        reproCommand: 'npm test -- cursor',
        fixerRecommendation: 'clamp the batch cursor at the final page boundary',
        // #92: the bug lane's edit boundary now travels in the DiagnosisResult —
        // @diagnose has no edit tool, so the hook authors scope.md from these
        // fields. A diagnosis without them is invalid, and an invalid diagnosis
        // is treated exactly like a missing one (fail-closed).
        allowedPaths: ['repo-a/lib/cursor.mjs'],
        allowedGlobs: [],
      }),
      'utf8',
    );

    // scope.md lives at .devmate/session/<taskId>/scope.md — the path
    // readScopeForTask actually reads.
    const sessionDir = join(run.root, '.devmate', 'session', state.taskId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'scope.md'),
      '# Scope\n\n## Editable\n- repo-a/lib/**\n',
      'utf8',
    );

    const r = spawnHook(
      'hooks/subagent-budget-guard.mjs',
      ['start'],
      {
        hook_event_name: 'SubagentStart',
        session_id: SESSION_ID,
        agent_id: 'toolu_impl_2',
        agent_type: 'fullstack',
        cwd: run.hostCwd,
      },
      run.hostCwd,
    );

    // If this still denies, the message says which artifact it could not find —
    // which is the honest failure, not a silent one.
    assert.equal(
      r.status,
      0,
      `dispatch denied even with a diagnosis + scope:\n${r.stdout}${r.stderr}`,
    );
  });
});

describe('E2E — "approve plan" is inert when there is nothing to approve', () => {
  /** @type {ReturnType<typeof runLane>} */
  let run;

  after(() => {
    if (run?.root) rmSync(run.root, { recursive: true, force: true });
  });

  it('does not advance a freshly bootstrapped task sitting at no-lane', () => {
    // The bootstrap deliberately starts at the pre-router gate. A phrase that
    // could jump a brand-new task straight into implementation would undo that.
    const ws = seedMonorootWorkspace();
    run = /** @type {ReturnType<typeof runLane>} */ ({ ...ws, ran: [], output: '' });

    const [start, approve] = sessionEvents('approve plan');
    replaySession([start], ws.hostCwd);
    replaySession([approve], ws.hostCwd);

    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'no-lane');
  });
});

