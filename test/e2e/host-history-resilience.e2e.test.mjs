// @ts-check
/**
 * END-TO-END: host-side history manipulation (issue #7) — chat forks,
 * checkpoint restores, context compaction, and hard interrupts. VS Code can
 * rewrite the conversation or the workspace underneath devmate's durable
 * state; these suites prove the on-disk task state stays coherent, or
 * detects that it can't.
 *
 * ## How the host features are modeled
 *
 *  - A FORK "creates a new independent session starting from that checkpoint"
 *    that "inherits the existing conversation history" (VS Code docs). On
 *    disk that is exactly: a second `SessionStart` over the SAME workspace —
 *    the harness's {@link startSession}. Both sessions then talk to one
 *    task.json.
 *  - A CHECKPOINT RESTORE "reverts the workspace to the state it was in at
 *    the time of that checkpoint … all changes made to files after that
 *    checkpoint will be undone". The docs do not define whether hook-written
 *    files (task.json) are in the reverted set, so BOTH cases are tested
 *    empirically (the issue's [UNVERIFIED] item): case 3 reverts spec.md
 *    only; case 4 reverts task.json only. The revert itself is a plain file
 *    write — the host fires no hook for it — so detection must come from the
 *    NEXT event, which is what each case fires.
 *  - COMPACTION is the real `PreCompact` hook (scripts/compact-session.mjs)
 *    followed by a fresh session — the documented round trip.
 *  - A HARD INTERRUPT is a `SubagentStart` whose `SubagentStop` never fires
 *    (host crash mid-dispatch); the next session's reconciliation (DN-6) is
 *    the recovery under test.
 *
 * True concurrent-process interleaving is nondeterministic, so the fork
 * races use lock-step orchestration (each hook spawn is a barrier) to make
 * the races reproducible — per the issue's stated trade-off.
 *
 * Nothing under `state/` is pre-seeded: every workspace earns its gates from
 * compliant subagent returns through the real registered hooks. Hand-written
 * pieces are the ones a real flow writes outside the hook path: `spec.md`
 * (spec-writer holds an edit tool), the spec metadata (emulating
 * `lib/workflow/agents/spec-writer.mjs`'s writeMetadata, which no hook
 * drives), and — for the compaction READY case — the refined OutputContract
 * `done_when` and the evidence-pack pointers the orchestrator/context layer
 * persist on a real mid-implementation task.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_SESSION_ID as SESSION_A,
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  startSession,
  subagentDispatch,
} from './session-harness.mjs';

/** The forked session over the same workspace (case 1–2). */
const SESSION_B = '7f1c9e02-52b1-49ef-9dbc-6f6f1a2b3c4d';

/** The fresh session after a compaction / hard interrupt (cases 5–6). */
const SESSION_NEXT = '0a64d0d5-1d5f-4a37-9f60-8f6a7b8c9d0e';

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

/** The spec the human reviews: two ACs + the files section continuation needs. */
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
 * A spec WITHOUT a files section and no persisted metadata: `approve spec`
 * durably reaches `spec-approved` but continuation fails — the realistic
 * resting state at the gate `hooks/spec-integrity-guard.mjs` protects.
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
 * A plain (non-runSubagent) PostToolUse naming the spec path: stamps the spec
 * digest and walks the lane chain — and, at `spec-approved`, is the event the
 * spec-integrity-guard re-hashes the file on.
 * @param {string} sessionId
 * @returns {Record<string, unknown>}
 */
function specToolReturn(sessionId) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: 'str_replace_editor',
    tool_input: { filePath: '.devmate/session/spec.md' },
    tool_response: 'ok',
    tool_use_id: 'toolu_spec_write__vscode-1',
  };
}

/**
 * Submit a user prompt in the named session and return the hook outputs.
 * @param {{ hostCwd: string }} ws
 * @param {string} sessionId
 * @param {string} prompt
 */
function promptTurn(ws, sessionId, prompt) {
  return replaySession(
    [{ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt }],
    ws.hostCwd,
  );
}

/**
 * Fire one SubagentStart or SubagentStop through the real budget guard,
 * exactly as the host does for the named session.
 * @param {{ hostCwd: string }} ws
 * @param {'start'|'stop'} mode
 * @param {string} sessionId
 * @param {string} agentId
 * @param {string} agentType
 */
