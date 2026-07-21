// @ts-check
/**
 * END-TO-END: the FEATURE lane, walked from `no-lane` all the way to `done`
 * through the real registered hooks — real subprocesses, real payloads, real
 * cwd — asserting at every gate BOTH that the gate advanced AND that the
 * evidence artifact that justifies the move landed on disk.
 *
 * ## Why this suite exists
 *
 * Field reports: a step advances but writes no artifact, so the NEXT step is
 * wedged; or a step writes nothing and the gate silently moves anyway. Until now
 * `test/e2e/lane-gate-advance.e2e.test.mjs` covered only the `approve plan` edge
 * and `test/e2e/session-lifecycle.e2e.test.mjs` covered bootstrap — nothing
 * walked a lane end to end. The 11-step feature procedure and the evidence table
 * in `docs/gates.md` (router-result.json, discovery-merged.json,
 * grill-result.json, critique-result.json, spec.md) were asserted piecemeal in
 * unit tests, never as ONE journey through `hooks/gate-advance.mjs` the way the
 * host runs it.
 *
 * Two failures must both be impossible to ship:
 *   - "gate moved without evidence" — every positive checkpoint asserts the
 *     canonical artifact exists and parses, not merely that the gate name changed.
 *   - "evidence landed but the gate didn't move" — the negative twins feed a
 *     malformed/empty return and assert the gate stayed put AND that a
 *     user-visible message said why (silence is what convinced an orchestrator in
 *     the field its agents were broken).
 *
 * ## What is and isn't seeded
 *
 * Nothing under `state/` is seeded. The session bootstraps its own task.json and
 * every gate artifact is projected from a subagent return by the real hook. The
 * ONLY hand-written artifact is `spec.md` — spec-writer holds an edit tool and is
 * not modeled as a projected subagent return; writing it and firing a plain
 * PostToolUse is exactly what triggers the digest stamp + chain catch-up.
 *
 * This suite simulates host payloads; it cannot prove VS Code itself invokes the
 * hooks. That contract lives in `test/conformance/hooks-contract.test.mjs` — the
 * two suites are deliberately kept separate.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readJsonlSync } from '../../lib/json-io.mjs';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import {
  validateCritiqueResult,
  validateGrillResult,
} from '../../lib/workflow/contracts.mjs';
import { validateDiscoveryArtifact } from '../../lib/workflow/agents/discovery.mjs';
import { validatePlannerArtifact } from '../../lib/workflow/agents/planner.mjs';
import {
  DEFAULT_SESSION_ID as SESSION_ID,
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  walk,
} from './session-harness.mjs';

/**
 * Read a JSONL trace file into objects, via the canonical reader.
 * @param {string} filePath
 * @returns {Record<string, any>[]}
 */
function readTraceEvents(filePath) {
  return /** @type {Record<string, any>[]} */ (readJsonlSync(filePath));
}

/**
 * The SubagentStart that names the agent. This is the ONLY event on the wire that
 * carries the agent's identity; `agent_id` is the parent link the return's
 * `tool_use_id` points back to.
 * @param {string} agentId
 * @param {string} agentType
 * @returns {Record<string, unknown>}
 */
function subagentStart(agentId, agentType) {
  return {
    hook_event_name: 'SubagentStart',
    session_id: SESSION_ID,
    agent_id: agentId,
    agent_type: agentType,
  };
}

/**
 * A `runSubagent` completion in the shape the host delivers: `tool_input` is the
 * elided literal `"..."`, `tool_response` is the agent's final CHAT TEXT with the
 * contract embedded in prose, and `tool_use_id` is the SubagentStart `agent_id`
 * plus a `__vscode-<n>` suffix.
 * @param {string} agentId
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function subagentReturn(agentId, text) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    tool_name: 'runSubagent',
    tool_input: '...',
    tool_response: text,
    tool_use_id: `${agentId}__vscode-1783942732395`,
  };
}

/**
 * The SubagentStop that closes a dispatch. Firing it keeps the concurrency
 * counter honest — a start with no matching stop leaves the agent "running", and
 * a later @fullstack dispatch is denied for `maxConcurrentAgents`.
 * @param {string} agentId
 * @param {string} agentType
 * @returns {Record<string, unknown>}
 */
