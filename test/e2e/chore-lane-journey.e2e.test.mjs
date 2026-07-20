// @ts-check
/**
 * END-TO-END: the CHORE lane, walked from `no-lane` all the way to `done`
 * through the real registered hooks — real subprocesses, real payloads, real
 * cwd. The chore lane is the mechanical one, and this suite pins the three ways
 * it is deliberately UNLIKE the feature and bug lanes:
 *
 *   1. **No human gate.** The evidence chain runs
 *      `lane-set --present-plan--> plan-approved --start-impl--> impl-started`
 *      and reaches implementation MECHANICALLY — no "approve plan", no
 *      UserPromptSubmit at all. The lane passes THROUGH `plan-approved` (so
 *      gate-guard still denies source edits until impl-started) but never waits
 *      there for a human. This suite submits no approval phrase and asserts the
 *      gate reached impl-started anyway, with every advance stamped
 *      `hook-evidence` (never `hook-exact-phrase`).
 *
 *   2. **scope.md is still the floor.** A mechanical lane is not an unbounded
 *      one. The chore lane's edit boundary is `scope.md`, and until it exists a
 *      @fullstack dispatch is denied at DISPATCH time — even though the gate is
 *      already open. The negative twin asserts the deny names `scope.md`; the
 *      positive twin asserts the same guard ALLOWS once the scope contract
 *      exists (a guard that never allows is as useless as one that never denies).
 *
 *   3. **The chore lane never becomes a PR lane.** Its tail is
 *      `verification-passed --complete--> done` — it SKIPS `pr-ready` entirely
 *      (feature and bug both stop there for a human). This suite asserts the
 *      journey terminates at `done` and that `pr-ready` never appears in it.
 *
 * A final suite pins the CURRENT chore escalation behaviour (docs/chore-escalation.md):
 * a reset command is refused while a chore is `plan-approved`, and an explicit
 * escalation converts the lane to feature WITHOUT discarding the task.
 *
 * ## What is and isn't seeded
 *
 * Nothing under `state/` is seeded. The session bootstraps its own task.json and
 * the router-result.json is projected from the @router return by the real hook.
 * `scope.md` stands in for the chore lane's own scope producer (writeChoreScope,
 * an executor step with no hook). The tail transitions are driven with
 * `transitionGate`: `pass-verification` is fired by the gate-advance hook in a
 * real session (#132 put it in LANE_CHAINS) but driven directly here for
 * determinism, and `complete` still has no hook caller — those turns are called
 * out inline.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import {
  escalateChoreToFeature,
  guardChoreReset,
  RESET_COMMANDS,
} from '../../lib/workflow/lanes/chore.mjs';
import {
  DEFAULT_SESSION_ID as SESSION_ID,
  readState,
  readTraceEvents,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  subagentDispatch,
  walk,
} from './session-harness.mjs';

/** The path the chore scope contract bounds edits to. */
const EDIT_PATH = 'repo-a/lib/app.mjs';

/** A terse, compliant chore router return (confidence clears the 0.75 floor). */
const ROUTER_BODY = {
  lane: 'chore',
  budgetClass: 'tiny',
  confidence: 0.91,
};

/** The full gate path the chore lane must traverse, in order, no gaps, no pr-ready. */
const EXPECTED_PATH = [
  'no-lane',
  'lane-set',
  'plan-approved',
  'impl-started',
  'verification-passed',
  'done',
];

/**
 * Write the chore lane's scope contract where readScopeForTask reads it:
 * `.devmate/session/<taskId>/scope.md`. Stands in for writeChoreScope (the
 * executor step that authors it in a real session), because this suite is about
 * the DISPATCH gate consuming the contract, not about who wrote it.
 * @param {string} root
 * @param {string} taskId
 */
function writeChoreScopeContract(root, taskId) {
  const sessionDir = join(root, '.devmate', 'session', taskId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'scope.md'),
    ['---', 'lane: chore', '---', '# Scope', '', '## Allowed paths', `- ${EDIT_PATH}`, '', '## Allowed globs', ''].join('\n'),
    'utf8',
  );
}