function subagentEvent(ws, mode, sessionId, agentId, agentType) {
  return spawnHook(
    'hooks/subagent-budget-guard.mjs',
    [mode],
    {
      hook_event_name: mode === 'start' ? 'SubagentStart' : 'SubagentStop',
      session_id: sessionId,
      agent_id: agentId,
      agent_type: agentType,
      cwd: ws.hostCwd,
    },
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

/**
 * Read the raw trace and assert EVERY line is intact JSON — the "no torn
 * writes" oracle for the fork races. Returns the parsed events.
 *
 * Honest scope: this oracle is structural-serialization-only. The harness
 * drives every hook through spawnSync sequentially (issue #7's lock-step
 * directive, chosen over nondeterministic true parallelism), so no write is ever
 * contended here and the lock modules are not exercised under contention —
 * what IS proven is that interleaved SESSIONS' writes land whole and ordered.
 * A direct two-overlapping-writers test against lib/file-lock.mjs is the
 * follow-up that would cover real contention without breaking determinism.
 * @param {{ root: string }} ws @param {string} taskId
 * @returns {Record<string, any>[]}
 */
function parseWholeTrace(ws, taskId) {
  const raw = readFileSync(tracePath(ws, taskId), 'utf8');
  /** @type {Record<string, any>[]} */
  // @bounded-alloc — one entry per trace line of a single scripted task.
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    events.push(JSON.parse(line)); // a torn line throws and fails the test
  }
  return events;
}

/**
 * Drive a freshly seeded workspace to the named feature-lane stage through
 * the real hooks (the journey recipe; stages are cumulative prefixes).
 * @param {ReturnType<typeof seedMonorootWorkspace>} ws
 * @param {'grill-done'|'spec-draft'|'impl-started'} stage
 * @param {{ spec?: string, specMetadata?: boolean }} [opts]
 */
function driveFeatureTo(ws, stage, opts = {}) {
  startSession(ws.hostCwd, SESSION_A);

  replaySession(
    [
      ...subagentDispatch('toolu_router_1', 'router', ROUTER_RETURN),
      ...subagentDispatch('toolu_discovery_1', 'discovery', DISCOVERY_RETURN),
      ...subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_RETURN),
    ],
    ws.hostCwd,
  );
  if (stage === 'grill-done') return;

  replaySession(
    [
      ...subagentDispatch('toolu_planner_1', 'planner', PLANNER_RETURN),
      ...subagentDispatch('toolu_critique_1', 'rubber-duck', CRITIQUE_RETURN),
    ],
    ws.hostCwd,
  );

  // spec-writer wrote spec.md with its edit tool; its metadata contract
  // (specFiles + the ordered AC list — lib/workflow/agents/spec-writer.mjs
  // writeMetadata) is emulated because no hook drives that agent module.
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
  replaySession([specToolReturn(SESSION_A)], ws.hostCwd);
  if (stage === 'spec-draft') return;

  replaySession(
    [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_A, prompt: 'approve spec' }],
    ws.hostCwd,
  );
}

// ---------------------------------------------------------------------------
// 1. Fork race: two sessions, one durable task
// ---------------------------------------------------------------------------

describe('E2E fork — two sessions share one durable task; the disk wins over either history', () => {
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

  it('the fork bootstraps no second task — session B joins the same task.json', () => {
    startSession(ws.hostCwd, SESSION_B);
    const state = readState(ws.root);
    assert.equal(state.taskId, taskId, 'the fork minted a second task over the in-flight one');
    assert.equal(state.workflowGate, 'spec-draft');
  });

  it('B approves the spec: the shared gate advances exactly once', () => {
    promptTurn(ws, SESSION_B, 'approve spec');
    assert.equal(readState(ws.root).workflowGate, 'impl-started');

    const approvals = parseWholeTrace(ws, taskId).filter(
      (e) => e.type === 'gate_transition' && e.to === 'spec-approved',
    );
    assert.equal(approvals.length, 1, 'the approval was recorded more than once');
  });

  it("A's stale approval is a friendly no-op, re-anchored to the durable gate — never a double-advance", () => {
    // Session A's history still believes the gate is spec-draft. Its stale
    // "approve spec" must not re-fire the approval or move anything.
    const outputs = promptTurn(ws, SESSION_A, 'approve spec');
    const stdout = outputs.map((o) => o.stdout).join('\n');

    assert.ok(
      stdout.includes('already approved'),
      `A was not told the spec is already approved:\n${stdout}`,
    );
    assert.ok(
      stdout.includes('<devmate-state>') && stdout.includes('impl-started'),
      `A was not re-anchored to the durable gate:\n${stdout}`,
    );
    assert.equal(readState(ws.root).workflowGate, 'impl-started', "A's stale approval moved the gate");

    const approvals = parseWholeTrace(ws, taskId).filter(
      (e) => e.type === 'gate_transition' && e.to === 'spec-approved',
    );
    assert.equal(approvals.length, 1, "A's stale approval double-advanced the gate");
  });

  it("A's revise request lands as recorded feedback, not a gate move, and no file is torn", () => {
    promptTurn(ws, SESSION_A, 'revise spec: tighten the cap wording');

    // Durable state is intact and unmoved …
    const state = readState(ws.root); // JSON.parse throws on a torn task.json
    assert.equal(state.workflowGate, 'impl-started');
    assert.equal(state.taskId, taskId);

    // … and the interleaved sessions' trace writes serialized: every line is
    // whole JSON, and A's feedback landed alongside B's approval.
    const events = parseWholeTrace(ws, taskId);
    const revision = events.find((e) => e.type === 'spec_revision_requested');
    assert.ok(revision, "A's revision feedback was not traced");
    assert.equal(revision.feedback, 'tighten the cap wording');
  });
});

