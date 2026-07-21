// @ts-check
/**
 * END-TO-END: adversarial and corrupted input (issue #135).
 *
 * `session-lifecycle.e2e.test.mjs` already proves an empty return and a
 * tool_use_id-less return are surfaced, never swallowed. This suite covers the
 * rest of the "agent returns garbage / state is corrupted" audit, each asserting
 * the same invariant the epic exists to protect: the workflow makes NO unsafe
 * advance, AND the failure is surfaced on the channel the model (or the read
 * boundary) actually reads — never a silent no-op, never an uncaught throw.
 *
 * All five scenarios are GREEN. Two originally surfaced genuine gaps, filed as
 * their own bugs per the one-issue-per-PR norm and now FIXED — their assertions
 * pin the corrected behavior:
 *   - #170 (FIXED) — a `@planner` return whose `files` escape the workspace
 *     (`../../etc/passwd`) is now dropped by writeScope, never serialized into
 *     `scope.md` (scenario 2).
 *   - #171 (FIXED) — the #129 invalid-(lane,gate) diagnostic now reaches the
 *     MODEL on a plain turn via the unreadable-state anchor (scenario 3).
 *
 * Every suite replays real hook events through real hook subprocesses in the
 * real monoroot layout, seeding nothing under `state/` beyond what a test stands
 * in for.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readTaskState } from '../../lib/task-state.mjs';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';
import {
  DEFAULT_SESSION_ID,
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  subagentReturnPayload,
} from './session-harness.mjs';

const SESSION_ID = DEFAULT_SESSION_ID;

/**
 * Seed a fresh monoroot workspace and bootstrap a valid task.json via a real
 * SessionStart (lane `feature`, gate `no-lane`).
 * @returns {ReturnType<typeof seedMonorootWorkspace>}
 */
function boot() {
  const ws = seedMonorootWorkspace();
  replaySession(
    [{ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'new' }],
    ws.hostCwd,
  );
  return ws;
}

/**
 * Overwrite task.json with a patch merged over the bootstrapped state.
 * @param {string} root
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, any>}
 */
function seedState(root, patch) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  const next = { ...readState(root), ...patch };
  writeFileSync(statePath, JSON.stringify(next), 'utf8');
  return next;
}

/**
 * Fire one PostToolUse through the gate-advance hook ALONE.
 * @param {string} hostCwd
 * @param {Record<string, unknown>} payload
 * @returns {ReturnType<typeof spawnHook>}
 */
function fireGateAdvance(hostCwd, payload) {
  return spawnHook('hooks/gate-advance.mjs', [], { ...payload, cwd: hostCwd }, hostCwd);
}

/**
 * A subagent-return PostToolUse payload via the canonical harness builder.
 * @param {string} agentName
 * @param {unknown} body
 * @param {string} toolUseId
 * @returns {Record<string, unknown>}
 */
function subagentReturn(agentName, body, toolUseId) {
  return subagentReturnPayload(agentName, body, { toolUseId });
}

/**
 * A plain (non-subagent) PostToolUse — triggers a catch-up walk with no projection.
 * @param {string} toolUseId
 * @returns {Record<string, unknown>}
 */
function plainReturn(toolUseId = 'toolu_catchup__vscode-1') {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    tool_name: 'read_file',
    tool_input: { filePath: 'repo-a/lib/app.mjs' },
    tool_response: 'ok',
    tool_use_id: toolUseId,
  };
}

/**
 * The model-visible `additionalContext` a hook emitted on exit 0, or null.
 * @param {string} stdout
 * @returns {string|null}
 */
function additionalContextOf(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  const json = JSON.parse(trimmed);
  const hso = json?.hookSpecificOutput;
  return hso && typeof hso.additionalContext === 'string' ? hso.additionalContext : null;
}

// ── Scenario 1: a rubber-duck return missing `mode` entirely ─────────────────