describe('E2E — chore lane: the full journey from no-lane to done (mechanical, no human gate)', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  /** @type {Record<string, { gate: string, lane: string, files: string[] }>} */
  const turns = {};

  /**
   * The two tail edges this test fires directly with transitionGate, captured so
   * the contiguity assertion can prove the FULL journey has no gaps, not merely
   * the hook-recorded slice of it. `pass-verification` is hook-driven in a real
   * session (#132) but fired directly here for determinism; `complete` has no
   * hook caller (verification-passed is the chore lane's terminal).
   * @type {{ from: string, to: string }[]}
   */
  const executorEdges = [];

  /** @type {{ script: string, status: number, stdout: string, stderr: string }} */
  let dispatchDenied;
  /** @type {{ script: string, status: number, stdout: string, stderr: string }} */
  let dispatchAllowed;

  /** @param {string} name */
  const snapshot = (name) => {
    const state = readState(ws.root);
    turns[name] = {
      gate: state.workflowGate,
      lane: state.lane,
      files: walk(join(ws.root, '.devmate', 'state')),
    };
  };

  /** @param {string} name */
  const stateArtifact = (name) => join(ws.root, '.devmate', 'state', name);

  /**
   * @param {string} agentId
   * @returns {{ script: string, status: number, stdout: string, stderr: string }}
   */
  const tryDispatch = (agentId) =>
    spawnHook(
      'hooks/subagent-budget-guard.mjs',
      ['start'],
      {
        hook_event_name: 'SubagentStart',
        session_id: SESSION_ID,
        agent_id: agentId,
        agent_type: 'fullstack',
        cwd: ws.hostCwd,
      },
      ws.hostCwd,
    );

  before(async () => {
    ws = seedMonorootWorkspace({ persona: 'editor' });
    const stateDir = join(ws.root, '.devmate', 'state');

    // 0. Bootstrap. Nothing under state/ is seeded.
    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    taskId = readState(ws.root).taskId;
    snapshot('bootstrap');

    // 1. @router → the ONLY dispatch before implementation. Its return classifies
    // the chore lane, and the evidence chain then walks all the way to
    // impl-started with NO human turn — set-lane, present-plan, start-impl.
    replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_BODY), ws.hostCwd);
    snapshot('router');

    // 2. The dispatch gate must DENY @fullstack now: the gate is open but the
    // chore lane's scope contract does not exist yet.
    dispatchDenied = tryDispatch('toolu_impl_deny');

    // 3. The chore scope producer writes scope.md; the same guard must now ALLOW.
    writeChoreScopeContract(ws.root, taskId);
    dispatchAllowed = tryDispatch('toolu_impl_allow');

    // 4. Fresh, passing verify evidence → pass-verification → verification-passed.
    // Executor-driven (no hook caller). The chore lane has no spec, so the expected
    // specDigest is the empty digest task.json carries.
    const beforeVerify = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    writeFileSync(
      stateArtifact('verify-result.json'),
      JSON.stringify({
        passed: true,
        completedAt: new Date().toISOString(),
        specDigest: beforeVerify.artifactHashes?.specDigest ?? '',
      }),
      'utf8',
    );
    const toVerified = await transitionGate(beforeVerify, 'pass-verification', { stateDir });
    assert.ok(toVerified.ok, `pass-verification refused: ${toVerified.ok ? '' : toVerified.error}`);
    writeFileSync(stateArtifact('task.json'), JSON.stringify(toVerified.state), 'utf8');
    executorEdges.push({ from: /** @type {string} */ (toVerified.from), to: /** @type {string} */ (toVerified.to) });
    snapshot('verify');

    // 5. complete → done. On the chore lane this edge leaves verification-passed
    // DIRECTLY (no mark-pr-ready), skipping pr-ready. Executor-driven.
    const atVerified = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    const toDone = await transitionGate(atVerified, 'complete', { stateDir });
    assert.ok(toDone.ok, `complete refused: ${toDone.ok ? '' : toDone.error}`);
    writeFileSync(stateArtifact('task.json'), JSON.stringify(toDone.state), 'utf8');
    executorEdges.push({ from: /** @type {string} */ (toDone.from), to: /** @type {string} */ (toDone.to) });
    snapshot('done');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('turn 0 — bootstraps at no-lane with no gate evidence on disk', () => {
    assert.equal(turns['bootstrap'].gate, 'no-lane');
    assert.ok(
      !turns['bootstrap'].files.includes('router-result.json'),
      'a gate artifact existed before any agent ran — the workspace was pre-seeded and this suite proves nothing',
    );
  });

  it('reaches impl-started MECHANICALLY on the router return — no human phrase submitted', () => {
    // The whole distinction of the chore lane: from a single @router dispatch the
    // evidence chain runs no-lane -> lane-set -> plan-approved -> impl-started with
    // no UserPromptSubmit anywhere in the stream. Passing THROUGH plan-approved is
    // by design (gate-guard denies source edits until impl-started); waiting there
    // is not.
    assert.equal(turns['router'].lane, 'chore');
    assert.equal(turns['router'].gate, 'impl-started');
    assert.ok(turns['router'].files.includes('router-result.json'), 'router-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('router-result.json'), 'utf8'));
    assert.equal(artifact.lane, 'chore');
  });

  it('every advance to impl-started was hook-evidence — nothing was human-approved', () => {
    // The mechanical claim, made structural: no gate_transition on this journey
    // may carry the hook-exact-phrase actor, because no human phrase was ever
    // submitted. All three moves are evidence-driven.
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const phraseDriven = trace.filter((e) => e.type === 'gate_transition' && e.actor === 'hook-exact-phrase');
    assert.equal(
      phraseDriven.length,
      0,
      `a chore advance was attributed to a human phrase: ${JSON.stringify(phraseDriven)}`,
    );
  });

  it('dispatch gate — @fullstack is DENIED before scope.md exists, and the deny names scope.md', () => {
    assert.notEqual(
      dispatchDenied.status,
      0,
      `@fullstack was allowed with no scope contract:\n${dispatchDenied.stdout}${dispatchDenied.stderr}`,
    );
    assert.match(
      dispatchDenied.stdout + dispatchDenied.stderr,
      /scope\.md/i,
      'the deny message does not name scope.md — the model is not told what to produce',
    );
  });

  it('dispatch gate — @fullstack is ALLOWED once the chore scope contract exists', () => {
    assert.equal(
      dispatchAllowed.status,
      0,
      `@fullstack dispatch was denied even with scope.md present:\n${dispatchAllowed.stdout}${dispatchAllowed.stderr}`,
    );
  });

  it('gate verification-passed — reached on fresh, passing evidence', () => {
    // pass-verification is hook-driven in a real session (#132) but fired directly
    // here for determinism.
    assert.equal(turns['verify'].gate, 'verification-passed');
    const verify = JSON.parse(readFileSync(stateArtifact('verify-result.json'), 'utf8'));
    assert.equal(verify.passed, true);
  });

  it('gate done (executor-driven, not hook-fired) — the journey terminates at the terminal gate', () => {
    assert.equal(turns['done'].gate, 'done');
  });

  it('never visits pr-ready — the chore lane is not a PR lane', () => {
    // verification-passed --complete--> done skips pr-ready on the chore lane
    // (feature + bug both stop at pr-ready for a human). pr-ready must appear in
    // NO snapshot and in NO recorded/executor transition.
    const visited = new Set(Object.values(turns).map((t) => t.gate));
    assert.ok(!visited.has('pr-ready'), 'the chore lane visited pr-ready');
    assert.ok(
      !executorEdges.some((e) => e.from === 'pr-ready' || e.to === 'pr-ready'),
      'a chore transition touched pr-ready',
    );
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    assert.ok(
      !trace.some((e) => e.type === 'gate_transition' && (e.from === 'pr-ready' || e.to === 'pr-ready')),
      'a chore gate_transition touched pr-ready',
    );
  });

  it('the trace records the hook-driven gate_transitions in chain order, no duplicates', () => {
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const recorded = trace
      .filter((e) => e.type === 'gate_transition')
      .map((e) => ({ from: e.from, to: e.to, actor: e.actor, evidence: e.evidence }));

    assert.deepEqual(recorded, [
      { from: 'no-lane', to: 'lane-set', actor: 'hook-evidence', evidence: 'set-lane' },
      { from: 'lane-set', to: 'plan-approved', actor: 'hook-evidence', evidence: 'present-plan' },
      { from: 'plan-approved', to: 'impl-started', actor: 'hook-evidence', evidence: 'start-impl' },
    ]);
  });

  it('the full journey (hook + executor edges) is one contiguous chain, no gaps, no branches', () => {
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const hookEdges = trace
      .filter((e) => e.type === 'gate_transition')
      .map((e) => ({ from: /** @type {string} */ (e.from), to: /** @type {string} */ (e.to) }));

    /** @type {Map<string, string>} */
    const byFrom = new Map();
    for (const edge of [...hookEdges, ...executorEdges]) {
      assert.ok(!byFrom.has(edge.from), `two transitions leave gate "${edge.from}" — the chain branches`);
      byFrom.set(edge.from, edge.to);
    }

    const path = ['no-lane'];
    let cursor = 'no-lane';
    while (byFrom.has(cursor)) {
      cursor = /** @type {string} */ (byFrom.get(cursor));
      path.push(cursor);
    }
    assert.deepEqual(path, EXPECTED_PATH);
  });
});