// ---------------------------------------------------------------------------
// 2. Fork + both dispatch: the concurrency budget is global, not per session
// ---------------------------------------------------------------------------

describe('E2E fork — interleaved dispatch from two sessions shares one concurrency budget', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'impl-started');
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: reached impl-started');
    startSession(ws.hostCwd, SESSION_B);
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('counts interleaved starts from both sessions against ONE maxConcurrentAgents ceiling', () => {
    // Lock-step interleaving (each spawn is a barrier): A, B, A fill the
    // default ceiling of 3; B's fourth start must be denied GLOBALLY even
    // though session B itself has started only one agent.
    const a1 = subagentEvent(ws, 'start', SESSION_A, 'toolu_a1', 'fullstack');
    assert.equal(a1.status, 0, `A's first dispatch was denied:\n${a1.stdout}${a1.stderr}`);
    const b1 = subagentEvent(ws, 'start', SESSION_B, 'toolu_b1', 'fullstack');
    assert.equal(b1.status, 0, `B's first dispatch was denied:\n${b1.stdout}${b1.stderr}`);
    const a2 = subagentEvent(ws, 'start', SESSION_A, 'toolu_a2', 'fullstack');
    assert.equal(a2.status, 0, `A's second dispatch was denied:\n${a2.stdout}${a2.stderr}`);

    assert.equal(readState(ws.root).activeSubagents, 3);
    assert.equal((readState(ws.root).activeAgents ?? []).length, 3, 'the in-flight roster lost an entry');

    const b2 = subagentEvent(ws, 'start', SESSION_B, 'toolu_b2', 'fullstack');
    assert.notEqual(b2.status, 0, 'the 4th interleaved start was allowed past the global ceiling');
    assert.ok(
      (b2.stdout + b2.stderr).includes('maxConcurrentAgents'),
      `the deny does not name the ceiling:\n${b2.stdout}${b2.stderr}`,
    );
    assert.equal(readState(ws.root).activeSubagents, 3, 'a denied start mutated the counter');
  });

  it('a stop from one session frees a slot the OTHER session can then take', () => {
    subagentEvent(ws, 'stop', SESSION_A, 'toolu_a1', 'fullstack');
    assert.equal(readState(ws.root).activeSubagents, 2);

    const b2 = subagentEvent(ws, 'start', SESSION_B, 'toolu_b2', 'fullstack');
    assert.equal(b2.status, 0, `B's retry after A's stop was denied:\n${b2.stdout}${b2.stderr}`);
    assert.equal(readState(ws.root).activeSubagents, 3);
  });

  it('interleaved stops drain the counter and the roster to exactly zero', () => {
    subagentEvent(ws, 'stop', SESSION_B, 'toolu_b1', 'fullstack');
    subagentEvent(ws, 'stop', SESSION_A, 'toolu_a2', 'fullstack');
    subagentEvent(ws, 'stop', SESSION_B, 'toolu_b2', 'fullstack');

    const state = readState(ws.root);
    assert.equal(state.activeSubagents, 0, 'interleaved stops left the counter nonzero');
    assert.deepEqual(state.activeAgents ?? [], [], 'interleaved stops leaked a roster entry');
  });
});

