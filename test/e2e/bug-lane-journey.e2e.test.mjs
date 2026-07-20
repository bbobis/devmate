// @ts-check
/**
 * END-TO-END: the BUG lane, walked from `no-lane` all the way to `done` through
 * the real registered hooks — real subprocesses, real payloads, real cwd —
 * asserting at every gate that the gate advanced, that the evidence artifact
 * that justifies the move landed on disk, and that the human approval halts and
 * resumes exactly where the lane procedure says it must.
 *
 * ## Why a whole-lane suite, and why the bug lane specifically
 *
 * `test/e2e/feature-lane-journey.e2e.test.mjs` walks the feature lane end to
 * end; `test/e2e/bug-lane-evidence.e2e.test.mjs` proves the bug lane can REACH
 * `plan-approved` on its agents' evidence. Neither carries the bug lane past the
 * human gate into implementation, verification, and `done`. This suite does, and
 * it pins the three properties that make the bug lane *distinct*:
 *
 *   1. **Diagnose-before-fix is structural, not procedural.** The bug lane has no
 *      discovery-done gate — it diagnoses instead — and @diagnose's typed return
 *      is what authors `diagnosis.json` + `scope.md`. Until BOTH exist, a
 *      @fullstack dispatch is denied at DISPATCH time by the SubagentStart guard,
 *      even with the gate already open. The negative twin withholds the diagnose
 *      return and asserts the dispatch stays denied with a reason that names the
 *      missing artifact.
 *
 *   2. **The plan-approved halt is real.** The evidence chain runs
 *      `lane-set --finish-grill--> grill-done --present-plan--> plan-approved`
 *      and then STOPS. It must not auto-advance into `impl-started`; only a human
 *      typing "approve plan" moves it, in the hook, where the host runs it.
 *
 *   3. **The bug lane is NOT the feature lane.** It never visits discovery-done,
 *      spec-draft, or spec-approved, and its `plan-approved -> impl-started` move
 *      is the lane-owned `start-impl` edge — precisely the edge HITL-2 forbids on
 *      the feature lane. This suite asserts the bug lane's own chain, not the
 *      feature lane's, so a copy-paste that quietly asserted feature
 *      preconditions here would fail.
 *
 * ## What is and isn't seeded
 *
 * Nothing under `state/` is seeded. The session bootstraps its own task.json and
 * every gate artifact is projected from a subagent return by the real hook. Two
 * transitions — `pass-verification` and `complete` — have no hook-reachable
 * caller (a lane executor fires them), so the test drives `transitionGate`
 * directly and persists, exactly as the executor would; those turns are called
 * out inline.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import { validateDiagnosisResult, validateGrillResult } from '../../lib/workflow/contracts.mjs';
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

/** The one path @diagnose bounds the fix to; it becomes the scope contract. */
const FIX_PATH = 'repo-a/lib/cursor.mjs';

/** A terse, compliant bug router return (confidence clears the 0.75 floor). */
const ROUTER_BODY = {
  lane: 'bug',
  budgetClass: 'standard',
  confidence: 0.94,
};

/**
 * A flat diagnose return, as `agents/diagnose.agent.md` documents it. The hook
 * projects `diagnosis.json` from it AND authors `scope.md` from allowedPaths —
 * @diagnose holds no edit tool, so the edit boundary travels in the return.
 */
const DIAGNOSE_BODY = {
  bugScope: 'backend',
  suspectedLayer: FIX_PATH,
  reproCommand: 'npm test -- cursor',
  fixerRecommendation: 'clamp the batch cursor at the final page boundary',
  allowedPaths: [FIX_PATH],
  allowedGlobs: [],
};

/** A grill return: mode grill, the eight finding arrays, one [UNVERIFIED] item. */
const GRILL_BODY = {
  mode: 'grill',
  assumptions: ['The cursor never points past the final page.'],
  missingRequirements: [],
  edgeCases: ['A final page with exactly one item.'],
  cornerCases: [],
  securityRisks: [],
  uxRisks: [],
  blockingQuestions: [],
  recommendedDecisions: ['Clamp the cursor at the last page boundary.'],
  unverifiedItems: ['[UNVERIFIED] the page-size configured in prod'],
};

