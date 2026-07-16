// @ts-check
/**
 * END-TO-END: the bug lane must be able to reach its gates on the evidence its own
 * agents return. Turn by turn, artifact by artifact.
 *
 * ## What was broken
 *
 * A user's bug lane wedged at `lane-set` forever. `@rubber-duck` completed a grill
 * TWICE; `grill-result.json` never appeared; `approve plan` was refused ("does not
 * accept event start-impl"); and the orchestrator — told nothing, because every
 * diagnostic went to a stderr channel the model never reads — concluded its agents
 * were broken and began doing the work inline, the one thing its prompt forbids.
 *
 * On the bug lane `lane-set --finish-grill--> grill-done` is the ONLY
 * pre-implementation transition and its sole evidence is `grill-result.json`. Two
 * independent defects made that file unwritable:
 *
 *   1. `agents/rubber-duck.agent.md` documents a `report`-NESTED envelope and never
 *      mentions `schemaVersion`/`returnedAt`; `validateGrillResult` demands a FLAT
 *      body carrying both. An agent obeying its own card failed on ~11 fields.
 *   2. `extractEmbeddedJson` took a first-`{`-to-last-`}` span across the agent's
 *      whole reply, so a chatty return — prose containing a brace, which is what a
 *      grill report looks like — did not parse at all, and the return never even
 *      reached `worker-returns/`.
 *
 * The return below reproduces BOTH: the card's envelope, wrapped in prose that
 * contains a brace before the JSON.
 *
 * ## Why this suite and not a unit test
 *
 * Nothing here is seeded. The session must produce every artifact itself, through
 * the REAL hooks, as real subprocesses. Every previous test of this machinery
 * pre-seeded `diagnosis.json` and `scope.md` — which is exactly how a workflow whose
 * writers could never fire kept a green suite.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readJsonlSync } from '../../lib/json-io.mjs';
import { validateDiagnosisResult, validateGrillResult } from '../../lib/workflow/contracts.mjs';
import { readState, replaySession, seedMonorootWorkspace, walk } from './session-harness.mjs';

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
 * A `runSubagent` completion, in the shape the host actually delivers.
 *
 * Ground truth: `test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json`
 * — `tool_input` is the literal string `"..."` (so identity cannot come from it),
 * `tool_response` is the agent's final CHAT TEXT with the contract embedded in it,
 * and `tool_use_id` is the SubagentStart `agent_id` plus a `__vscode-<n>` suffix.
 *
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
 * The SubagentStart that names the agent. This is the ONLY event on the wire that
 * carries the agent's identity, and `agent_id` is the parent link to the dispatch
 * (pinned in `test/conformance/agent-identity.test.mjs`).
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

/** A terse, compliant router return — the one shape the wire has actually confirmed. */
const ROUTER_TEXT =
  'Classifying the task by intent and scope now.\n\n' +
  '{"agentName":"router","lane":"bug","budgetClass":"standard","confidence":0.94}';

/** A flat diagnose return, as `agents/diagnose.agent.md` documents it. */
const DIAGNOSE_TEXT =
  'Reproduced the failure and traced it to the cursor clamp.\n\n' +
  JSON.stringify({
    agentName: 'diagnose',
    bugScope: 'backend',
    suspectedLayer: 'repo-a/lib/cursor.mjs',
    reproCommand: 'npm test -- cursor',
    fixerRecommendation: 'clamp the batch cursor at the final page boundary',
    allowedPaths: ['repo-a/lib/cursor.mjs'],
    allowedGlobs: [],
  });

/**
 * The grill return that broke the lane, reproduced faithfully:
 *   - narrated in prose, as every agent narrates;
 *   - the prose contains a `{` BEFORE the contract (fatal to a brace-span parser);
 *   - the contract is fenced, and nests its body under `report` per the card;
 *   - it carries no `schemaVersion` and no `returnedAt`, because its card has never
 *     told it those fields exist.
 */
const GRILL_TEXT = [
  'I grilled the diagnosis. The guard currently returns `{}` for an anonymous',
  'caller, so the protected branch is reachable without a role claim.',
  '',
  'Here is the report:',
  '',
  '```json',
  JSON.stringify(
    {
      agentName: 'rubber-duck',
      status: 'ok',
      mode: 'grill',
      report: {
        assumptions: ['The role claim is always present on an authenticated request.'],
        missingRequirements: [],
        edgeCases: ['A caller with no role claim at all.'],
        cornerCases: [],
        securityRisks: ['A non-internal caller could read protected content.'],
        uxRisks: [],
        blockingQuestions: [],
        recommendedDecisions: ['Fail closed when the role claim is absent.'],
        unverifiedItems: ['[UNVERIFIED] the claim shape in the auth token'],
      },
    },
    null,
    2,
  ),
  '```',
].join('\n');