function subagentStop(agentId, agentType) {
  return {
    hook_event_name: 'SubagentStop',
    session_id: SESSION_ID,
    agent_id: agentId,
    agent_type: agentType,
  };
}

/**
 * The full start → return → stop trio a real dispatch emits.
 * @param {string} agentId
 * @param {string} agentType
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
function dispatch(agentId, agentType, text) {
  return [subagentStart(agentId, agentType), subagentReturn(agentId, text), subagentStop(agentId, agentType)];
}

/**
 * Narrate, then embed a JSON contract — the real return shape. The prose carries
 * a brace before the JSON so a brace-span parser cannot cheat.
 * @param {Record<string, unknown>} body
 * @returns {string}
 */
function narrate(body) {
  return `Returning the contract. The {} braces in this prose come before the JSON.\n\n${JSON.stringify(body, null, 2)}`;
}

/** The one path this workspace makes editable (config: `repo-a/lib/**`). */
const EDIT_PATH = 'repo-a/lib/app.mjs';

/** A terse, compliant feature router return (confidence clears the 0.75 floor). */
const ROUTER_TEXT = narrate({
  agentName: 'router',
  lane: 'feature',
  budgetClass: 'standard',
  confidence: 0.94,
});

/** A discovery return with one high-confidence, path-anchored claim. */
const DISCOVERY_TEXT = narrate({
  agentName: 'discovery',
  claims: [
    { fact: 'The request handler lives here.', path: EDIT_PATH, confidence: 'high' },
  ],
  unverified: ['[UNVERIFIED] the downstream cache is invalidated on write'],
});

/** A grill return: mode grill, the eight finding arrays, one [UNVERIFIED] item. */
const GRILL_TEXT = narrate({
  agentName: 'rubber-duck',
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
});