describe('E2E adversarial — a rubber-duck return with no `mode` writes nothing and is surfaced (exit 2)', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let ran;

  before(() => {
    ws = boot();
    // No `mode` key: the projector cannot tell grill from critique, matches
    // neither contract, and must write nothing (fail-closed).
    ran = fireGateAdvance(ws.hostCwd, subagentReturn('rubber-duck', { assumptions: ['x'] }, 'toolu_rd_nomode__vscode-1'));
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('writes neither grill-result.json nor critique-result.json', () => {
    assert.equal(existsSync(join(ws.root, '.devmate', 'state', 'grill-result.json')), false);
    assert.equal(existsSync(join(ws.root, '.devmate', 'state', 'critique-result.json')), false);
  });

  it('exits 2 (the blocking code) with the reason on stderr, stdout empty', () => {
    assert.equal(ran.status, 2);
    assert.equal(ran.stdout.trim(), '');
    assert.match(ran.stderr, /@rubber-duck returned a contract that does not satisfy its artifact/);
    assert.match(ran.stderr, /declared no mode, and matched neither contract/);
    assert.match(ran.stderr, /the gate stays at "no-lane"/);
    assert.match(ran.stderr, /do NOT: do this work inline/i);
  });

  it('leaves the gate exactly where it was', () => {
    assert.equal(readState(ws.root).workflowGate, 'no-lane');
  });
});

// ── Scenario 2: a planner return with an out-of-workspace path (CHARACTERIZES #170) ──

describe('E2E adversarial — a planner `files` path that escapes the workspace is sanitized (#170)', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {string} */
  let taskId;
  /** @type {ReturnType<typeof spawnHook>} */
  let ran;
  /** @type {string} */
  let scopePath;

  before(() => {
    ws = boot();
    taskId = readState(ws.root).taskId;
    // Stand the task where a planner return is projected into plan.json + scope.md.
    seedState(ws.root, { lane: 'feature', workflowGate: 'grill-done', currentStep: 3 });
    // A VALID plan (so scope.md is actually written) whose only file escapes the
    // workspace — the adversarial input.
    const plan = {
      tasks: [
        {
          description: 'A task naming a traversal path.',
          tddApproach: 'n/a',
          persona: 'backend',
          ac: ['AC1: x'],
          files: ['../../etc/passwd'],
          alignment: [
            {
              capability: 'fixture capability',
              decision: 'add',
              target: null,
              usageEvidence: [],
              patternRefs: ['lib/index.mjs:1'],
              reason: 'fixture: nothing suitable to reuse',
            },
          ],
        },
      ],
      assumptions: [],
      openRisks: [],
      unverified: [],
    };
    ran = fireGateAdvance(ws.hostCwd, subagentReturn('planner', plan, 'toolu_planner_trav__vscode-1'));
    scopePath = join(ws.root, '.devmate', 'session', taskId, 'scope.md');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('writes scope.md at the task-scoped path — the file LOCATION is never attacker-controlled', () => {
    // scopePathFor resolves the validated taskId, not any planner input, so the
    // traversal can never redirect WHERE scope.md is written. This half is safe.
    assert.equal(ran.status, 0);
    assert.ok(existsSync(scopePath), 'scope.md should be written at .devmate/session/<taskId>/');
  });

  it('#170 FIXED: the traversal path is dropped, never serialized into the scope contract', () => {
    // #170: writeScope now filters allowed paths for workspace containment
    // (filterWorkspacePaths), so `../../etc/passwd` is dropped before it can reach
    // the `## Allowed paths` section — enforceScope can no longer match it, so
    // Rule 6 will not authorize an edit to it. The test-glob floor keeps the
    // contract non-empty, so scope.md is still written (asserted above).
    const scope = readFileSync(scopePath, 'utf8');
    assert.doesNotMatch(scope, /\.\.\/\.\.\/etc\/passwd/, '#170 — the traversal path must be sanitized out');
  });
});

// ── Scenario 3: a hand-edited invalid (lane, gate) pair ──────────────────────

describe('E2E adversarial — a hand-edited invalid (lane, gate) is rejected at the read boundary (#129)', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;

  before(() => {
    ws = boot();
    // lane and gate are each valid enum members; the PAIR is illegal — the exact
    // "I edited task.json to get unstuck" corruption #129 detects.
    seedState(ws.root, { lane: 'bug', workflowGate: 'discovery-done' });
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('readTaskState fails at the boundary with the #129 diagnostic — not a downstream transition error', () => {
    const res = readTaskState(join(ws.root, '.devmate', 'state', 'task.json'));
    assert.equal(res.ok, false);
    assert.ok(
      /** @type {{ errors: string[] }} */ (res).errors.some(
        (e) => /workflowGate "discovery-done" has no transitions defined for lane "bug"/.test(e) && /hand-edited or corrupted/.test(e),
      ),
      `no #129 diagnostic in errors: ${JSON.stringify(res)}`,
    );
  });

  it('#171 FIXED: a plain turn surfaces the #129 diagnostic to the model', () => {
    // #171: emitStateAnchor now distinguishes "no task.json (legit pre-task)" from
    // "corrupt task.json" — on the latter it emits the unreadable-state anchor with
    // the validateTaskState diagnostic VERBATIM, so a plain prompt over the
    // hand-edited (lane, gate) pair reaches the model instead of silently no-op'ing.
    // Exit stays 0 (no crash).
    const r = spawnHook(
      'hooks/approval-listener.mjs',
      [],
      { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'where are we?', cwd: ws.hostCwd },
      ws.hostCwd,
    );
    assert.equal(r.status, 0, `a plain turn must not crash: ${r.stderr}`);
    const ctx = additionalContextOf(r.stdout) ?? '';
    assert.ok(ctx.length > 0, 'the plain turn should surface an anchor');
    assert.match(ctx, /has no transitions defined for lane/, '#171 — the #129 diagnostic must reach the model on a plain turn');
    assert.match(ctx, /state: unreadable/, '#171 — surfaced via the unreadable-state anchor');
  });
});

// ── Scenario 4: a whitespace-only spec.md at stampSpecDigest ─────────────────

describe('E2E adversarial — a whitespace-only spec.md is "nothing to stamp", never a throw', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let ran;

  before(() => {
    ws = boot();
    // stampSpecDigest reads the FLAT spec path and its gate (no-lane) is stampable;
    // a whitespace body must hit the `markdown.trim() === ''` → null branch.
    const sessionDir = join(ws.root, '.devmate', 'session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'spec.md'), '   \n\t\n  ', 'utf8');
    ran = fireGateAdvance(ws.hostCwd, plainReturn('toolu_wsspec__vscode-1'));
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('exits 0 and does not throw (no recoverable-error catch-up envelope)', () => {
    assert.equal(ran.status, 0);
    assert.doesNotMatch(additionalContextOf(ran.stdout) ?? '', /recoverable error/i);
    assert.doesNotMatch(ran.stderr, /gate-advance\.(project_error|caught)|SyntaxError/);
  });

  it('stamps nothing and leaves the gate put', () => {
    const state = readState(ws.root);
    assert.equal(state.artifactHashes?.specDigest, undefined);
    assert.equal(state.artifactHashes?.spec, undefined);
    assert.equal(state.workflowGate, 'no-lane');
  });
});

// ── Scenario 5: a corrupt (non-JSON) router-result.json ──────────────────────

describe('E2E adversarial — a corrupt router-result.json fails a precondition cleanly, never an uncaught throw', () => {
  /** @type {ReturnType<typeof boot>} */
  let ws;

  before(() => {
    ws = boot();
    writeFileSync(join(ws.root, '.devmate', 'state', 'router-result.json'), 'not json {{{', 'utf8');
  });

  after(() => {
    if (ws?.root) rmSync(ws.root, { recursive: true, force: true });
  });

  it('checkGatePrecondition(lane-set) rejects cleanly (unparseable), never rejecting the promise', async () => {
    const stateDir = join(ws.root, '.devmate', 'state');
    const taskId = readState(ws.root).taskId;
    /** @type {{ ok: boolean, missing: string[] }} */
    let verdict = { ok: true, missing: [] };
    await assert.doesNotReject(async () => {
      verdict = await checkGatePrecondition('lane-set', { stateDir, lane: 'feature', event: 'set-lane', taskId });
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.missing.some((m) => /router result not found \(or unparseable\)/.test(m)), JSON.stringify(verdict));
  });

  it('the real gate-advance hook stays at no-lane, exit 0, with no JSON.parse crash on stderr', () => {
    const ran = fireGateAdvance(ws.hostCwd, plainReturn('toolu_corrupt__vscode-1'));
    assert.equal(ran.status, 0);
    assert.equal(readState(ws.root).workflowGate, 'no-lane');
    assert.doesNotMatch(ran.stderr, /SyntaxError|Unexpected token|project_error/);
  });
});
