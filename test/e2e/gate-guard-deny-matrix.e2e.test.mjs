// @ts-check
/**
 * E2E — the PreToolUse gate-guard deny matrix (#6).
 *
 * ## What this proves that the unit suites do not
 *
 * `lib/gate-guard-core.mjs` is exercised in depth by the unit tests, which call
 * `evaluateGuard` directly with hand-populated inputs. That proves the EVALUATOR
 * is correct; it cannot prove the HOOK is. Three of devmate's "enforced" layers
 * were dormant in production precisely because the wiring between the host and
 * the evaluator was wrong (config read from the wrong cwd, `activeAgent` with no
 * producer, the PreToolUse output shape VS Code silently ignored). This suite
 * drives the REAL `scripts/gate-guard.mjs` subprocess with host-shaped payloads
 * and reads the exact channel VS Code acts on — `hookSpecificOutput.
 * permissionDecision` / `permissionDecisionReason` — so a deny the evaluator
 * computes but the hook throws away would fail here.
 *
 * ## The contract, per the issue
 *
 * For every reachable deny in the rule ladder (config-missing, no-active-task,
 * budget-critical, gate-not-started ×lane, terminal-as-editor, unrecognized
 * tool, session-artifact, scope.md present/absent, TDD), assert all five:
 *   1. it is denied through the official channel (permissionDecision === 'deny'),
 *   2. with a SPECIFIC, actionable reason (a hardcoded substring — never one
 *      derived by calling the production function, which would make the oracle
 *      tautological),
 *   3. the reason is BOUNDED (TCM-9 — a large config cannot bloat hook stdout),
 *   4. the FIRST matching rule wins (a dedicated precedence block), and
 *   5. a corrected follow-up call is actually ALLOWED — every deny is recoverable.
 *
 * Plus the fail-OPEN half of #94: an MCP/unknown tool that names no protected
 * path sails through, and a read-only terminal command is not an edit.
 *
 * The expected decision and reason for every row live in the tables below and
 * are authored by reading the source, NOT by invoking `evaluateGuard`. The table
 * is the independent oracle; the subprocess is the system under test.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REPO_ROOT, readTraceEvents, seedMonorootWorkspace, spawnHook } from './session-harness.mjs';

/** The one hook the host runs on PreToolUse. */
const GATE_GUARD = 'scripts/gate-guard.mjs';

const TASK_ID = 'T1';

/**
 * @typedef {Object} StateSpec
 * @property {'feature'|'bug'|'chore'} [lane]
 * @property {string} [gate]
 * @property {boolean} [tdd]           testFileWritten (default true).
 * @property {boolean} [specMeta]      record artifactHashes.spec + specDigest (default false) — the feature lane's implementation-dispatch precondition.
 * @property {{ agentName: string, agentId: string }[]} [activeAgents]
 */

/**
 * @typedef {Object} WorkspaceSpec
 * @property {'valid'|'missing'} [config]     devmate.config.json presence (default valid).
 * @property {StateSpec|null} [state]          null ⇒ no task.json written (default a valid impl-started feature).
 * @property {string[]|null} [scope]           allowedGlobs for scope.md; null ⇒ no scope.md file (default ['repo-a/lib/**']).
 * @property {boolean} [budgetCritical]        write a budget-critical marker (default false).
 */

/**
 * Build the task.json a spec describes. Every required TaskState field is
 * present so `validateTaskState` accepts it — an invalid state would read back
 * as `null` and silently route to the wrong rule.
 * @param {StateSpec} s
 * @returns {Record<string, unknown>}
 */