// ---------------------------------------------------------------------------
// 3. Checkpoint restore of spec.md after approval
// ---------------------------------------------------------------------------

describe('E2E restore — a reverted spec.md after approval trips the integrity guard on the next PostToolUse', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {string} */
  let approvedDigest;

  /** The pre-approval spec text a checkpoint restore reverts to. */
  const SPEC_V1 = SPEC_MD_NO_FILES;
  /** The text the human actually approved. */
  const SPEC_V2 = `${SPEC_MD_NO_FILES}\n## Out of scope\n\n- multipart bodies.\n`;

  before(() => {
    ws = seedMonorootWorkspace();
    // Reach spec-draft on V1, then edit to V2 (digest restamped at
    // spec-draft), then approve. Continuation fails (no files section, no
    // metadata), leaving the DURABLE post-approval gate: spec-approved.
    driveFeatureTo(ws, 'spec-draft', { spec: SPEC_V1, specMetadata: false });
    writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), SPEC_V2, 'utf8');
    replaySession([specToolReturn(SESSION_A)], ws.hostCwd);
    promptTurn(ws, SESSION_A, 'approve spec');

    const state = readState(ws.root);
    taskId = state.taskId;
    assert.equal(state.workflowGate, 'spec-approved', 'precondition: durable post-approval gate');
    approvedDigest = state.artifactHashes.specDigest;
    assert.ok(approvedDigest, 'precondition: an approved spec digest is recorded');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('rolls back to spec-draft, refreshes the digest, and warns — the restore cannot keep spec-approved', () => {
    // The checkpoint restore: VS Code reverts the file with NO hook firing.
    writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), SPEC_V1, 'utf8');

    // The NEXT PostToolUse that touches the spec path is where detection must
    // happen — the guard re-hashes and sees a digest that is not the one the
    // human approved.
    const outputs = replaySession([specToolReturn(SESSION_A)], ws.hostCwd);

    const state = readState(ws.root);
    assert.equal(state.workflowGate, 'spec-draft', 'the reverted spec silently kept spec-approved');
    assert.notEqual(state.artifactHashes.specDigest, approvedDigest, 'the recorded digest was not refreshed');

    const events = parseWholeTrace(ws, taskId);
    const invalidated = events.find((e) => e.type === 'spec_invalidated');
    assert.ok(invalidated, 'no spec_invalidated trace event was written');
    const rollback = events.find(
      (e) => e.type === 'gate_transition' && e.from === 'spec-approved' && e.to === 'spec-draft',
    );
    assert.ok(rollback, 'no gate_transition records the rollback');

    const stdout = outputs.map((o) => o.stdout).join('\n');
    assert.ok(
      stdout.includes('rolled back') || stdout.includes('spec.md changed after approval'),
      `the user-facing rollback warning is missing:\n${stdout}`,
    );
  });

  it('re-approval of the restored spec resumes the workflow — the rollback is recoverable', () => {
    promptTurn(ws, SESSION_A, 'approve spec');
    assert.equal(readState(ws.root).workflowGate, 'spec-approved', 're-approval did not advance');
  });
});

// ---------------------------------------------------------------------------
// 4. Checkpoint restore of task.json
// ---------------------------------------------------------------------------

