// @ts-check
/**
 * END-TO-END: the session artifacts an agent may not write.
 *
 * ## What was broken
 *
 * `evaluateGuard` Rule 4 restricts who may write `.devmate/state/task.json` (the
 * gate itself), `spec.md` (the human-approved contract), and the rest of the
 * evidence chain. It had never executed. Its three inputs — `sessionArtifactPaths`,
 * the allowed-agent list, and `activeAgent` — had NO producer anywhere in the
 * repository: the sole call site (`scripts/gate-guard.mjs`) passed
 * `{ scope, budgetCritical }` and nothing else, so `sessionPaths.length > 0` was
 * false on every real call and the rule was skipped. **Any agent with an edit tool
 * could rewrite the approved spec and the gate state itself** — including writing
 * `"workflowGate": "impl-started"` to forge the human approval that the
 * SubagentStart guard checks for (#93).
 *
 * The unit tests did not catch it. They called `evaluateGuard` directly with the
 * inputs populated, proving the *evaluator* denies a disallowed agent — while
 * nothing asserted the hook ever passes them. The consumer was tested; the
 * producer did not exist.
 *
 * ## Why this suite is an E2E and not a unit test
 *
 * The defect lived in the wiring, so only the wiring can prove it fixed. Every
 * assertion below drives the REAL hook subprocesses registered in
 * `hooks/hooks.json`, with payloads shaped like the captured ones, in the
 * workspace layout devmate ships into — and reads the decision the host would
 * actually act on (`hookSpecificOutput.permissionDecision`). A test that stubs
 * `evaluateGuard`'s inputs here would guard the bug instead of the fix.
 *
 * Identity comes from the one event that carries it: `SubagentStart` sends
 * `agent_type` (captured — test/fixtures/hook-payloads/derived/subagentstart.fullstack.json),
 * which the budget guard stamps onto `task.json`. PreToolUse carries no agent
 * name at all, which is why the rule denies by DEFAULT and identity can only ever
 * permit the single legitimate writer (`spec-writer` → `spec.md`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
} from './session-harness.mjs';

const SESSION_ID = '0f2a4a2e-7d0f-4a1b-9a4c-6f1f1cf0f2ab';

/** The one hook the host runs on PreToolUse. */
const GATE_GUARD = 'scripts/gate-guard.mjs';

/** The SubagentStart/SubagentStop hook, in both its registered modes. */
const SUBAGENT_GUARD = 'hooks/subagent-budget-guard.mjs';

/**
 * Bootstrap a real session: SessionStart writes task.json, exactly as it does in
 * a live workspace. Nothing under `state/` is seeded by hand.
 * @returns {ReturnType<typeof seedMonorootWorkspace>}
 */
function bootstrapSession() {
  const ws = seedMonorootWorkspace();
  replaySession(
    [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
    ws.hostCwd,
  );
  return ws;
}

/**
 * Put a sub-agent in flight the way the host does — a SubagentStart payload
 * carrying `agent_type`/`agent_id`, through the registered hook.
 * @param {ReturnType<typeof seedMonorootWorkspace>} ws
 * @param {string} agentType
 * @param {string} agentId
 */
function startSubagent(ws, agentType, agentId) {
  return spawnHook(
    SUBAGENT_GUARD,
    ['start'],
    {
      hook_event_name: 'SubagentStart',
      session_id: SESSION_ID,
      agent_id: agentId,
      agent_type: agentType,
      cwd: ws.hostCwd,
    },
    ws.hostCwd,
  );
}

/**
 * Ask the live PreToolUse guard to approve a tool call, and return the decision
 * the HOST reads — `hookSpecificOutput.permissionDecision`, not devmate's
 * internal shape.
 * @param {ReturnType<typeof seedMonorootWorkspace>} ws
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @returns {{ decision: string, reason: string }}
 */
function preToolUse(ws, toolName, toolInput) {
  const ran = spawnHook(
    GATE_GUARD,
    [],
    {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      tool_name: toolName,
      tool_input: toolInput,
      cwd: ws.hostCwd,
    },
    ws.hostCwd,
  );
  const parsed = JSON.parse(ran.stdout);
  const out = parsed.hookSpecificOutput ?? {};
  return {
    decision: String(out.permissionDecision ?? ''),
    reason: String(out.permissionDecisionReason ?? ''),
  };
}

describe('E2E — session artifacts are not agent-writable', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = bootstrapSession();
    // A read-only analysis agent: SubagentStart admits it (it is not an
    // implementation dispatch), so it becomes the attributable caller below.
    startSubagent(ws, 'discovery', 'agent-1');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('records the in-flight agent from the host-supplied agent_type', () => {
    // The producer that never existed. Without this, `activeAgent` is undefined
    // on every PreToolUse and the rule below has nothing to gate on.
    const state = readState(ws.root);
    assert.deepEqual(state.activeAgents, [{ agentName: 'discovery', agentId: 'agent-1' }]);
  });

  it('denies an agent edit to .devmate/state/task.json', () => {
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/state/task.json',
      content: '{}',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /session artifact/i);
  });

  it('denies the forged approval: the gate cannot be edited to impl-started', () => {
    // The whole point. SubagentStart lets an implementation agent start only at
    // impl-started with the lane's artifacts on disk — but it reads that from
    // task.json, a file nothing protected. An agent that writes the gate itself
    // forges the human approval the guard is checking for.
    const verdict = preToolUse(ws, 'replace_string_in_file', {
      filePath: '.devmate/state/task.json',
      oldString: '"workflowGate":"no-lane"',
      newString: '"workflowGate":"impl-started"',
    });
    assert.equal(verdict.decision, 'deny');

    const state = readState(ws.root);
    assert.notEqual(state.workflowGate, 'impl-started');
  });

  it('denies an agent edit to spec.md when the agent is not spec-writer', () => {
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/session/spec.md',
      content: '# Rewritten after approval',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /session artifact/i);
  });

  it('denies a TERMINAL write to spec.md (redirect, tee, sed -i)', () => {
    // The bypass that slipped both guards: `run_in_terminal` carries `command`,
    // not `filePath`, and `.md` was not a source extension — so `echo … > spec.md`
    // was classified as a non-source write and sailed straight through to the
    // default allow.
    for (const command of [
      'echo "# forged" > .devmate/session/spec.md',
      'echo "# forged" | tee .devmate/session/spec.md',
      "sed -i 's/no-lane/impl-started/' .devmate/state/task.json",
    ]) {
      const verdict = preToolUse(ws, 'run_in_terminal', { command });
      assert.equal(verdict.decision, 'deny', `should deny: ${command}`);
    }
  });

  it('allows a genuinely read-only terminal command against a session artifact', () => {
    // Fail-closed must not mean fail-useless: reading the gate is how an agent
    // learns where the workflow is.
    const verdict = preToolUse(ws, 'run_in_terminal', {
      command: 'cat .devmate/state/task.json',
    });
    assert.equal(verdict.decision, 'allow');
  });
});