/** A planner return: one task whose `files` becomes the scope contract. */
const PLANNER_TEXT = narrate({
  agentName: 'planner',
  tasks: [
    {
      description: 'Add the size cap to the request handler.',
      tddApproach: 'Write a failing test for an over-cap body, then clamp it.',
      persona: 'backend',
      ac: ['AC1: a body over the cap is rejected with a 413.'],
      files: [EDIT_PATH],
      alignment: [
        {
          capability: 'request body size cap',
          decision: 'add',
          target: null,
          usageEvidence: [],
          patternRefs: [`${EDIT_PATH}:1`],
          reason: 'fixture: nothing suitable to reuse',
        },
      ],
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
});

/** A critique return: mode critique, the five arrays, a rollback risk, APPROVE. */
const CRITIQUE_TEXT = narrate({
  agentName: 'rubber-duck',
  mode: 'critique',
  missingAcceptanceCriteria: [],
  missingTests: [],
  riskySequencing: [],
  unlistedFiles: [],
  backwardsCompatRisks: [],
  rollbackRisk: 'Low — the change is additive and behind a size check.',
  verdict: 'APPROVE_PLAN',
});

/**
 * The spec the human will review. It MUST carry a `## Acceptance criteria`
 * section (`- [ ] AC1: …`, parsed by `scripts/complete-ac.mjs`) and a
 * `## Files that will change` section (backticked real path, parsed by
 * `continueApprovedFeature` to seed the implementation workstreams).
 */
const SPEC_MD = [
  '# Spec: request body size cap',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] AC1: a body over the configured cap is rejected with a 413.',
  '',
  '## Files that will change',
  '',
  `- \`${EDIT_PATH}\``,
  '',
].join('\n');

/**
 * A plain (non-runSubagent) PostToolUse. `hooks/gate-advance.mjs` skips
 * projection for it but still stamps the spec digest and walks the lane chain —
 * which is how a spec that spec-writer wrote with its edit tool advances the gate.
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

describe('E2E — feature lane: the full journey from no-lane to done', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  /**
   * State + artifacts as they stood at the END of each turn. Snapshotted per turn
   * rather than read once at the end, because "the gate is right after every
   * dispatch" is the invariant a resumable, replayable workflow actually owes.
   * @type {Record<string, { gate: string, lane: string, files: string[] }>}
   */
  const turns = {};

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

    // 0. Bootstrap. Nothing under state/ is seeded.
    replaySession(
      [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
      ws.hostCwd,
    );
    taskId = readState(ws.root).taskId;
    snapshot('bootstrap');

    // The human's task prompt (issue step 1). It matches no approval phrase, so it
    // is inert to the gate — included to walk the real event order.
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'add a request body size cap' }],
      ws.hostCwd,
    );

    // 1. @router → lane-set.
    replaySession(dispatch('toolu_router_1', 'router', ROUTER_TEXT), ws.hostCwd);
    snapshot('router');

    // 2. @discovery → discovery-done.
    replaySession(dispatch('toolu_discovery_1', 'discovery', DISCOVERY_TEXT), ws.hostCwd);
    snapshot('discovery');

    // 3. @rubber-duck (grill) → grill-done.
    replaySession(dispatch('toolu_grill_1', 'rubber-duck', GRILL_TEXT), ws.hostCwd);
    snapshot('grill');

    // 4. @planner → writes plan.json + scope.md, but its return is NOT the
    // finish-plan evidence, so the gate stays at grill-done until the critique.
    replaySession(dispatch('toolu_planner_1', 'planner', PLANNER_TEXT), ws.hostCwd);
    snapshot('planner');

    // 5. @rubber-duck (critique) → critique-result.json → plan-done.
    replaySession(dispatch('toolu_critique_1', 'rubber-duck', CRITIQUE_TEXT), ws.hostCwd);
    snapshot('critique');

    // 6. spec-writer wrote spec.md with its edit tool; a plain PostToolUse stamps
    // the digest and walks plan-done → spec-draft (the human-review halt).
    mkdirSync(join(ws.root, '.devmate', 'session'), { recursive: true });
    writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), SPEC_MD, 'utf8');
    replaySession([plainToolReturn()], ws.hostCwd);
    snapshot('spec');

    // 7. Human: "approve spec" → spec-approved, then continueApprovedFeature runs
    // start-impl → impl-started.
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve spec' }],
      ws.hostCwd,
    );
    snapshot('approve-spec');

    // 8. The dispatch gate must now ALLOW @fullstack: impl-started, a recorded
    // spec, and the planner-derived scope.md all present.
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

    // 9. Per-AC completion via the real script (records impl-AC1 in the trace and
    // refreshes artifactHashes.specDigest to match the checkbox-flipped spec).
    // Assert it succeeded so a crash points HERE, not at the downstream trace miss.
    const acRun = spawnHook('scripts/complete-ac.mjs', ['--ac', '1', '--repo-root', ws.root], {}, ws.root);
    assert.equal(acRun.status, 0, `complete-ac.mjs failed:\n${acRun.stdout}${acRun.stderr}`);

    // 10. Fresh, passing, spec-matching verify evidence → pass-verification →
    // verification-passed. #132 put pass-verification in LANE_CHAINS, so the
    // gate-advance hook fires this edge in a real session; here the test drives
    // transitionGate directly for a deterministic, self-contained advance against
    // the same precondition the hook checks.
    const refreshed = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    writeFileSync(
      stateArtifact('verify-result.json'),
      JSON.stringify({
        passed: true,
        completedAt: new Date().toISOString(),
        specDigest: refreshed.artifactHashes.specDigest,
      }),
      'utf8',
    );
    const stateDir = join(ws.root, '.devmate', 'state');
    const toVerified = await transitionGate(refreshed, 'pass-verification', { stateDir });
    assert.ok(toVerified.ok, `pass-verification refused: ${toVerified.ok ? '' : toVerified.error}`);
    writeFileSync(stateArtifact('task.json'), JSON.stringify(toVerified.state), 'utf8');
    snapshot('verify');

    // 11. Human: "approve pr" → pr-ready (verification-passed → pr-ready edge).
    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve pr' }],
      ws.hostCwd,
    );
    snapshot('approve-pr');

    // 12. complete → done (again an executor-only event, driven + persisted here).
    const atPrReady = /** @type {import('../../lib/types.mjs').TaskState} */ (readState(ws.root));
    const toDone = await transitionGate(atPrReady, 'complete', { stateDir });
    assert.ok(toDone.ok, `complete refused: ${toDone.ok ? '' : toDone.error}`);
    writeFileSync(stateArtifact('task.json'), JSON.stringify(toDone.state), 'utf8');
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

  it('gate lane-set — advanced AND router-result.json exists and parses', () => {
    assert.equal(turns['router'].lane, 'feature');
    assert.equal(turns['router'].gate, 'lane-set');
    assert.ok(turns['router'].files.includes('router-result.json'), 'router-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('router-result.json'), 'utf8'));
    assert.equal(artifact.lane, 'feature');
  });

  it('gate discovery-done — advanced AND discovery-merged.json exists and validates', () => {
    assert.equal(turns['discovery'].gate, 'discovery-done');
    assert.ok(turns['discovery'].files.includes('discovery-merged.json'), 'discovery-merged.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('discovery-merged.json'), 'utf8'));
    const verdict = validateDiscoveryArtifact(artifact);
    assert.ok(verdict.ok, `discovery-merged.json is invalid: ${verdict.errors.join('; ')}`);
  });

  it('gate grill-done — advanced AND grill-result.json exists and validates', () => {
    assert.equal(turns['grill'].gate, 'grill-done');
    assert.ok(turns['grill'].files.includes('grill-result.json'), 'grill-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('grill-result.json'), 'utf8'));
    const verdict = validateGrillResult(artifact);
    assert.ok(verdict.ok, `grill-result.json is invalid: ${verdict.errors.join('; ')}`);
    assert.equal(artifact.taskId, taskId, 'the grill result is not bound to this task');
  });

  it('planner turn — plan.json + scope.md land, but the gate waits for the critique', () => {
    // finish-plan is gated by critique-result.json, NOT by plan.json — so the
    // planner return must move nothing yet.
    assert.equal(turns['planner'].gate, 'grill-done', 'the planner return advanced the gate before the critique');
    const planPath = join(ws.root, '.devmate', 'session', taskId, 'plan.json');
    assert.ok(existsSync(planPath), 'plan.json was not written from the planner return');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.ok(validatePlannerArtifact(plan).ok, 'plan.json is invalid');
  });

  it('gate plan-done — advanced AND critique-result.json exists and validates', () => {
    assert.equal(turns['critique'].gate, 'plan-done');
    assert.ok(turns['critique'].files.includes('critique-result.json'), 'critique-result.json was not written');
    const artifact = JSON.parse(readFileSync(stateArtifact('critique-result.json'), 'utf8'));
    const verdict = validateCritiqueResult(artifact);
    assert.ok(verdict.ok, `critique-result.json is invalid: ${verdict.errors.join('; ')}`);
  });

  it('gate spec-draft — advanced AND a non-empty spec.md exists', () => {
    assert.equal(turns['spec'].gate, 'spec-draft');
    const specPath = join(ws.root, '.devmate', 'session', 'spec.md');
    assert.ok(existsSync(specPath), 'spec.md was not written');
    assert.ok(readFileSync(specPath, 'utf8').trim().length > 0, 'spec.md is empty');
  });

  it('scope.md was derived from the planner tasks[].files before any edit is allowed', () => {
    // #92: the feature lane's edit boundary is authored by the gate-advance hook
    // from @planner's typed return — no agent writes it. It must name the file the
    // plan named, and it must exist BEFORE the dispatch gate lets @fullstack run.
    const scopePath = join(ws.root, '.devmate', 'session', taskId, 'scope.md');
    assert.ok(existsSync(scopePath), 'scope.md was not derived from the planner return');
    assert.ok(
      readFileSync(scopePath, 'utf8').includes(EDIT_PATH),
      `scope.md does not name the planner's file ${EDIT_PATH}`,
    );
  });

  it('"approve spec" — reaches spec-approved with an actor/evidence audit pair, then impl-started', () => {
    // The exact-phrase fast path advances the human gate to spec-approved (stamping
    // the audit pair) and then continueApprovedFeature runs start-impl, so the gate
    // settles at impl-started.
    assert.equal(turns['approve-spec'].gate, 'impl-started');

    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const approved = trace.find((e) => e.type === 'gate_transition' && e.to === 'spec-approved');
    assert.ok(approved, `no gate_transition to spec-approved in the trace: ${trace.map((e) => e.type).join(', ')}`);
    assert.equal(approved.actor, 'hook-exact-phrase');
    assert.equal(approved.evidence, 'approve spec');
  });

  it('never puts start-impl in the feature chain — HITL-2 holds end to end', () => {
    // The move into impl-started came from continueApprovedFeature AFTER the human
    // approval, never from the internal evidence chain. There must be no
    // gate_transition into impl-started whose actor is the evidence hook.
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const bypass = trace.find(
      (e) => e.type === 'gate_transition' && e.to === 'impl-started' && e.actor === 'hook-evidence',
    );
    assert.ok(!bypass, 'the evidence chain advanced into impl-started — the spec gate was bypassed');
  });

  it('dispatch gate — @fullstack is ALLOWED once spec + scope both exist', () => {
    const r = dispatchAllowed[0];
    assert.equal(r.status, 0, `@fullstack dispatch was denied at impl-started:\n${r.stdout}${r.stderr}`);
  });

  it('gate verification-passed — reached on fresh, passing, spec-matching evidence', () => {
    // #132 wired pass-verification into LANE_CHAINS, so the gate-advance hook
    // fires this edge; this subtest drives transitionGate + its own persist
    // directly, exercising the same precondition (fresh/passing/spec-matching
    // evidence) the hook checks — enforced in before() via `assert.ok(toVerified.ok)`.
    assert.equal(turns['verify'].gate, 'verification-passed');
    const verify = JSON.parse(readFileSync(stateArtifact('verify-result.json'), 'utf8'));
    assert.equal(verify.passed, true);
  });

  it('records impl-AC1 completion in the trace', () => {
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const ac = trace.find((e) => e.type === 'step_complete' && e.stepId === 'impl-AC1');
    assert.ok(ac, `no impl-AC1 step_complete in the trace: ${trace.map((e) => e.type).join(', ')}`);
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
    // complete, like pass-verification, is fired by a lane executor with no hook
    // caller; driven + persisted here exactly as the executor would.
    assert.equal(turns['done'].gate, 'done');
  });
});

/**
 * Negative twins. For each internal gate, a malformed/empty return must NOT
 * advance the gate, and must NOT do so silently — a swallowed failure is how a
 * gate appears to move when nothing landed.
 *
 * Each case drives the session up to the turn under test with COMPLIANT returns,
 * then feeds a pure-prose return (no contract) for the step being negated.
 */
describe('E2E — feature lane: a return with no contract advances nothing, loudly', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>[]} */
  const workspaces = [];

  after(() => {
    for (const ws of workspaces) {
      if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
    }
  });

  /**
   * Bootstrap a session and replay the given compliant prefix, then return the ws.
   * @param {Record<string, unknown>[]} prefixEvents
   * @returns {ReturnType<typeof seedMonorootWorkspace>}
   */
  function seedUpTo(prefixEvents) {
    const ws = seedMonorootWorkspace();
    workspaces.push(ws);
    replaySession([{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }], ws.hostCwd);
    if (prefixEvents.length > 0) replaySession(prefixEvents, ws.hostCwd);
    return ws;
  }

  const PROSE = 'Looks fine to me. No structured output.';

  /**
   * @type {{ name: string, prefix: Record<string, unknown>[], agentId: string,
   *   agentType: string, stayGate: string, artifact: string }[]}
   */
  const cases = [
    {
      name: 'router (no lane classified)',
      prefix: [],
      agentId: 'toolu_router_1',
      agentType: 'router',
      stayGate: 'no-lane',
      artifact: 'router-result.json',
    },
    {
      name: 'discovery',
      prefix: dispatch('toolu_router_1', 'router', ROUTER_TEXT),
      agentId: 'toolu_discovery_1',
      agentType: 'discovery',
      stayGate: 'lane-set',
      artifact: 'discovery-merged.json',
    },
    {
      name: 'grill',
      prefix: [
        ...dispatch('toolu_router_1', 'router', ROUTER_TEXT),
        ...dispatch('toolu_discovery_1', 'discovery', DISCOVERY_TEXT),
      ],
      agentId: 'toolu_grill_1',
      agentType: 'rubber-duck',
      stayGate: 'discovery-done',
      artifact: 'grill-result.json',
    },
    {
      name: 'critique',
      prefix: [
        ...dispatch('toolu_router_1', 'router', ROUTER_TEXT),
        ...dispatch('toolu_discovery_1', 'discovery', DISCOVERY_TEXT),
        ...dispatch('toolu_grill_1', 'rubber-duck', GRILL_TEXT),
        ...dispatch('toolu_planner_1', 'planner', PLANNER_TEXT),
      ],
      agentId: 'toolu_critique_1',
      agentType: 'rubber-duck',
      stayGate: 'grill-done',
      artifact: 'critique-result.json',
    },
  ];

  for (const step of cases) {
    describe(`negative — ${step.name}`, () => {
      /** @type {ReturnType<typeof seedMonorootWorkspace>} */
      let ws;
      /** @type {{ script: string, status: number, stdout: string, stderr: string }[]} */
      let ran;

      before(() => {
        ws = seedUpTo(step.prefix);
        ran = replaySession(
          [subagentStart(step.agentId, step.agentType), subagentReturn(step.agentId, PROSE)],
          ws.hostCwd,
        );
      });

      it('does not advance the gate and writes no artifact', () => {
        assert.equal(readState(ws.root).workflowGate, step.stayGate);
        assert.ok(
          !existsSync(join(ws.root, '.devmate', 'state', step.artifact)),
          `${step.artifact} was written from a contract-less return`,
        );
      });

      it('tells the model what went wrong on a non-zero exit', () => {
        const spoke = ran.filter((r) => r.status !== 0);
        const output = ran.map((r) => r.stdout + r.stderr).join('\n');
        assert.ok(spoke.length > 0, `every hook exited 0 — the failure was invisible to the model:\n${output}`);
        assert.ok(
          output.toLowerCase().includes(step.artifact.toLowerCase()),
          `the message does not name the artifact that was not written (${step.artifact}):\n${output}`,
        );
      });
    });
  }
});