describe('E2E — chore lane negative twin: mechanical does not mean unbounded', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = seedMonorootWorkspace({ persona: 'editor' });
    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_BODY), ws.hostCwd);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('holds impl-started open yet still denies the fix while scope.md is absent', () => {
    // The gate reached impl-started mechanically, but with no scope contract on
    // disk the dispatch guard must still refuse — the mechanical lane bounds its
    // edits exactly like the others.
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: the gate reached impl-started');
    assert.ok(
      !existsSync(join(ws.root, '.devmate', 'session', readState(ws.root).taskId, 'scope.md')),
      'scope.md exists — the negative twin cannot prove the boundary holds',
    );

    const r = spawnHook(
      'hooks/subagent-budget-guard.mjs',
      ['start'],
      {
        hook_event_name: 'SubagentStart',
        session_id: SESSION_ID,
        agent_id: 'toolu_impl_1',
        agent_type: 'fullstack',
        cwd: ws.hostCwd,
      },
      ws.hostCwd,
    );

    assert.notEqual(r.status, 0, `@fullstack was allowed with no scope contract:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /scope\.md/i, 'the deny message does not name scope.md');
  });
});

describe('chore escalation (direct-function, not hook-driven): current behaviour is pinned (docs/chore-escalation.md)', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let statePath;
  /** @type {string} */
  let transitionsPath;

  before(() => {
    ws = seedMonorootWorkspace({ persona: 'editor' });
    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    // Drive a real bootstrapped task onto the chore lane at plan-approved — the
    // gate the escalation + reset-guard behaviour is defined against.
    statePath = join(ws.root, '.devmate', 'state', 'task.json');
    transitionsPath = join(ws.root, '.devmate', 'state', 'transitions.jsonl');
    const state = readState(ws.root);
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, lane: 'chore', workflowGate: 'plan-approved' }),
      'utf8',
    );
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('refuses every reset command while a chore plan is approved', () => {
    // A reset at plan-approved would silently discard the approved plan. The guard
    // blocks it and points at the non-reset continuation instead. Pinned against
    // the full RESET_COMMANDS list so a newly-added reset command cannot slip past.
    const state = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    for (const command of RESET_COMMANDS) {
      const reason = guardChoreReset(state, command);
      assert.ok(reason, `reset command ${command} was allowed at chore/plan-approved`);
      assert.ok(
        String(reason).includes(command),
        `the refusal for ${command} did not name the command: ${String(reason)}`,
      );
    }
  });

  it('allows a non-reset command at the same gate', () => {
    // The guard must not block everything — only the reset commands.
    assert.equal(
      guardChoreReset(
        /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root)),
        '/devmate-chore-continue',
      ),
      null,
    );
  });

  it('escalates to the feature lane WITHOUT discarding the task', async () => {
    // Escalation re-enters the feature lane at plan-approved (a wider plan must be
    // approved), preserving the taskId — never a restart.
    const before = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    const next = await escalateChoreToFeature(before, {
      reason: 'scope exceeded chore bounds',
      statePath,
      transitionsPath,
    });

    assert.equal(next.lane, 'feature');
    assert.equal(next.workflowGate, 'plan-approved');
    assert.equal(next.taskId, before.taskId, 'the task id was not preserved across escalation');

    const persisted = readState(ws.root);
    assert.equal(persisted.lane, 'feature');
    assert.equal(persisted.taskId, before.taskId);

    // The lane_transition landed in the temp workspace, NOT the repo tree — proof
    // the DEFAULT_TRANSITIONS_PATH (repo-root) fallback was overridden.
    assert.ok(existsSync(transitionsPath), 'the escalation transition was not written to the temp transitions path');
  });
});