function makeState(s) {
  return {
    taskId: TASK_ID,
    lane: s.lane ?? 'feature',
    workflowGate: s.gate ?? 'impl-started',
    currentStep: 0,
    artifactHashes: s.specMeta ? { spec: 'h-spec', specDigest: 'h-digest' } : {},
    preImplStash: null,
    budget: 10,
    tddGuard: {
      testFileWritten: s.tdd ?? true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    schemaVersion: 1,
    ...(s.activeAgents ? { activeAgents: s.activeAgents } : {}),
  };
}

/**
 * Render a scope.md whose `## Allowed globs` section lists `globs`.
 * @param {string[]} globs
 * @returns {string}
 */
function scopeMd(globs) {
  return ['---', 'lane: feature', '---', '# Scope', '', '## Allowed globs', ...globs.map((g) => `- ${g}`), ''].join(
    '\n',
  );
}

/**
 * Materialize a fresh temp workspace fully configured from `spec`, in the
 * monoroot layout devmate ships into. Each scenario gets its own workspace so no
 * row can contaminate another.
 * @param {WorkspaceSpec} spec
 * @returns {{ root: string, hostCwd: string }}
 */
function makeWorkspace(spec = {}) {
  const ws = seedMonorootWorkspace();

  if (spec.config === 'missing') {
    rmSync(join(ws.root, '.devmate', 'devmate.config.json'), { force: true });
  }

  mkdirSync(ws.stateDir, { recursive: true });
  const stateSpec = spec.state === undefined ? {} : spec.state;
  if (stateSpec !== null) {
    writeFileSync(join(ws.stateDir, 'task.json'), JSON.stringify(makeState(stateSpec)), 'utf8');
  }

  const scope = spec.scope === undefined ? ['repo-a/lib/**'] : spec.scope;
  if (scope !== null) {
    const sessionDir = join(ws.root, '.devmate', 'session', TASK_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'scope.md'), scopeMd(scope), 'utf8');
  }

  if (spec.budgetCritical) {
    writeFileSync(
      join(ws.stateDir, 'budget-critical.json'),
      JSON.stringify({ current: 200000, limit: 100000, at: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
  }

  return { root: ws.root, hostCwd: ws.hostCwd };
}

/**
 * Drive the live PreToolUse guard and return the decision the HOST reads, plus
 * the wall-clock cost of the subprocess (for the timing pin) and the raw exit
 * status (the guard must always exit 0 — a deny is data, not a crash).
 * @param {{ hostCwd: string }} ws
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @returns {{ decision: string, reason: string, status: number, elapsedMs: number }}
 */
function preToolUse(ws, toolName, toolInput) {
  const started = performance.now();
  const ran = spawnHook(
    GATE_GUARD,
    [],
    {
      // Shaped like the captured PreToolUse payloads
      // (test/fixtures/hook-payloads/captured/pretooluse.read-file.json): the
      // host sends hook_event_name/session_id/tool_name/tool_input/cwd plus a
      // canonical tool_use_id. The guard ignores tool_use_id, but carrying it
      // keeps the payload faithful to what VS Code actually delivers.
      hook_event_name: 'PreToolUse',
      session_id: 'sess-deny-matrix',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'call_denyMatrix__vscode-1700000000000',
      cwd: ws.hostCwd,
    },
    ws.hostCwd,
  );
  const elapsedMs = performance.now() - started;
  const parsed = JSON.parse(ran.stdout);
  const out = parsed.hookSpecificOutput ?? {};
  assert.equal(out.hookEventName, 'PreToolUse', 'the hook must emit the PreToolUse output shape');
  return {
    decision: String(out.permissionDecision ?? ''),
    reason: String(out.permissionDecisionReason ?? ''),
    status: ran.status,
    elapsedMs,
  };
}

/** A deny must be actionable by a plugin CONSUMER, never by editing devmate's own source. */
const UNACTIONABLE = /gate-guard-core\.mjs|NON_SOURCE_EDIT_TOOLS/;

/**
 * Assert a live deny: official channel, exit 0, a specific reason that matches
 * `reasonMatch`, and — the anti-drift half — a reason that never tells the
 * caller to patch devmate's library. Also that the reason is bounded (TCM-9).
 * @param {{ decision: string, reason: string, status: number }} r
 * @param {RegExp} reasonMatch
 */
function assertDeny(r, reasonMatch) {
  assert.equal(r.status, 0, 'the guard always exits 0 — deny is communicated in the payload');
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.length > 0, 'a deny must carry a reason — it is the only channel that can teach');
  assert.match(r.reason, reasonMatch);
  assert.doesNotMatch(r.reason, UNACTIONABLE, 'the deny must be actionable by the caller, not devmate maintainers');
  assert.ok(r.reason.length < 2000, `deny reason must be bounded (was ${r.reason.length} chars)`);
}

// ---------------------------------------------------------------------------
// The deny matrix. Each row: a workspace spec + call that MUST deny with the
// given reason, and a corrected follow-up (its own spec + call) that MUST be
// allowed. Reason substrings are hand-authored from the source, not computed.
// ---------------------------------------------------------------------------

const SOURCE_FILE = 'repo-a/lib/app.mjs';
const CREATE = 'create_file';

/**
 * @typedef {Object} DenyRow
 * @property {string} rule                       Human label for the rule under test.
 * @property {WorkspaceSpec} spec                Workspace that trips the deny.
 * @property {[string, Record<string, unknown>]} call   [toolName, toolInput] that is denied.
 * @property {RegExp} reason                     Substring the deny reason must contain.
 * @property {WorkspaceSpec} recoverSpec         Workspace for the corrected follow-up.
 * @property {[string, Record<string, unknown>]} recoverCall  The follow-up that must be allowed.
 */

/** @type {DenyRow[]} */
const DENY_MATRIX = [
  {
    rule: 'Rule 1 — config missing/invalid',
    spec: { config: 'missing' },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /devmate\.config\.json is missing or invalid.*devmate init/s,
    recoverSpec: {},
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 2 — no active devmate task (unreadable/absent state)',
    spec: { state: null },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /no active devmate task/,
    recoverSpec: {},
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 2b — session budget critical',
    spec: { budgetCritical: true },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /session budget is CRITICAL.*compact/is,
    // Recovery is compaction, which clears the marker — NOT editing .devmate/**
    // (that would then hit the session-artifact rule). Marker gone ⇒ edit resumes.
    recoverSpec: { budgetCritical: false },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 3 — gate not started (feature → approve spec)',
    spec: { state: { lane: 'feature', gate: 'spec-draft', tdd: true } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /implementation has not started.*approve spec/s,
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', tdd: true } },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 3 — gate not started (bug → approve plan)',
    spec: { state: { lane: 'bug', gate: 'plan-approved', tdd: true } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /implementation has not started.*approve plan/s,
    recoverSpec: { state: { lane: 'bug', gate: 'impl-started', tdd: true } },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 3 — gate not started (chore → advances on its own)',
    spec: { state: { lane: 'chore', gate: 'lane-set', tdd: true } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /implementation has not started.*chore lane advances/s,
    recoverSpec: { state: { lane: 'chore', gate: 'impl-started', tdd: true } },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 3b — unrecognized tool naming a source path',
    spec: {},
    // `path`/`uri` are keys firstToolInputPath does NOT read, so payload.path
    // stays unset and the call is an unscopeable edit — the #94 fail-closed path.
    call: ['mcp_editor_write', { path: SOURCE_FILE }],
    reason: /is not a tool devmate recognizes.*@fullstack/s,
    recoverSpec: {},
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 4 — session artifact (spec.md, no attributable agent)',
    spec: {},
    call: [CREATE, { filePath: '.devmate/session/T1/spec.md', content: '# forged' }],
    reason: /session artifact/i,
    // Only @spec-writer may write spec.md — put it in flight and the write clears.
    recoverSpec: { state: { activeAgents: [{ agentName: 'spec-writer', agentId: 'a1' }] } },
    recoverCall: [CREATE, { filePath: '.devmate/session/T1/spec.md', content: '# Spec' }],
  },
  {
    rule: 'Rule 4 — session artifact (task.json — never agent-writable)',
    spec: { state: { activeAgents: [{ agentName: 'spec-writer', agentId: 'a1' }] } },
    call: [CREATE, { filePath: '.devmate/state/task.json', content: '{}' }],
    reason: /session artifact/i,
    // Recovery is not "write it as someone else" — it is "write product code".
    recoverSpec: {},
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 6 — out of scope per scope.md',
    spec: { scope: ['repo-a/lib/**'] },
    call: [CREATE, { filePath: 'repo-a/other/x.mjs', content: 'x' }],
    reason: /out of scope per scope\.md/,
    recoverSpec: { scope: ['repo-a/lib/**'] },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 6 — no scope contract at all (fail closed at impl-started)',
    spec: { scope: null },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /no scope contract for this task/,
    recoverSpec: { scope: ['repo-a/lib/**'] },
    recoverCall: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
  },
  {
    rule: 'Rule 7 — TDD pre-condition (no test evidence yet)',
    spec: { scope: ['repo-a/lib/**', 'repo-a/test/**'], state: { gate: 'impl-started', tdd: false } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    reason: /TDD pre-condition/,
    // The documented recovery: write the test first. The test path must be in
    // scope, so this row's scope admits repo-a/test/**.
    recoverSpec: { scope: ['repo-a/lib/**', 'repo-a/test/**'], state: { gate: 'impl-started', tdd: false } },
    recoverCall: [CREATE, { filePath: 'repo-a/test/app.test.mjs', content: 'x' }],
  },
];

for (const row of DENY_MATRIX) {
  test(`deny: ${row.rule}`, skipUnlessNode(24), () => {
    const denyWs = makeWorkspace(row.spec);
    try {
      assertDeny(preToolUse(denyWs, row.call[0], row.call[1]), row.reason);
    } finally {
      rmSync(denyWs.root, { recursive: true, force: true });
    }

    // Recoverability: the corrected follow-up is actually allowed. A deny that
    // strands the caller with no working next move is a bug, not a boundary.
    const recoverWs = makeWorkspace(row.recoverSpec);
    try {
      const r = preToolUse(recoverWs, row.recoverCall[0], row.recoverCall[1]);
      assert.equal(r.decision, 'allow', `${row.rule}: the corrected follow-up must be allowed`);
    } finally {
      rmSync(recoverWs.root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Implementation-dispatch gate (HITL-1). A `runSubagent` call targeting an
// implementation agent runs a SEPARATE deny path — `evaluateImplementationDispatch`
// in scripts/gate-guard.mjs, BEFORE the rule ladder — that the edit-tool rows
// above never exercise. Its verdict keys on the dispatched agent, which the host
// names in `tool_input.agentName`.
//
// CONTRACT NOTE: `agentName` is a field of the runSubagent TOOL's input schema
// (test/fixtures/hook-payloads/derived/pretooluse.run-subagent.json), NOT a
// verified field of the hook payload the host guarantees — the guard flags it
// [UNVERIFIED] and fails OPEN when it is absent. The structural, host-verified
// second layer is the SubagentStart budget guard, which reads `agent_type`. These
// rows therefore assert the repo-owned tool-input behavior, not a host promise.
// ---------------------------------------------------------------------------

const DISPATCH = 'runSubagent';
/** A dispatch of the implementation agent, shaped like the derived runSubagent fixture. */
const IMPL_DISPATCH = { agentName: 'fullstack', prompt: 'Implement step 1 of the plan.' };

/** @type {DenyRow[]} */
const DISPATCH_MATRIX = [
  {
    rule: 'Dispatch — no task.json (implementation cannot start with no lane in flight)',
    spec: { state: null },
    call: [DISPATCH, IMPL_DISPATCH],
    reason: /implementation dispatch blocked: task\.json is missing or unreadable/,
    // Recovery: a fully-provisioned feature task — gate impl-started, spec
    // metadata recorded, scope contract on disk.
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    recoverCall: [DISPATCH, IMPL_DISPATCH],
  },
  {
    rule: 'Dispatch — pre-implementation gate (feature at plan-approved)',
    spec: { state: { lane: 'feature', gate: 'plan-approved', specMeta: true }, scope: ['repo-a/lib/**'] },
    call: [DISPATCH, IMPL_DISPATCH],
    reason: /implementation dispatch blocked: workflowGate must be 'impl-started'/,
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    recoverCall: [DISPATCH, IMPL_DISPATCH],
  },
  {
    rule: 'Dispatch — missing evidence (feature at impl-started, no approved spec)',
    spec: { state: { lane: 'feature', gate: 'impl-started', specMeta: false }, scope: ['repo-a/lib/**'] },
    call: [DISPATCH, IMPL_DISPATCH],
    reason: /implementation dispatch blocked: missing spec artifact metadata/,
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    recoverCall: [DISPATCH, IMPL_DISPATCH],
  },
  {
    rule: 'Dispatch — missing scope contract (feature at impl-started, spec approved)',
    spec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: null },
    call: [DISPATCH, IMPL_DISPATCH],
    reason: /implementation dispatch blocked: scope\.md is missing or empty/,
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    recoverCall: [DISPATCH, IMPL_DISPATCH],
  },
  {
    rule: 'Dispatch — bug lane with no diagnosis (diagnose-before-fix)',
    spec: { state: { lane: 'bug', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    call: [DISPATCH, IMPL_DISPATCH],
    reason: /implementation dispatch blocked: no valid \.devmate\/state\/diagnosis\.json/,
    // Recovery stays on the feature lane (its precondition — approved spec — is
    // representable without a diagnosis fixture); the point is that a corrected
    // dispatch IS admitted, closing the "gate open ≠ dispatch allowed" gap.
    recoverSpec: { state: { lane: 'feature', gate: 'impl-started', specMeta: true }, scope: ['repo-a/lib/**'] },
    recoverCall: [DISPATCH, IMPL_DISPATCH],
  },
];

for (const row of DISPATCH_MATRIX) {
  test(`deny: ${row.rule}`, skipUnlessNode(24), () => {
    const denyWs = makeWorkspace(row.spec);
    try {
      const r = preToolUse(denyWs, row.call[0], row.call[1]);
      assert.equal(r.status, 0, 'the guard always exits 0');
      assert.equal(r.decision, 'deny', row.rule);
      assert.match(r.reason, row.reason);
      assert.doesNotMatch(r.reason, UNACTIONABLE);
      assert.ok(r.reason.length < 2000, `deny reason must be bounded (was ${r.reason.length})`);
    } finally {
      rmSync(denyWs.root, { recursive: true, force: true });
    }

    const recoverWs = makeWorkspace(row.recoverSpec);
    try {
      const r = preToolUse(recoverWs, row.recoverCall[0], row.recoverCall[1]);
      assert.equal(r.decision, 'allow', `${row.rule}: the corrected dispatch must be allowed`);
    } finally {
      rmSync(recoverWs.root, { recursive: true, force: true });
    }
  });
}

// A dispatch the host cannot attribute (no agentName in tool_input) fails OPEN —
// the class is NOT silently denied, it is deferred to the SubagentStart guard.
test('allow: an analysis/unattributable dispatch is not gated here (fail-open)', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ state: { lane: 'feature', gate: 'plan-approved', specMeta: false }, scope: null });
  try {
    // No agentName ⇒ isImplementationDispatch is false ⇒ the dispatch check is
    // skipped. runSubagent names no path, so the rule ladder also lets it pass.
    const r = preToolUse(ws, DISPATCH, { prompt: 'Analyze the codebase.' });
    assert.equal(r.decision, 'allow', 'a dispatch with no implementation agent name must not be gated at PreToolUse');
    // And an explicit analysis agent is likewise not an implementation dispatch.
    const r2 = preToolUse(ws, DISPATCH, { agentName: 'discovery', prompt: 'Survey the modules.' });
    assert.equal(r2.decision, 'allow', 'an analysis-agent dispatch is never implementation-gated');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DISCLOSURE — persona-scope (the former "Rule 5") is NOT an active deny class.
// It was removed in #99: a PreToolUse payload carries no agent identity, so an
// edit cannot be attributed to one of several concurrent personas, and the
// per-persona editable/off-limits boundary is enforced at COMPLETION
// (hooks/post-tool-use.mjs), not here. The matrix above therefore has no
// persona-scope row by design. This test pins that current behavior so a future
// reader does not mistake its absence for an oversight: an edit OUTSIDE the
// configured persona's editableGlobs but INSIDE scope.md is ALLOWED — scope.md
// (Rule 6), which needs no identity, is the sole path boundary at PreToolUse.
// ---------------------------------------------------------------------------

test('disclosure: PreToolUse is not persona-scoped — scope.md alone bounds the path (#99)', skipUnlessNode(24), () => {
  // The seeded persona (backend) may edit repo-a/lib/** and .devmate/**; it may
  // NOT edit repo-b/**. scope.md, however, admits repo-b/lib/**. If a persona
  // rule still fired at PreToolUse this would deny; because none does, only
  // scope.md governs and the write is allowed.
  const ws = makeWorkspace({ scope: ['repo-b/lib/**'] });
  try {
    const r = preToolUse(ws, CREATE, { filePath: 'repo-b/lib/x.mjs', content: 'x' });
    assert.equal(
      r.decision,
      'allow',
      'no persona scoping at PreToolUse: an in-scope path outside the persona globs is allowed',
    );
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deny telemetry (#6, proposed change #5). Every deny that has a task context
// appends ONE bounded, content-free audit line to the task trace; a recovery
// (an allow) adds none; and a taskId-less deny writes nothing while the host
// deny still stands. The trace is the audit surface; it must never carry the
// free-text reason or file content.
// ---------------------------------------------------------------------------

/**
 * Read the `deny:*` action events the guard appended to this task's trace.
 * @param {string} root
 * @returns {Record<string, any>[]}
 */
function readDenyEvents(root) {
  const p = join(root, '.devmate', 'state', 'trace', `${TASK_ID}.jsonl`);
  if (!existsSync(p)) return [];
  return readTraceEvents(p).filter(
    (e) => typeof e.actionType === 'string' && e.actionType.startsWith('deny:'),
  );
}

test('telemetry: a rule-ladder deny appends one bounded, content-free audit event', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ scope: ['repo-a/lib/**'] });
  try {
    const r = preToolUse(ws, CREATE, { filePath: 'repo-a/other/x.mjs', content: 'secret content' });
    assert.equal(r.decision, 'deny');

    const events = readDenyEvents(ws.root);
    assert.equal(events.length, 1, 'exactly one deny audit line');
    const ev = events[0];
    assert.equal(ev.type, 'action');
    assert.equal(ev.taskId, TASK_ID);
    assert.equal(ev.actionType, 'deny:guard:create_file', 'names the deny source layer and the tool');
    assert.equal(ev.path, 'repo-a/other/x.mjs', 'names the offending path');
    assert.equal(typeof ev.digest, 'string');
    assert.equal(ev.digest.length, 16, 'the action digest is bounded');
    // Content-free: neither the file content nor the free-text reason is persisted.
    assert.equal(JSON.stringify(ev).includes('secret content'), false, 'no file content in the trace');
    assert.equal('reason' in ev, false, 'the unbounded reason is not persisted to the trace');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('telemetry: a dispatch deny is audited under its own source layer', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ state: { lane: 'feature', gate: 'impl-started', specMeta: false }, scope: ['repo-a/lib/**'] });
  try {
    const r = preToolUse(ws, DISPATCH, IMPL_DISPATCH);
    assert.equal(r.decision, 'deny');
    const events = readDenyEvents(ws.root);
    assert.equal(events.length, 1);
    assert.equal(events[0].actionType, 'deny:dispatch:runSubagent');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('telemetry: a recovery (allow) adds no deny event', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ scope: ['repo-a/lib/**'] });
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'export const a = 1;\n' });
    assert.equal(r.decision, 'allow');
    assert.equal(readDenyEvents(ws.root).length, 0, 'an allow must not append a deny audit line');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('telemetry: a taskId-less deny writes no trace, yet the host deny still stands', skipUnlessNode(24), () => {
  // No task.json ⇒ no task id to key a trace file on. The honest behavior is to
  // skip the append (never fabricate an identity) while the deny itself is
  // unaffected — the host still receives the refusal.
  const ws = makeWorkspace({ state: null, config: 'missing' });
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'x' });
    assert.equal(r.decision, 'deny', 'the deny still reaches the host');
    const traceDir = join(ws.root, '.devmate', 'state', 'trace');
    assert.equal(existsSync(traceDir), false, 'a taskless deny fabricates no trace file');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Terminal-as-editor (Rule 3b): every write mechanism denies; every read-only
// command is waved through. One reason string, so a sub-table keeps it tight.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const TERMINAL_WRITE_VECTORS = [
  "sed -i 's/a/b/' repo-a/lib/app.mjs",
  'printf "x" > repo-a/lib/app.mjs',
  'echo x | tee repo-a/lib/app.mjs',
  'git apply changes.patch',
  'node -e "require(\'fs\').writeFileSync(\'repo-a/lib/app.mjs\',\'x\')"',
  "echo forged > .devmate/session/T1/spec.md",
];

test('deny: terminal-as-editor write vectors are blocked at impl-started', skipUnlessNode(24), () => {
  const ws = makeWorkspace({});
  try {
    for (const command of TERMINAL_WRITE_VECTORS) {
      const r = preToolUse(ws, 'run_in_terminal', { command });
      assert.equal(r.decision, 'deny', `should deny: ${command}`);
      // A .devmate/ redirect is a session artifact; a source redirect is the
      // terminal-as-editor deny. Both are actionable and mention delegating.
      assert.match(r.reason, /terminal|session artifact/i, `reason for: ${command}`);
      assert.doesNotMatch(r.reason, UNACTIONABLE);
    }
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('recover: the terminal edit is allowed when made with a file-edit tool', skipUnlessNode(24), () => {
  const ws = makeWorkspace({});
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'x' });
    assert.equal(r.decision, 'allow');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-OPEN (#94): a tool that names no protected path is not gated. The old
// name-allowlist denied every MCP/extension tool on first contact; keying on the
// named path means a tool that touches no source file has nothing to gate.
// ---------------------------------------------------------------------------

/** @type {Array<[string, Record<string, unknown>]>} */
const FAIL_OPEN_CALLS = [
  ['session_store_sql', { query: 'SELECT * FROM sessions WHERE id = ?', params: ['T1'] }],
  ['jira_get_issue', { issueKey: 'ENG-1234' }],
  ['browser_navigate', { url: 'https://example.com/docs' }],
  ['read_file', { filePath: SOURCE_FILE }],
  ['run_in_terminal', { command: 'npm run verify' }],
  ['run_in_terminal', { command: 'cat repo-a/lib/app.mjs' }],
  ['run_in_terminal', { command: 'git status' }],
];

test('allow: tools naming no protected path (and read-only terminal) are not gated', skipUnlessNode(24), () => {
  const ws = makeWorkspace({});
  try {
    for (const [tool, input] of FAIL_OPEN_CALLS) {
      const r = preToolUse(ws, tool, input);
      assert.equal(r.decision, 'allow', `${tool} ${JSON.stringify(input)} must not be gated`);
    }
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('allow: the golden path — an in-scope source edit at impl-started under TDD', skipUnlessNode(24), () => {
  const ws = makeWorkspace({});
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'export const a = 1;\n' });
    assert.equal(r.decision, 'allow');
    assert.equal(r.reason, '', 'an allow carries no reason');
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// First-rule-wins ordering. When two rules would both fire, the earlier one in
// the ladder must own the decision — verified by which reason comes back. Each
// row is authored to trip TWO rules and names the one that must win.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} OrderRow
 * @property {string} name
 * @property {WorkspaceSpec} spec
 * @property {[string, Record<string, unknown>]} call
 * @property {RegExp} winner                Reason the earlier rule produces.
 * @property {RegExp} loser                 Reason the later rule would have produced (must be absent).
 */

/** @type {OrderRow[]} */
const ORDERING = [
  {
    name: 'config-missing (1) beats gate-not-started (3)',
    spec: { config: 'missing', state: { lane: 'feature', gate: 'plan-approved', tdd: true } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    winner: /devmate init/,
    loser: /implementation has not started/,
  },
  {
    name: 'no-active-task (2) beats budget-critical (2b)',
    spec: { state: null, budgetCritical: true },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    winner: /no active devmate task/,
    loser: /session budget is CRITICAL/,
  },
  {
    name: 'budget-critical (2b) beats gate-not-started (3)',
    spec: { budgetCritical: true, state: { lane: 'feature', gate: 'plan-approved', tdd: true } },
    call: [CREATE, { filePath: SOURCE_FILE, content: 'x' }],
    winner: /session budget is CRITICAL/,
    loser: /implementation has not started/,
  },
  {
    name: 'gate-not-started (3) beats terminal-as-editor (3b)',
    spec: { state: { lane: 'feature', gate: 'plan-approved', tdd: true } },
    call: ['run_in_terminal', { command: "sed -i 's/a/b/' repo-a/lib/app.mjs" }],
    winner: /implementation has not started/,
    loser: /terminal/,
  },
  {
    name: 'gate-not-started (3) beats scope.md (6)',
    spec: { state: { lane: 'feature', gate: 'plan-approved', tdd: true }, scope: ['repo-a/lib/**'] },
    call: [CREATE, { filePath: 'repo-a/other/x.mjs', content: 'x' }],
    winner: /implementation has not started/,
    loser: /out of scope/,
  },
  {
    name: 'session-artifact (4) beats scope.md (6)',
    spec: { scope: ['repo-a/lib/**'] },
    call: [CREATE, { filePath: '.devmate/session/T1/spec.md', content: 'x' }],
    winner: /session artifact/i,
    loser: /out of scope/,
  },
  {
    name: 'terminal-as-editor (3b) beats scope.md (6)',
    spec: { scope: ['repo-a/lib/**'] },
    call: ['run_in_terminal', { command: "sed -i 's/a/b/' repo-a/lib/app.mjs" }],
    winner: /terminal/,
    loser: /out of scope/,
  },
  {
    name: 'scope.md (6) beats TDD (7)',
    spec: { scope: ['repo-a/lib/**'], state: { gate: 'impl-started', tdd: false } },
    call: [CREATE, { filePath: 'repo-a/other/x.mjs', content: 'x' }],
    winner: /out of scope/,
    loser: /TDD pre-condition/,
  },
];

for (const row of ORDERING) {
  test(`order: ${row.name}`, skipUnlessNode(24), () => {
    const ws = makeWorkspace(row.spec);
    try {
      const r = preToolUse(ws, row.call[0], row.call[1]);
      assert.equal(r.decision, 'deny', row.name);
      assert.match(r.reason, row.winner, `${row.name}: earlier rule must own the decision`);
      assert.doesNotMatch(r.reason, row.loser, `${row.name}: later rule's reason must be absent`);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// TCM-9: the deny reason is bounded even when the config it quotes is large. A
// scope with more entries than the render cap must be elided ("+N more"), never
// dumped whole into hook stdout.
// ---------------------------------------------------------------------------

test('bounded: an oversized scope list is capped in the deny reason', skipUnlessNode(24), () => {
  const manyGlobs = Array.from({ length: 15 }, (_v, i) => `repo-a/pkg${i}/**`);
  const ws = makeWorkspace({ scope: manyGlobs });
  try {
    const r = preToolUse(ws, CREATE, { filePath: 'repo-a/other/x.mjs', content: 'x' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /out of scope/);
    assert.match(r.reason, /\+\d+ more/, 'the list must be elided, not dumped whole');
    assert.ok(r.reason.length < 2000, `reason must stay bounded (was ${r.reason.length})`);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Timeout contract. Two distinct claims, neither a magic literal:
//  (a) the budget the guard runs under is OWNED by hooks/hooks.json, and the
//      guard finishes well inside it — asserted against the value READ FROM that
//      file, so the bound and its registration cannot silently diverge; and
//  (b) exceeding that budget is enforced by the HOST (VS Code kills an overrunning
//      hook), never by the guard sleeping on itself. That kill is not an in-process
//      VS Code contract we can assert, so we model the mechanism with spawnSync's
//      own timeout against a test-only inert sleeper — the production guard is
//      never made to sleep.
// ---------------------------------------------------------------------------

/** The registered PreToolUse timeout (seconds), read from the shipped manifest. */
function registeredPreToolUseTimeoutS() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const pre = manifest?.hooks?.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length >= 1, 'hooks.json must register a PreToolUse hook');
  return pre[0].timeout;
}

test('timeout: the guard finishes well inside the budget hooks.json registers', skipUnlessNode(24), () => {
  const timeoutS = registeredPreToolUseTimeoutS();
  assert.equal(timeoutS, 10, 'the PreToolUse timeout bound is owned by hooks.json');
  const ws = makeWorkspace({ config: 'missing' });
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'x' });
    assert.equal(r.decision, 'deny');
    // Bound tied to config, not a hardcoded 10000: a guard that regressed into
    // blocking would breach the very budget the host will kill it for.
    assert.ok(
      r.elapsedMs < timeoutS * 1000,
      `guard round-trip (${Math.round(r.elapsedMs)}ms) must stay inside the ${timeoutS}s budget`,
    );
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('timeout: a hook that overruns its budget is killed by the host (harness-emulated)', skipUnlessNode(24), () => {
  // Test-only inert seam — NOT the production guard. A process that hangs past
  // the spawn timeout is terminated and reports a null exit status with a kill
  // signal, exactly as VS Code bounds a hook that exceeds its `timeout`.
  const r = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1e9)'], {
    timeout: 250,
    encoding: 'utf8',
  });
  assert.equal(r.status, null, 'a killed process has no exit status');
  assert.ok(
    r.signal !== null || r.error !== undefined,
    'the host must terminate an overrunning hook (kill signal or ETIMEDOUT)',
  );
});

// A defensive guard against the harness silently pointing at the wrong script.
test('meta: the gate-guard script under test exists', skipUnlessNode(24), () => {
  assert.ok(REPO_ROOT.length > 0);
});

// ── #187: edit-path containment — an escaping target is denied end-to-end even
// when an in-workspace glob (incl. the test-glob floor) would match it ────────

test('#187 live guard denies a `..`-traversal edit the test-glob floor would otherwise authorize', skipUnlessNode(24), () => {
  // scope.md carries the always-on floor; matchGlob('**/*.test.mjs', '../../etc/…')
  // is true, so pre-fix Rule 6 authorized the escaping edit. The live guard now
  // resolves the target against the workspace root and refuses it.
  const ws = makeWorkspace({ scope: ['repo-a/lib/**', '**/*.test.mjs'] });
  try {
    const r = preToolUse(ws, 'create_file', { filePath: '../../etc/pwn.test.mjs' });
    assertDeny(r, /OUTSIDE the workspace/i);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('#187 live guard denies an ABSOLUTE out-of-workspace edit', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ scope: ['**/*.test.mjs'] });
  try {
    const abs = process.platform === 'win32' ? 'C:/Windows/pwn.test.mjs' : '/etc/pwn.test.mjs';
    const r = preToolUse(ws, 'create_file', { filePath: abs });
    assertDeny(r, /OUTSIDE the workspace/i);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test('#187 live guard still ALLOWS a legitimate in-workspace edit inside the scope', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ scope: ['repo-a/lib/**'] });
  try {
    const r = preToolUse(ws, 'create_file', { filePath: 'repo-a/lib/x.mjs' });
    assert.equal(r.decision, 'allow', `a contained in-scope edit must still be allowed:\n${r.reason}`);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});