describe('E2E — spec-writer is the one agent that may write spec.md', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = bootstrapSession();
    startSubagent(ws, 'spec-writer', 'agent-2');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('allows spec-writer to write spec.md', () => {
    // And it must be allowed at a gate where source edits are NOT — spec.md is
    // written at spec-draft, before implementation opens.
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/session/spec.md',
      content: '# Spec',
    });
    assert.equal(verdict.decision, 'allow');
  });

  it('does not extend that permission to the gate state', () => {
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/state/task.json',
      content: '{}',
    });
    assert.equal(verdict.decision, 'deny');
  });

  it('withdraws the permission once the sub-agent stops', () => {
    // The roster is a lifecycle, not a grant: after SubagentStop nobody is in
    // flight, so nobody holds spec-writer's identity.
    spawnHook(
      SUBAGENT_GUARD,
      ['stop'],
      {
        hook_event_name: 'SubagentStop',
        session_id: SESSION_ID,
        agent_id: 'agent-2',
        agent_type: 'spec-writer',
        stop_hook_active: false,
        cwd: ws.hostCwd,
      },
      ws.hostCwd,
    );
    assert.deepEqual(readState(ws.root).activeAgents, []);

    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/session/spec.md',
      content: '# Spec, rewritten by whoever',
    });
    assert.equal(verdict.decision, 'deny');
  });
});

describe('E2E — at impl-started, where the edit tools are live', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = bootstrapSession();
    // THE scenario. Before implementation opens, Rule 3 (no source edits at this
    // gate) happens to refuse an artifact write too — so a suite that only tested
    // there would prove nothing about Rule 4. At impl-started the edit tools are
    // legitimately live, and the scope contract below deliberately ALLOWS
    // `.devmate/**`, so every other rule waves the write through. Rule 4 is the
    // only thing standing between @fullstack and the gate state — and until #93
    // it was not standing at all: this write was ALLOWED.
    const state = readState(ws.root);
    writeFileSync(
      join(ws.root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        ...state,
        lane: 'feature',
        workflowGate: 'impl-started',
        tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
      }),
      'utf8',
    );
    const sessionDir = join(ws.root, '.devmate', 'session', state.taskId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'scope.md'),
      ['---', 'lane: feature', '---', '# Scope', '', '## Allowed paths', '', '## Allowed globs', '- .devmate/**', '- repo-a/lib/**', ''].join('\n'),
      'utf8',
    );
    startSubagent(ws, 'fullstack', 'agent-5');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('denies @fullstack writing the gate state', () => {
    const verdict = preToolUse(ws, 'replace_string_in_file', {
      filePath: '.devmate/state/task.json',
      oldString: '"workflowGate":"impl-started"',
      newString: '"workflowGate":"pr-ready"',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /session artifact/i);
  });

  it('denies @fullstack rewriting the approved spec', () => {
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/session/spec.md',
      content: '# Spec, edited to match what I built',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /session artifact/i);
  });

  it('denies the artifact write when the host sends an ABSOLUTE path', () => {
    // The same file, spelled the way several VS Code tools spell it. A glob
    // written against the workspace-relative form does not match this string —
    // so matching the raw path would leave the easier-to-produce spelling
    // unprotected.
    const verdict = preToolUse(ws, 'create_file', {
      filePath: join(ws.root, '.devmate', 'state', 'task.json'),
      content: '{}',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /session artifact/i);
  });

  it('still allows @fullstack to edit product code inside the scope contract', () => {
    // Fail-closed on artifacts must not close the lane it exists to protect.
    const verdict = preToolUse(ws, 'create_file', {
      filePath: 'repo-a/lib/app.mjs',
      content: 'export const a = 1;\n',
    });
    assert.equal(verdict.decision, 'allow');
  });
});

describe('E2E — parallel dispatch: an unattributable caller writes nothing', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;

  before(() => {
    ws = bootstrapSession();
    // The ambiguity the issue demanded be resolved explicitly, not left implicit:
    // with two DIFFERENT agents in flight, a PreToolUse event carries nothing
    // that says which one is calling.
    startSubagent(ws, 'spec-writer', 'agent-3');
    startSubagent(ws, 'discovery', 'agent-4');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('denies the artifact write it cannot attribute — spec-writer being in flight is not enough', () => {
    const verdict = preToolUse(ws, 'create_file', {
      filePath: '.devmate/session/spec.md',
      content: '# Written by whichever agent this is',
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /attributed/i);
  });
});