describe('E2E — bug lane: the gate advances on the evidence its agents return', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  /**
   * State + artifacts as they stood at the END of each turn.
   *
   * Snapshotted per turn rather than read once at the end, because "the gate is
   * right when it is all over" is a much weaker claim than "the gate is right after
   * every single dispatch" — and the second is the one a resumable, replayable
   * workflow actually has to make.
   * @type {Record<string, { gate: string, lane: string, files: string[] }>}
   */
  const turns = {};

  /** @type {{ script: string, status: number, stdout: string, stderr: string }[]} */
  let grillRun;

  /** @param {string} name */
  const snapshot = (name) => {
    const state = readState(ws.root);
    turns[name] = {
      gate: state.workflowGate,
      lane: state.lane,
      files: walk(join(ws.root, '.devmate', 'state')),
    };
  };

  before(() => {
    ws = seedMonorootWorkspace();

    // 1. The session bootstraps its own task state. Nothing is seeded.
    replaySession([{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }], ws.hostCwd);
    taskId = readState(ws.root).taskId;
    snapshot('bootstrap');

    // 2. @router classifies the lane.
    replaySession(
      [subagentStart('toolu_router_1', 'router'), subagentReturn('toolu_router_1', ROUTER_TEXT)],
      ws.hostCwd,
    );
    snapshot('router');

    // 3. @diagnose reproduces the bug and returns the edit boundary.
    replaySession(
      [subagentStart('toolu_diagnose_1', 'diagnose'), subagentReturn('toolu_diagnose_1', DIAGNOSE_TEXT)],
      ws.hostCwd,
    );
    snapshot('diagnose');

    // 4. @rubber-duck grills it — the turn that produced silence in the field.
    grillRun = replaySession(
      [subagentStart('toolu_duck_1', 'rubber-duck'), subagentReturn('toolu_duck_1', GRILL_TEXT)],
      ws.hostCwd,
    );
    snapshot('grill');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  /** @param {string} name */
  function stateArtifact(name) {
    return join(ws.root, '.devmate', 'state', name);
  }

  it('turn 0 — the session bootstraps at no-lane with no evidence on disk', () => {
    assert.equal(turns['bootstrap'].gate, 'no-lane');
    assert.ok(
      !turns['bootstrap'].files.includes('router-result.json'),
      'a gate artifact existed before any agent ran — the workspace was pre-seeded and this suite proves nothing',
    );
  });

  it('turn 1 — @router: the lane is set, from the artifact and not from prose', () => {
    assert.equal(turns['router'].lane, 'bug');
    assert.equal(turns['router'].gate, 'lane-set');
    assert.ok(turns['router'].files.includes('router-result.json'), 'router-result.json was not written');
  });

  it('turn 2 — @diagnose: diagnosis.json and scope.md are derived from the return', () => {
    // @diagnose holds no edit tool, so the HOOK authors both files from its typed
    // return. If either is missing, the bug lane cannot bound a fix.
    assert.ok(turns['diagnose'].files.includes('diagnosis.json'), 'diagnosis.json was not written');

    const diagnosis = JSON.parse(readFileSync(stateArtifact('diagnosis.json'), 'utf8'));
    const verdict = validateDiagnosisResult(diagnosis);
    assert.ok(verdict.ok, `diagnosis.json is invalid: ${verdict.errors.join('; ')}`);
    assert.equal(diagnosis.taskId, taskId, 'the diagnosis is not bound to this task');

    const scopePath = join(ws.root, '.devmate', 'session', taskId, 'scope.md');
    assert.ok(existsSync(scopePath), 'scope.md was not derived from the diagnosis');

    // There is no diagnosis GATE — the bug lane's only pre-implementation move is
    // the grill. So the gate must still be waiting here.
    assert.equal(turns['diagnose'].gate, 'lane-set');
  });

  it('turn 3 — @rubber-duck: a chatty, card-shaped grill return still lands as evidence', () => {
    // THE BUG. The agent narrated (with a brace in the prose) and nested its body
    // under `report`, exactly as its card instructs. On the broken code this file
    // does not exist, and nothing anywhere says why.
    assert.ok(
      turns['grill'].files.includes('grill-result.json'),
      'grill-result.json was NOT written from a compliant grill return — the bug lane is a dead end:\n' +
        grillRun.map((r) => `  [${r.script}] ${r.stdout}${r.stderr}`).join('\n'),
    );

    const grill = JSON.parse(readFileSync(stateArtifact('grill-result.json'), 'utf8'));
    const verdict = validateGrillResult(grill);
    assert.ok(verdict.ok, `grill-result.json is invalid: ${verdict.errors.join('; ')}`);

    // The analysis survived the round trip — the host stamped the machine fields
    // around it; it did not invent or drop the agent's findings.
    assert.deepEqual(grill.securityRisks, ['A non-internal caller could read protected content.']);
    assert.equal(grill.taskId, taskId, 'the grill result is not bound to this task');
    assert.equal(grill.schemaVersion, 1);
    assert.ok(typeof grill.returnedAt === 'string' && grill.returnedAt !== '');
  });

  it('turn 3 — the gate finally moves, and stops where the human is', () => {
    // The whole point. On the broken code this sits at `lane-set` forever, and
    // `approve plan` is refused with "does not accept event start-impl" — the exact
    // wedge the user hit.
    //
    // It advances TWO gates: `finish-grill` is evidence-gated (grill-result.json now
    // exists) and `present-plan` has no precondition, so the chain runs on to
    // `plan-approved` — which is precisely where the bug lane must stop, because the
    // next move belongs to a human typing "approve plan".
    assert.equal(
      turns['grill'].gate,
      'plan-approved',
      'the lane did not advance on the evidence it had just been handed',
    );
  });

  it('records grill_complete in the trace — the audit trail that was always empty', () => {
    // `grill_complete` has been in the trace schema since E11-3; the trace viewer
    // renders it and the rubber-duck card promises it. Nothing ever emitted one. The
    // existing tests asserted the schema ACCEPTS the event and that appendTraceEvent
    // CAN write it — neither asserted that anything ever calls it, which is how a
    // stage that runs on every task left no audit record whatsoever.
    const trace = readTraceEvents(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`));
    const grill = trace.find((e) => e.type === 'grill_complete');

    assert.ok(grill, `no grill_complete event in the trace: ${trace.map((e) => e.type).join(', ')}`);
    assert.deepEqual(grill.assumptions, [
      'The role claim is always present on an authenticated request.',
    ]);
    assert.equal(grill.taskId, taskId);
  });

  it('every dispatch is persisted, so the orchestrator can see its workers ran', () => {
    // The orchestrator is told to confirm a specialist ran by reading its persisted
    // return. In the field only @router and @diagnose ever appeared here, so a grill
    // that HAD run looked like it never happened.
    const returns = walk(join(ws.root, '.devmate', 'state', 'worker-returns'));
    assert.equal(returns.length, 3, `expected one return per dispatch, got: ${returns.join(', ')}`);
    assert.ok(returns.some((f) => f.startsWith('router.')));
    assert.ok(returns.some((f) => f.startsWith('diagnose.')));
    assert.ok(
      returns.some((f) => f.startsWith('rubber-duck.')),
      'the grill return was never persisted — a chatty reply vanished without a trace',
    );
  });
});

describe('E2E — bug lane: a return that cannot become evidence says so, loudly', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {{ script: string, status: number, stdout: string, stderr: string }[]} */
  let ran;

  before(() => {
    ws = seedMonorootWorkspace();
    replaySession([{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }], ws.hostCwd);
    replaySession(
      [subagentStart('toolu_router_1', 'router'), subagentReturn('toolu_router_1', ROUTER_TEXT)],
      ws.hostCwd,
    );

    // A grill that returns pure prose — no contract at all. This MUST NOT advance
    // the gate, and it must not do so silently: silence is what convinced the
    // orchestrator its agents were broken and that it should work inline instead.
    ran = replaySession(
      [
        subagentStart('toolu_duck_1', 'rubber-duck'),
        subagentReturn('toolu_duck_1', 'The plan looks fine to me. No blocking issues.'),
      ],
      ws.hostCwd,
    );
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('does not advance the gate on a return that carries no contract', () => {
    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'lane-set');
    assert.ok(!existsSync(join(ws.root, '.devmate', 'state', 'grill-result.json')));
  });

  it('tells the MODEL what went wrong and what to do about it', () => {
    // stderr on a non-zero exit is the channel VS Code shows the model — the same
    // mechanism hooks/contract-validator.mjs already uses. A zero exit with a note
    // in the Output panel reaches nobody.
    const spoke = ran.filter((r) => r.status !== 0);
    const output = ran.map((r) => r.stdout + r.stderr).join('\n');

    assert.ok(
      spoke.length > 0,
      `every hook exited 0 — the failure was invisible to the model:\n${output}`,
    );
    assert.match(output, /rubber-duck/i, 'the message does not name the agent that failed');
    assert.match(output, /grill-result\.json/i, 'the message does not name the artifact that was not written');
    assert.match(output, /re-?dispatch/i, 'the message does not tell the model how to recover');
  });
});