/** The full gate path the bug lane must traverse, in order, no gaps. */
const EXPECTED_PATH = [
  'no-lane',
  'lane-set',
  'grill-done',
  'plan-approved',
  'impl-started',
  'verification-passed',
  'pr-ready',
  'done',
];

describe('E2E — bug lane: the full journey from no-lane to done', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  /**
   * State + artifacts as they stood at the END of each turn. Snapshotted per
   * turn rather than read once at the end, because "the gate is right after
   * every dispatch" is the invariant a resumable, replayable workflow owes.
   * @type {Record<string, { gate: string, lane: string, files: string[] }>}
   */
  const turns = {};

  /**
   * The two executor-driven edges this test fires with transitionGate (they have
   * no hook caller). Captured so the trace's contiguity assertion can prove the
   * FULL journey has no gaps, not merely the hook-recorded slice of it.
   * @type {{ from: string, to: string }[]}
   */
  const executorEdges = [];

  /** @type {{ script: string, status: number, stdout: string, stderr: string }[]} */
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

  before(async () => {
    ws = seedMonorootWorkspace();
    const stateDir = join(ws.root, '.devmate', 'state');

    // 0. Bootstrap. Nothing under state/ is seeded.
    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    taskId = readState(ws.root).taskId;
    snapshot('bootstrap');

    // The human's bug report (issue step 1). It matches no approval phrase, so it
    // is inert to the gate — included to walk the real event order.
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'pagination drops the last row' }],
      ws.hostCwd,
    );

    // 1. @router → lane-set (lane = bug).
    replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_BODY), ws.hostCwd);
    snapshot('router');

    // 2. @diagnose reproduces the bug and returns the edit boundary. The hook
    // projects diagnosis.json + scope.md, but the bug lane has no diagnosis GATE,
    // so the gate MUST stay at lane-set (its only pre-impl move is the grill).
    replaySession(subagentDispatch('toolu_diagnose_1', 'diagnose', DIAGNOSE_BODY), ws.hostCwd);
    snapshot('diagnose');

    // 3. @rubber-duck grills the diagnosis. grill-result.json lands, and the
    // chain runs finish-grill --> grill-done --present-plan--> plan-approved,
    // where it must HALT for the human.
    replaySession(subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_BODY), ws.hostCwd);
    snapshot('grill');

    // 4. Human: "approve plan" → impl-started (the lane-owned start-impl edge).
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve plan' }],
      ws.hostCwd,
    );
    snapshot('approve-plan');

    // 5. The dispatch gate must now ALLOW @fullstack: impl-started is open and
    // BOTH diagnosis.json and the diagnosis-derived scope.md exist.
    dispatchAllowed = [
      spawnHook(
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
      ),
    ];

    // 6. Fresh, passing verify evidence → pass-verification → verification-passed.
    // Executor-driven (no hook caller). The bug lane has no spec, so the expected
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

    // 7. Human: "approve pr" → pr-ready (verification-passed → pr-ready edge). The
    // bug lane, unlike chore, DOES pass through pr-ready.
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve pr' }],
      ws.hostCwd,
    );
    snapshot('approve-pr');

    // 8. complete → done (again an executor-only event, driven + persisted here).
    const atPrReady = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    const toDone = await transitionGate(atPrReady, 'complete', { stateDir });
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

  it('gate lane-set — advanced AND router-result.json records lane=bug', () => {
    assert.equal(turns['router'].lane, 'bug');
    assert.equal(turns['router'].gate, 'lane-set');
    assert.ok(turns['router'].files.includes('router-result.json'), 'router-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('router-result.json'), 'utf8'));
    assert.equal(artifact.lane, 'bug');
  });

  it('diagnose turn — diagnosis.json + scope.md are derived, but the gate WAITS for the grill', () => {
    // @diagnose holds no edit tool, so the HOOK authors both files from its typed
    // return. There is no diagnosis gate on the bug lane, so the gate must not move.
    assert.equal(turns['diagnose'].gate, 'lane-set', 'the diagnose return advanced the gate before the grill');
    assert.ok(turns['diagnose'].files.includes('diagnosis.json'), 'diagnosis.json was not written');

    const diagnosis = JSON.parse(readFileSync(stateArtifact('diagnosis.json'), 'utf8'));
    const verdict = validateDiagnosisResult(diagnosis);
    assert.ok(verdict.ok, `diagnosis.json is invalid: ${verdict.errors.join('; ')}`);
    assert.equal(diagnosis.taskId, taskId, 'the diagnosis is not bound to this task');

    const scopePath = join(ws.root, '.devmate', 'session', taskId, 'scope.md');
    assert.ok(existsSync(scopePath), 'scope.md was not derived from the diagnosis');
    assert.ok(
      readFileSync(scopePath, 'utf8').includes(FIX_PATH),
      `scope.md does not name the diagnosis's file ${FIX_PATH}`,
    );
  });

  it('gate plan-approved — the grill advances TWO gates and then HALTS for the human', () => {
    // grill-result.json satisfies finish-grill; present-plan has no precondition,
    // so the chain runs grill-done -> plan-approved and stops. It must NOT
    // auto-advance into impl-started — that move belongs to a human.
    assert.equal(turns['grill'].gate, 'plan-approved', 'the bug lane did not halt at plan-approved');
    assert.notEqual(turns['grill'].gate, 'impl-started', 'the lane auto-advanced past the human gate');
    assert.ok(turns['grill'].files.includes('grill-result.json'), 'grill-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('grill-result.json'), 'utf8'));
    const grillVerdict = validateGrillResult(artifact);
    assert.ok(grillVerdict.ok, `grill-result.json is invalid: ${grillVerdict.errors.join('; ')}`);
  });

  it('"approve plan" — the human opens implementation with an actor/evidence audit pair', () => {
    assert.equal(turns['approve-plan'].gate, 'impl-started');

    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const advance = trace.find((e) => e.type === 'gate_transition' && e.to === 'impl-started');
    assert.ok(advance, `no gate_transition to impl-started in the trace: ${trace.map((e) => e.type).join(', ')}`);
    assert.equal(advance.actor, 'hook-exact-phrase');
    assert.equal(advance.evidence, 'approve plan');
  });

  it('dispatch gate — @fullstack is ALLOWED once diagnosis + scope both exist', () => {
    const r = dispatchAllowed[0];
    assert.equal(r.status, 0, `@fullstack dispatch was denied with diagnosis + scope present:\n${r.stdout}${r.stderr}`);
  });

  it('gate verification-passed — reached on fresh, passing evidence', () => {
    // #132 wired pass-verification into LANE_CHAINS, so the gate-advance hook
    // fires this edge; this subtest drives transitionGate + its own persist
    // directly, exercising the same precondition (fresh/passing/spec-matching
    // evidence) the hook checks — enforced in before() via assert.ok.
    assert.equal(turns['verify'].gate, 'verification-passed');
    const verify = JSON.parse(readFileSync(stateArtifact('verify-result.json'), 'utf8'));
    assert.equal(verify.passed, true);
  });

  it('"approve pr" — reaches pr-ready with an actor/evidence audit pair', () => {
    assert.equal(turns['approve-pr'].gate, 'pr-ready');
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const prReady = trace.find((e) => e.type === 'gate_transition' && e.to === 'pr-ready');
    assert.ok(prReady, `no gate_transition to pr-ready in the trace: ${trace.map((e) => e.type).join(', ')}`);
    assert.equal(prReady.actor, 'hook-exact-phrase');
    assert.equal(prReady.evidence, 'approve pr');
  });

  it('gate done (executor-driven, not hook-fired) — the journey terminates at the terminal gate', () => {
    assert.equal(turns['done'].gate, 'done');
  });

  it('never visits a feature-lane-only gate — the bug lane is not the feature lane', () => {
    // The bug lane diagnoses instead of discovering and has no spec gate. If any
    // snapshot ever showed discovery-done / spec-draft / spec-approved, this suite
    // would have been asserting the wrong lane's chain.
    const visited = new Set(Object.values(turns).map((t) => t.gate));
    for (const forbidden of ['discovery-done', 'spec-draft', 'spec-approved']) {
      assert.ok(!visited.has(forbidden), `the bug lane visited the feature-only gate ${forbidden}`);
    }
  });

  it('the trace records the hook-driven gate_transitions in chain order, no duplicates', () => {
    // The audit trail of the moves the HOOKS made: router (set-lane), the grill's
    // two-gate walk (finish-grill, present-plan), and the two human approvals.
    // Executor-driven edges (pass-verification, complete) are asserted for
    // contiguity in the next test — they carry no hook trace by design.
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const recorded = trace
      .filter((e) => e.type === 'gate_transition')
      .map((e) => ({ from: e.from, to: e.to, actor: e.actor, evidence: e.evidence }));

    assert.deepEqual(recorded, [
      { from: 'no-lane', to: 'lane-set', actor: 'hook-evidence', evidence: 'set-lane' },
      { from: 'lane-set', to: 'grill-done', actor: 'hook-evidence', evidence: 'finish-grill' },
      { from: 'grill-done', to: 'plan-approved', actor: 'hook-evidence', evidence: 'present-plan' },
      { from: 'plan-approved', to: 'impl-started', actor: 'hook-exact-phrase', evidence: 'approve plan' },
      { from: 'verification-passed', to: 'pr-ready', actor: 'hook-exact-phrase', evidence: 'approve pr' },
    ]);
  });

  it('the full journey (hook + executor edges) is one contiguous chain, no gaps, no branches', () => {
    // Union the hook-recorded transitions with the two executor-driven edges,
    // index them by their `from` gate (asserting no gate transitions twice — no
    // duplicate, no branch), then WALK from no-lane. A missing edge would stop the
    // walk short; a gap would show up as a path that never reaches done.
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

describe('E2E — bug lane negative twin: no diagnosis means no fix, even with the gate open', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();

    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    taskId = readState(ws.root).taskId;

    // Router classifies bug, and the grill runs — but @diagnose NEVER returns, so
    // diagnosis.json and its derived scope.md are never written. The grill alone
    // is enough to carry the chain to plan-approved (the grill does not depend on
    // the diagnosis), and "approve plan" opens impl-started.
    replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_BODY), ws.hostCwd);
    replaySession(subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_BODY), ws.hostCwd);
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve plan' }],
      ws.hostCwd,
    );
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('the gate is open at impl-started, but the diagnosis artifacts are absent', () => {
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: the human opened the gate');
    assert.ok(
      !existsSync(join(ws.root, '.devmate', 'state', 'diagnosis.json')),
      'diagnosis.json exists — the negative twin cannot prove diagnose-before-fix',
    );
    assert.ok(
      !existsSync(join(ws.root, '.devmate', 'session', taskId, 'scope.md')),
      'scope.md exists — the negative twin cannot prove diagnose-before-fix',
    );
  });

  it('denies the @fullstack dispatch and names the artifact that is missing', () => {
    // Opening the gate must NOT become a way around diagnose-before-fix: the fix
    // is bounded by the diagnosis, and the SubagentStart guard is where that is
    // enforced. A silent deny would be as dangerous as an allow — the model must
    // be told what to produce.
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

    assert.notEqual(r.status, 0, `the implementation dispatch was ALLOWED with no diagnosis:\n${r.stdout}${r.stderr}`);
    // The bug lane checks the diagnosis BEFORE the scope (dispatch-gate.mjs), so
    // the FIRST missing artifact here is always diagnosis.json — assert exactly
    // that, not a `diagnosis|scope` alternation that would also pass on the wrong
    // (scope) reason and hide a re-ordering of the guard's checks.
    assert.match(
      r.stdout + r.stderr,
      /diagnosis\.json/i,
      'the deny message does not name diagnosis.json — the model is not told the fix needs a diagnosis first',
    );
  });
});