describe('E2E restore — a reverted task.json is detected as desynced against the trace, not trusted', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {string} */
  let preApprovalSnapshot;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'spec-draft');
    taskId = readState(ws.root).taskId;
    // The checkpoint: task.json as it stood BEFORE the approval.
    preApprovalSnapshot = readFileSync(stateArtifact(ws, 'task.json'), 'utf8');

    replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_A, prompt: 'approve spec' }],
      ws.hostCwd,
    );
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: approval landed');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('the next prompt surfaces a desync verdict instead of trusting the reverted gate', () => {
    // The restore: task.json reverts to its pre-approval snapshot while the
    // trace retains the audited approval — same detector as hand-tampering,
    // different cause (the host did it, not the user).
    writeFileSync(stateArtifact(ws, 'task.json'), preApprovalSnapshot, 'utf8');
    assert.equal(readState(ws.root).workflowGate, 'spec-draft', 'precondition: the revert applied');

    const outputs = promptTurn(ws, SESSION_A, 'status?');
    const stdout = outputs.map((o) => o.stdout).join('\n');

    assert.ok(
      stdout.includes('desynced'),
      `the anchor does not flag the reverted state as desynced:\n${stdout}`,
    );
    assert.ok(
      stdout.includes('backward'),
      `the desync does not name the backward divergence (gate behind the trace):\n${stdout}`,
    );

    // Detection is non-destructive: the gate is flagged, never silently
    // rewritten — reconciliation is the doctor's opt-in --fix.
    assert.equal(readState(ws.root).workflowGate, 'spec-draft');

    // The trace still carries the approval the reverted state contradicts.
    const approvals = parseWholeTrace(ws, taskId).filter(
      (e) => e.type === 'gate_transition' && e.to === 'spec-approved',
    );
    assert.equal(approvals.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Compaction round-trip
// ---------------------------------------------------------------------------

/**
 * The three gates the round trip is proven at. `impl-started` is the READY
 * case: a real mid-implementation task carries a refined OutputContract
 * (`done_when`) and evidence-pack pointers, which is exactly what makes a
 * compaction artifact self-sufficient (`canResumeFromCompaction`). The two
 * bare pre-implementation gates document the degraded path: the artifact is
 * written but INCOMPLETE, and resume still works off the durable state.
 */
/**
 * Register the compaction round-trip suite for one gate. A named function
 * rather than a loop over cases, so the per-case workspace allocations are
 * not "resource allocation inside a loop" to the security lint.
 * @param {{ gate: 'grill-done'|'spec-draft'|'impl-started', ready: boolean }} tc
 */
function defineCompactionSuite(tc) {
  describe(`E2E compaction — PreCompact at ${tc.gate}, then a fresh session resumes`, () => {
    /** @type {ReturnType<typeof seedMonorootWorkspace>} */
    let ws;
    /** @type {string} */
    let taskId;

    before(() => {
      ws = seedMonorootWorkspace();
      driveFeatureTo(ws, tc.gate);
      const state = readState(ws.root);
      taskId = state.taskId;
      assert.equal(state.workflowGate, tc.gate, `precondition: reached ${tc.gate}`);

      if (tc.gate === 'impl-started') {
        // AC1 lands via the real script so the round trip has progress to lose.
        const acRun = spawnHook('scripts/complete-ac.mjs', ['--ac', '1', '--repo-root', ws.root], {}, ws.root);
        assert.equal(acRun.status, 0, `complete-ac.mjs failed:\n${acRun.stdout}${acRun.stderr}`);

        // The fields a REAL mid-implementation task carries and the artifact
        // builder reads: the orchestrator-refined contract goal and the
        // context layer's evidence pack (no hook in this scripted session
        // produces them, so they are seeded as the emulation the header
        // documents).
        const withContext = readState(ws.root);
        writeFileSync(
          stateArtifact(ws, 'task.json'),
          JSON.stringify({
            ...withContext,
            outputContract: {
              ...(withContext.outputContract ?? {}),
              done_when: 'A body over the configured cap is rejected with a 413.',
            },
            evidencePack: {
              maxSources: 5,
              pointers: [{ path: EDIT_PATH, lineRange: '1-20', reason: 'request handler under change' }],
            },
          }),
          'utf8',
        );
      }
    });

    after(() => {
      if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
    });

    it('PreCompact writes the artifact without disturbing the gate', () => {
      const outputs = replaySession(
        [{ hook_event_name: 'PreCompact', session_id: SESSION_A }],
        ws.hostCwd,
      );
      for (const o of outputs) {
        assert.equal(o.status, 0, `PreCompact hook failed:\n${o.stdout}${o.stderr}`);
      }

      const dir = stateArtifact(ws, 'compaction');
      // Deterministic pick: artifact filenames embed a millisecond stamp, so
      // the lexically-last name is the newest — readdirSync order is
      // filesystem order and would bind to a stale artifact if this dir ever
      // held more than one (e.g. a budget-triggered auto-compaction).
      const jsonFiles = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      assert.ok(jsonFiles.length > 0, 'no compaction artifact was written');
      const artifact = JSON.parse(readFileSync(join(dir, jsonFiles[jsonFiles.length - 1]), 'utf8'));
      assert.equal(artifact.taskId, taskId, 'the artifact belongs to a different task');

      if (tc.gate === 'impl-started') {
        // #22: the artifact must read the CANONICAL per-task trace — with AC1
        // completed, nextAction derives from that step, never the generic
        // "check nextAction field" fallback that pointed at itself.
        assert.ok(
          artifact.nextAction.startsWith('Continue after completed step:'),
          `nextAction is not trace-derived: ${artifact.nextAction}`,
        );
      }

      assert.equal(readState(ws.root).workflowGate, tc.gate, 'compaction moved the gate');
    });

    it(`a fresh session reproduces the state with no trace replay (artifact: ${tc.ready ? 'READY' : 'INCOMPLETE'})`, () => {
      startSession(ws.hostCwd, SESSION_NEXT);

      const state = readState(ws.root);
      assert.equal(state.taskId, taskId, 'the fresh session replaced the compacted task');
      assert.equal(state.workflowGate, tc.gate, 'the fresh session lost the gate');

      const plan = JSON.parse(readFileSync(stateArtifact(ws, 'resume-plan.json'), 'utf8'));
      assert.equal(plan.taskId, taskId);
      assert.equal(
        plan.compactionAvailable,
        tc.ready,
        tc.ready
          ? 'a self-sufficient compaction brief was not surfaced to the resuming session'
          : 'an INCOMPLETE artifact was wrongly advertised as a resume brief',
      );

      if (tc.gate === 'impl-started') {
        // AC progress survives the round trip, and the completed criterion is
        // never re-dispatched (docs/resume.md: no-repeat-work).
        assert.equal(plan.implProgress.done, 1);
        assert.equal(plan.implProgress.total, 2);
        assert.equal(plan.implProgress.nextId, 2, 'the resume plan re-dispatches the completed AC');
        assert.notEqual(plan.nextStepId, 'impl-AC1', 'the completed AC1 step was re-emitted as next');
        assert.ok(
          plan.message.includes('compaction resume-brief is available'),
          `the resume message does not point at the richer brief: ${plan.message}`,
        );
      }
    });
  });
}

defineCompactionSuite({ gate: 'grill-done', ready: false });
defineCompactionSuite({ gate: 'spec-draft', ready: false });
defineCompactionSuite({ gate: 'impl-started', ready: true });

// ---------------------------------------------------------------------------
// 6. Hard interrupt: SubagentStart with no SubagentStop
// ---------------------------------------------------------------------------

describe('E2E hard interrupt — a dispatch killed before SubagentStop is reconciled by the next session', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = seedMonorootWorkspace();
    driveFeatureTo(ws, 'impl-started');
    taskId = readState(ws.root).taskId;
    assert.equal(readState(ws.root).workflowGate, 'impl-started', 'precondition: reached impl-started');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('the interrupted dispatch leaks the counter — then SessionStart reconciles it, traced', () => {
    // The real dispatch increments the counter and the roster …
    const start = subagentEvent(ws, 'start', SESSION_A, 'toolu_killed', 'fullstack');
    assert.equal(start.status, 0, `the dispatch was denied:\n${start.stdout}${start.stderr}`);
    assert.equal(readState(ws.root).activeSubagents, 1);
    assert.equal((readState(ws.root).activeAgents ?? []).length, 1);

    // … and the host dies here: no SubagentStop ever fires. The next session
    // is the recovery point (sub-agents never outlive their host session).
    startSession(ws.hostCwd, SESSION_NEXT);

    const state = readState(ws.root);
    assert.equal(state.taskId, taskId, 'reconciliation replaced the in-flight task');
    assert.equal(state.activeSubagents, 0, 'the leaked counter was not reconciled');
    assert.deepEqual(state.activeAgents ?? [], [], 'the dead agent still holds a roster identity');

    const reconciled = parseWholeTrace(ws, taskId).find((e) => e.type === 'subagent_reconciled');
    assert.ok(reconciled, 'no subagent_reconciled trace event was written');
    assert.equal(reconciled.previous, 1, 'the reconcile event does not record the leaked value');
  });

  it('a fresh dispatch after reconciliation is allowed — the task can never deadlock on a ghost', () => {
    const start = subagentEvent(ws, 'start', SESSION_NEXT, 'toolu_fresh', 'fullstack');
    assert.equal(start.status, 0, `the post-reconcile dispatch was denied:\n${start.stdout}${start.stderr}`);
    assert.equal(readState(ws.root).activeSubagents, 1);
    // Leave the workspace clean for the after() teardown semantics.
    subagentEvent(ws, 'stop', SESSION_NEXT, 'toolu_fresh', 'fullstack');
  });
});