describe('E2E — feature lane: an empty spec does not open the human-review gate', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('leaves the gate at plan-done when spec.md is empty', () => {
    ws = seedMonorootWorkspace();
    replaySession([{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }], ws.hostCwd);
    replaySession(
      [
        ...dispatch('toolu_router_1', 'router', ROUTER_TEXT),
        ...dispatch('toolu_discovery_1', 'discovery', DISCOVERY_TEXT),
        ...dispatch('toolu_grill_1', 'rubber-duck', GRILL_TEXT),
        ...dispatch('toolu_planner_1', 'planner', PLANNER_TEXT),
        ...dispatch('toolu_critique_1', 'rubber-duck', CRITIQUE_TEXT),
      ],
      ws.hostCwd,
    );
    assert.equal(readState(ws.root).workflowGate, 'plan-done', 'precondition: the lane reached plan-done');

    // An empty spec.md must not satisfy the spec-draft precondition.
    mkdirSync(join(ws.root, '.devmate', 'session'), { recursive: true });
    writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), '', 'utf8');
    replaySession([plainToolReturn()], ws.hostCwd);

    assert.equal(readState(ws.root).workflowGate, 'plan-done', 'an empty spec.md opened the human-review gate');
  });
});

describe('E2E — feature lane: @fullstack is DENIED before impl-started (dispatch gate negative twin)', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('denies the implementation dispatch, loudly, when the gate has not reached impl-started', () => {
    // The ALLOW twin (above) asserts status===0 once spec + scope both exist; on its
    // own it would still pass if the gate regressed to "always allow". This proves the
    // enforcement: at a freshly bootstrapped no-lane session — no spec, no scope — the
    // same guard must refuse @fullstack with a non-zero exit that names the missing
    // gate, so the model is told why.
    ws = seedMonorootWorkspace();
    replaySession([{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }], ws.hostCwd);

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

    assert.notEqual(r.status, 0, `@fullstack dispatch was allowed at no-lane:\n${r.stdout}${r.stderr}`);
    const output = (r.stdout + r.stderr).toLowerCase();
    assert.ok(
      output.includes('impl-started'),
      `the deny message does not name the required gate (impl-started):\n${r.stdout}${r.stderr}`,
    );
  });
});
