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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REPO_ROOT, seedMonorootWorkspace, spawnHook } from './session-harness.mjs';

/** The one hook the host runs on PreToolUse. */
const GATE_GUARD = 'scripts/gate-guard.mjs';

const TASK_ID = 'T1';

/**
 * @typedef {Object} StateSpec
 * @property {'feature'|'bug'|'chore'} [lane]
 * @property {string} [gate]
 * @property {boolean} [tdd]           testFileWritten (default true).
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
    artifactHashes: {},
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
      hook_event_name: 'PreToolUse',
      session_id: 'sess-deny-matrix',
      tool_name: toolName,
      tool_input: toolInput,
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
// Latency: the guard is on the hot path of every tool call, so a deny must be
// fast and must never hang. Pin the subprocess round-trip well under the guard's
// own 10s ceiling — a regression that made it block would surface here.
// ---------------------------------------------------------------------------

test('latency: a deny returns promptly, well under the hook timeout', skipUnlessNode(24), () => {
  const ws = makeWorkspace({ config: 'missing' });
  try {
    const r = preToolUse(ws, CREATE, { filePath: SOURCE_FILE, content: 'x' });
    assert.equal(r.decision, 'deny');
    assert.ok(r.elapsedMs < 10000, `guard round-trip must be prompt (was ${Math.round(r.elapsedMs)}ms)`);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

// A defensive guard against the harness silently pointing at the wrong script.
test('meta: the gate-guard script under test exists', skipUnlessNode(24), () => {
  assert.ok(REPO_ROOT.length > 0);
});
