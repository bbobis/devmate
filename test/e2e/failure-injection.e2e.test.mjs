// @ts-check
/**
 * END-TO-END: artifact-failure injection and hook output-contract enforcement —
 * the "exit-1 bug class" (issue #8).
 *
 * ## What this suite exists to prove
 *
 * The happy-path journeys walk a lane when every worker returns a clean contract
 * and every artifact lands. This suite does the opposite on purpose: it feeds the
 * real hooks malformed, empty, and misattributed returns; it breaks the artifact
 * write and the trace write; and it crashes and hangs the gate-advance hook
 * mid-flight. Every injection asserts the same three things the workflow actually
 * owes:
 *
 *   1. **Gate correctness.** A gate advances only on evidence that landed and
 *      validated. A bad return, a refused artifact, or a crashed hook must leave
 *      the gate exactly where it was — never half-moved.
 *   2. **Artifact atomicity.** The canonical evidence artifact is either written
 *      whole or not at all. A malformed return writes NOTHING (fail-closed); a
 *      crash after a `writeJsonFileAtomic` still leaves a complete file, because
 *      the write is atomic.
 *   3. **Surfacing on a host-honored channel.** Silence is the bug this whole
 *      layer replaces, and the channel is chosen to match what the host actually
 *      does with each exit code, never invented:
 *        - A dispatch that produced no evidence exits `2` with the reason on
 *          stderr — the stream VS Code shows the model.
 *        - A caught handler crash exits `0` and emits MODEL-VISIBLE catch-up
 *          guidance as `additionalContext` (the documented exit-0 channel); the
 *          raw error stays on stderr (human Output panel), with no stack.
 *        - A best-effort trace-write fault does NOT propagate: the gate still
 *          advances and the model gets the normal advance anchor, while a
 *          trace-specific warning is loud on stderr.
 *        - A host-killed timeout can emit nothing after SIGTERM (there is no
 *          exit-0 path), so model visibility comes from the NEXT invocation's
 *          catch-up — this suite asserts exactly that, and never claims same-turn
 *          model visibility for a kill.
 *
 * ## The exit-code correction
 *
 * VS Code reads exit `2` as the ONLY blocking code (stderr shown to the model);
 * exit `1` — like any other non-zero — is a non-blocking warning whose stdout is
 * never parsed. devmate's docs claimed the contract validator "returns exit 1 to
 * halt the lane", which would not have halted anything. The `contract-validator`
 * suite below pins the host-effective behavior: `2` on a violation, `0` on a
 * valid or unrouted artifact — and the docs are corrected to match.
 *
 * ## The fault seam (crash / timeout)
 *
 * A crash and a host-timeout kill cannot be observed by feeding a hook data, so
 * `lib/testing/fault-injection.mjs` adds a seam the host arms through the
 * environment (`DEVMATE_FAULT=gate-advance:<mode>`), exactly as the host arms
 * everything else it hands a hook. It is inert unless armed, impossible for a
 * production config to trip (the value must name a known site AND a known mode),
 * and a companion test asserts the production tree never sets the variable. The
 * timeout mode is explicitly HARNESS-EMULATED: the seam only supplies the hang;
 * a short spawn timeout stands in for the host's kill, because devmate does not
 * implement the host timeout.
 *
 * ## On snapshots
 *
 * The model-facing failure text is pinned with inline golden-string assertions,
 * not the Node snapshot API: this repo wires no `t.assert.snapshot`, the test
 * runner passes no snapshot flag, and a `.snapshot` sidecar would violate the
 * house rule that tests write only to temp dirs. The exact phrases a model must
 * see are load-bearing, so they are asserted literally here.
 *
 * Every suite replays real hook events through real hook subprocesses in the real
 * monoroot layout, seeding nothing under `state/` beyond what a test stands in for.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import {
  DEFAULT_SESSION_ID,
  readState,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  subagentReturnPayload,
} from './session-harness.mjs';

const SESSION_ID = DEFAULT_SESSION_ID;

/** The one editable path this workspace's config allows (`repo-a/lib/**`). */
const EDIT_PATH = 'repo-a/lib/app.mjs';

/**
 * Seed a fresh monoroot workspace and bootstrap its task.json via a real
 * SessionStart. Nothing under `state/` is pre-seeded.
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
 * Overwrite task.json with a patch merged over the bootstrapped state, so a suite
 * can stand a task at the (lane, gate) a lane procedure would have reached. Only
 * the fields named in `patch` change.
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
 * Fire one PostToolUse through the gate-advance hook ALONE (not the full
 * PostToolUse fan-out), so the assertion is about that hook's own exit code and
 * streams. `cwd` is stamped onto the payload — the only root-bearing field a hook
 * reads — and also used as the subprocess cwd, exactly as the host does.
 * @param {string} hostCwd
 * @param {Record<string, unknown>} payload
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {ReturnType<typeof spawnHook>}
 */
function fireGateAdvance(hostCwd, payload, opts = {}) {
  return spawnHook('hooks/gate-advance.mjs', [], { ...payload, cwd: hostCwd }, hostCwd, opts);
}

/**
 * A subagent-return PostToolUse payload in the host's captured shape (prose then
 * embedded JSON), via the canonical harness builder.
 * @param {string} agentName
 * @param {unknown} body
 * @param {string} toolUseId
 * @returns {Record<string, unknown>}
 */
function subagentReturn(agentName, body, toolUseId) {
  return subagentReturnPayload(agentName, body, { toolUseId });
}

/**
 * A plain (non-subagent) PostToolUse — the trigger for a catch-up walk. The
 * gate-advance hook skips projection for it but still walks the lane chain, which
 * is how a gate that a crashed invocation left unmoved heals on the next call.
 * @param {string} toolUseId
 * @returns {Record<string, unknown>}
 */
function plainReturn(toolUseId = 'toolu_catchup__vscode-1') {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    tool_name: 'read_file',
    tool_input: { filePath: EDIT_PATH },
    tool_response: 'ok',
    tool_use_id: toolUseId,
  };
}

/**
 * Parse a hook's stdout the way VS Code does on exit 0: exactly ONE JSON
 * document, or nothing. Returns the parsed object (or null when stdout is empty),
 * and throws if stdout is non-empty but not a single JSON value — which is itself
 * the contract the host enforces (mixed text+JSON is dropped whole).
 * @param {string} stdout
 * @returns {Record<string, any>|null}
 */
function parseHookStdout(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  return JSON.parse(trimmed);
}

/**
 * The model-visible `additionalContext` a PostToolUse hook emitted on exit 0, or
 * null if it emitted no context envelope.
 * @param {string} stdout
 * @returns {string|null}
 */
function additionalContextOf(stdout) {
  const json = parseHookStdout(stdout);
  const hso = json?.hookSpecificOutput;
  if (hso && typeof hso === 'object' && typeof hso.additionalContext === 'string') {
    return hso.additionalContext;
  }
  return null;
}

// A clean router return that classifies the feature lane above the confidence
// floor — used to drive a task to lane-set before a later stage is faulted.
const ROUTER_OK = { lane: 'feature', budgetClass: 'standard', confidence: 0.94 };

// A clean discovery return: one high-confidence, path-anchored claim.
const DISCOVERY_OK = {
  claims: [{ fact: 'The request handler lives here.', path: EDIT_PATH, confidence: 'high' }],
  unverified: ['[UNVERIFIED] the downstream cache is invalidated on write'],
};

// A clean grill return: mode grill, the eight finding arrays, one tagged item.
const GRILL_OK = {
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

// ---------------------------------------------------------------------------
// 1. Malformed, empty, and misattributed worker returns.
// ---------------------------------------------------------------------------

describe('E2E — a worker return that is not valid evidence advances nothing, and says so', () => {
  /**
   * Each row: an agent, a return that FAILS its contract, and the canonical
   * artifact that therefore must not appear. Every row reaches the fail-closed
   * alert path (exit 2, model-visible).
   *
   * `discovery` is deliberately ABSENT: its projection is a fan-in that, by
   * design, SKIPS a single malformed worker return (counting it in
   * `stats.invalidInputs`) and still writes a valid — if empty — merged
   * artifact, so one bad worker never blocks the gate. That tolerance is correct
   * and covered by the discovery merge's own unit tests; asserting "advances
   * nothing" here would contradict it.
   * @type {{ agent: string, body: unknown, artifact: (taskId: string) => string, block: boolean }[]}
   */
  const rows = [
    {
      agent: 'router',
      body: { lane: 'not-a-lane', budgetClass: 'standard', confidence: 0.9 },
      artifact: () => '.devmate/state/router-result.json',
      block: true,
    },
    {
      agent: 'rubber-duck',
      body: { mode: 'grill', assumptions: 'not-an-array' },
      artifact: () => '.devmate/state/grill-result.json',
      block: true,
    },
    {
      agent: 'rubber-duck',
      body: { mode: 'critique' },
      artifact: () => '.devmate/state/critique-result.json',
      block: true,
    },
    {
      agent: 'planner',
      body: { tasks: 'not-an-array' },
      artifact: (taskId) => `.devmate/session/${taskId}/plan.json`,
      block: true,
    },
    {
      agent: 'diagnose',
      body: { bugScope: 'backend' },
      artifact: () => '.devmate/state/diagnosis.json',
      block: true,
    },
  ];

  for (const row of rows) {
    const label = row.agent === 'rubber-duck' ? `rubber-duck (${row.body && /** @type {any} */ (row.body).mode})` : row.agent;
    describe(`@${label}: an invalid return`, () => {
      /** @type {ReturnType<typeof seedMonorootWorkspace>} */
      let ws;
      /** @type {ReturnType<typeof spawnHook>} */
      let ran;
      /** @type {string} */
      let gateBefore;

      before(() => {
        ws = boot();
        const taskId = readState(ws.root).taskId;
        gateBefore = readState(ws.root).workflowGate;
        ran = fireGateAdvance(
          ws.hostCwd,
          subagentReturn(row.agent, row.body, `toolu_${row.agent}_bad__vscode-1`),
        );
        ws = /** @type {any} */ ({ ...ws, taskId });
      });

      it('writes no canonical artifact — a bad return is never mistaken for evidence', () => {
        const taskId = /** @type {any} */ (ws).taskId;
        assert.equal(
          existsSync(join(ws.root, row.artifact(taskId))),
          false,
          `an invalid ${row.agent} return produced ${row.artifact(taskId)}`,
        );
      });

      it('leaves the gate where it was', () => {
        assert.equal(readState(ws.root).workflowGate, gateBefore);
      });

      it('surfaces the failure on stderr, never silently', () => {
        assert.notEqual(ran.stderr.trim(), '', `nothing was said about the invalid ${row.agent} return`);
      });

      if (row.block) {
        it('blocks (exit 2) with a model-actionable explanation', () => {
          assert.equal(ran.status, 2, `expected a blocking exit; got ${ran.status}\n${ran.stderr}`);
          // The model must be told WHO failed and WHAT NOT to do — the two things
          // whose absence let the orchestrator conclude its agents were broken and
          // start doing the work inline.
          assert.match(ran.stderr, /the gate stays at/i);
          assert.match(ran.stderr, /do NOT: do this work inline/i);
        });
      }
    });
  }

  describe('a dispatch that returned nothing at all', () => {
    it('blocks with the exact "no output" explanation (golden text)', () => {
      const ws = boot();
      const ran = fireGateAdvance(ws.hostCwd, {
        hook_event_name: 'PostToolUse',
        session_id: SESSION_ID,
        tool_name: 'runSubagent',
        tool_input: '...',
        tool_response: '',
        tool_use_id: 'toolu_empty__vscode-1',
      });
      assert.equal(ran.status, 2, ran.stderr);
      assert.match(ran.stderr, /returned no output at all/);
      assert.match(ran.stderr, /the dispatch completed with an empty response/);
      assert.equal(readState(ws.root).workflowGate, 'no-lane');
    });
  });

  describe('a dispatch that returned prose with no contract', () => {
    it('blocks, naming the missing contract', () => {
      const ws = boot();
      const ran = fireGateAdvance(ws.hostCwd, {
        hook_event_name: 'PostToolUse',
        session_id: SESSION_ID,
        tool_name: 'runSubagent',
        tool_input: '...',
        tool_response: 'I finished the analysis and it all looks fine to me.',
        tool_use_id: 'toolu_prose__vscode-1',
      });
      assert.equal(ran.status, 2, ran.stderr);
      assert.match(ran.stderr, /returned prose with no contract in it/);
      assert.equal(readState(ws.root).workflowGate, 'no-lane');
    });
  });

  describe('a contract that names no agent, with no host index to attribute it', () => {
    it('blocks rather than dropping an unattributable return', () => {
      const ws = boot();
      // A valid-LOOKING router body, but with no `agentName` and no SubagentStart
      // to attribute it — the exact shape that used to vanish without a trace.
      const ran = fireGateAdvance(ws.hostCwd, {
        hook_event_name: 'PostToolUse',
        session_id: SESSION_ID,
        tool_name: 'runSubagent',
        tool_input: '...',
        tool_response:
          'Done. The {} here is decoy prose.\n\n' +
          JSON.stringify({ lane: 'feature', budgetClass: 'standard', confidence: 0.9 }),
        tool_use_id: 'toolu_anon__vscode-1',
      });
      assert.equal(ran.status, 2, ran.stderr);
      assert.match(ran.stderr, /names no agent/i);
      assert.equal(readState(ws.root).workflowGate, 'no-lane');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Contract-validator: the host-effective exit code (the exit-1 correction).
// ---------------------------------------------------------------------------

describe('E2E — contract-validator blocks with exit 2, not exit 1', () => {
  /**
   * Fire the contract-validator hook alone at a written artifact.
   * @param {string} hostCwd
   * @param {string} filePath  Workspace-relative path the tool "just wrote".
   * @returns {ReturnType<typeof spawnHook>}
   */
  const validate = (hostCwd, filePath) =>
    spawnHook(
      'hooks/contract-validator.mjs',
      [],
      {
        hook_event_name: 'PostToolUse',
        session_id: SESSION_ID,
        tool_name: 'create_file',
        tool_input: { filePath },
        tool_response: 'ok',
        tool_use_id: 'toolu_write__vscode-1',
        cwd: hostCwd,
      },
      hostCwd,
    );

  it('returns exit 2 (blocking) on a routed contract violation — never exit 1', () => {
    const ws = boot();
    // A CritiqueResult that fails validation, written straight to the routed path.
    writeFileSync(
      join(ws.root, '.devmate', 'state', 'critique-result.json'),
      JSON.stringify({ mode: 'critique' }),
      'utf8',
    );
    const ran = validate(ws.hostCwd, '.devmate/state/critique-result.json');
    assert.equal(ran.status, 2, `expected the only blocking code (2); got ${ran.status}\n${ran.stderr}`);
    assert.notEqual(ran.status, 1, 'exit 1 would be a non-blocking warning — the whole bug');
    assert.match(ran.stderr, /contract violation/i);
    assert.match(ran.stderr, /CritiqueResult/);
  });

  it('returns exit 0 on a valid routed artifact', () => {
    const ws = boot();
    // Produce a genuinely valid grill-result.json by projecting a clean return
    // through the real hook — a hand-authored one risks passing for the wrong reason.
    fireGateAdvance(ws.hostCwd, subagentReturn('rubber-duck', GRILL_OK, 'toolu_grill_ok__vscode-1'));
    assert.ok(
      existsSync(join(ws.root, '.devmate', 'state', 'grill-result.json')),
      'precondition: a valid grill-result.json was projected',
    );
    const ran = validate(ws.hostCwd, '.devmate/state/grill-result.json');
    assert.equal(ran.status, 0, `a valid artifact must not block:\n${ran.stderr}`);
  });

  it('returns exit 0 for an unrouted path (no contract to enforce)', () => {
    const ws = boot();
    const ran = validate(ws.hostCwd, EDIT_PATH);
    assert.equal(ran.status, 0, `an unrouted path is a no-op:\n${ran.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Spec-writer failures: the human review gate refuses to open on nothing.
// ---------------------------------------------------------------------------

describe('E2E — a spec that never landed does not open the human review gate', () => {
  /**
   * Stand a feature task at plan-done (the gate just before draft-spec) and try to
   * walk it with the spec in the given state.
   * @param {(root: string) => void} placeSpec  Writes (or does not write) spec.md.
   * @returns {{ root: string, gate: string }}
   */
  const walkWithSpec = (placeSpec) => {
    const ws = boot();
    seedState(ws.root, { lane: 'feature', workflowGate: 'plan-done', currentStep: 4 });
    placeSpec(ws.root);
    fireGateAdvance(ws.hostCwd, plainReturn());
    return { root: ws.root, gate: readState(ws.root).workflowGate };
  };

  it('stays at plan-done when spec.md is empty', () => {
    const { gate } = walkWithSpec((root) => {
      mkdirSync(join(root, '.devmate', 'session'), { recursive: true });
      writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '   \n', 'utf8');
    });
    assert.equal(gate, 'plan-done');
  });

  it('stays at plan-done when spec-writer wrote to the wrong path', () => {
    const { root, gate } = walkWithSpec((r) => {
      const taskId = readState(r).taskId;
      // A plausible-but-wrong location: task-scoped, not the flat canonical path
      // the spec-draft precondition reads.
      mkdirSync(join(r, '.devmate', 'session', taskId), { recursive: true });
      writeFileSync(
        join(r, '.devmate', 'session', taskId, 'spec.md'),
        '# Spec\n\n## Acceptance criteria\n\n- [ ] AC1: something.\n',
        'utf8',
      );
    });
    assert.equal(gate, 'plan-done');
    assert.equal(
      existsSync(join(root, '.devmate', 'session', 'spec.md')),
      false,
      'the canonical spec.md must still be absent',
    );
  });

  it('the refusal names spec.md, so a caller learns why (precondition reason)', async () => {
    const ws = boot();
    const state = /** @type {import('../../lib/types.mjs').TaskState} */ (
      seedState(ws.root, { lane: 'feature', workflowGate: 'plan-done', currentStep: 4 })
    );
    const result = await transitionGate(state, 'draft-spec', {
      stateDir: join(ws.root, '.devmate', 'state'),
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /spec\.md is missing, empty, or unreadable/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Scope-contract derivation failure.
// ---------------------------------------------------------------------------

describe('E2E — a plan that yields no scope contract leaves it unwritten, loudly', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let ran;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = boot();
    // Remove the config so the hook loads NO test-glob floor. `collectTestGlobs`
    // always unions the built-in `DEFAULT_TEST_GLOBS`, so a config with empty
    // `testGlobs` would STILL floor the scope — the only way to a truly empty
    // contract is `config === null` (which `loadDevmateConfig` returns for a
    // missing file, and `projectWorkerReturn` tolerates). With no floor AND a
    // plan that lists no files, the derived scope is empty and scope-writer
    // refuses it (an empty scope denies every edit). This is the
    // partial-projection case — plan.json lands, scope.md does not. Deleting
    // after boot() is safe: SessionStart already bootstrapped with the config
    // present, and gate-advance is explicitly resilient to a missing one.
    rmSync(join(ws.root, '.devmate', 'devmate.config.json'));
    taskId = readState(ws.root).taskId;
    seedState(ws.root, { lane: 'feature', workflowGate: 'grill-done', currentStep: 3 });

    // A valid plan whose only task lists NO files.
    const emptyPlan = {
      tasks: [
        {
          description: 'A task that names no files.',
          tddApproach: 'n/a',
          persona: 'backend',
          ac: ['AC1: nothing to edit.'],
          files: [],
        },
      ],
      assumptions: [],
      openRisks: [],
      unverified: [],
    };
    ran = fireGateAdvance(ws.hostCwd, subagentReturn('planner', emptyPlan, 'toolu_planner_empty__vscode-1'));
  });

  it('writes plan.json but NOT scope.md — a half-projection, not a silent one', () => {
    assert.ok(existsSync(join(ws.root, '.devmate', 'session', taskId, 'plan.json')), 'plan.json should land');
    assert.equal(
      existsSync(join(ws.root, '.devmate', 'session', taskId, 'scope.md')),
      false,
      'scope.md must be absent when the contract would be empty',
    );
  });

  it('reports the refused scope on stderr (partial_projection), not nothing', () => {
    assert.match(ran.stderr, /partial_projection/);
    assert.match(ran.stderr, /scope/i);
  });
});

describe('E2E — an implementation dispatch is refused when the scope contract is absent', () => {
  it('denies @fullstack, naming the missing scope.md', () => {
    const ws = boot();
    const state = readState(ws.root);
    seedState(ws.root, { lane: 'bug', workflowGate: 'impl-started', currentStep: 0 });

    // A VALID diagnosis exists, so the deny is unambiguously about the scope, not
    // the diagnosis — proving the message names the specific absent contract.
    writeFileSync(
      join(ws.root, '.devmate', 'state', 'diagnosis.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: state.taskId,
        bugScope: 'backend',
        suspectedLayer: 'repo-a/lib/cursor.mjs',
        reproCommand: 'npm test -- cursor',
        fixerRecommendation: 'clamp the batch cursor at the final page boundary',
        allowedPaths: ['repo-a/lib/cursor.mjs'],
        allowedGlobs: [],
      }),
      'utf8',
    );

    const r = spawnHook(
      'hooks/subagent-budget-guard.mjs',
      ['start'],
      {
        hook_event_name: 'SubagentStart',
        session_id: SESSION_ID,
        agent_id: 'toolu_impl_noscope',
        agent_type: 'fullstack',
        cwd: ws.hostCwd,
      },
      ws.hostCwd,
    );
    assert.notEqual(r.status, 0, `dispatch allowed with no scope.md:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /scope/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Hook crash injection — best-effort, and healed by catch-up.
// ---------------------------------------------------------------------------

describe('E2E — a crash mid-advance leaves the gate unmoved, then the next call heals it', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let crashed;

  before(() => {
    ws = boot();
    // Router first (UNARMED), so the lane is classified and PERSISTED — the crash
    // then happens on a later stage whose lane is already on disk, so catch-up has
    // a stable chain to walk.
    fireGateAdvance(ws.hostCwd, subagentReturn('router', ROUTER_OK, 'toolu_router__vscode-1'));
    assert.equal(readState(ws.root).workflowGate, 'lane-set', 'precondition: router advanced to lane-set');

    // Now ARM a crash and deliver a clean discovery return. Projection writes
    // discovery-merged.json (atomically), THEN the seam throws — before the gate
    // walk. The gate must not move.
    crashed = fireGateAdvance(
      ws.hostCwd,
      subagentReturn('discovery', DISCOVERY_OK, 'toolu_discovery__vscode-1'),
      { env: { DEVMATE_FAULT: 'gate-advance:crash' } },
    );
  });

  it('did not take down the tool call — best-effort exit 0', () => {
    // main() catches the handler throw and returns 0: a bookkeeping hook must
    // never block a tool call. The crash is loud, not fatal.
    assert.equal(crashed.status, 0, `a crashed gate-advance blocked the tool call:\n${crashed.stderr}`);
  });

  it('surfaced the crash detail on stderr (human Output panel only — no stack)', () => {
    assert.match(crashed.stderr, /injected crash|fault-injection/i);
    // The raw error is human-only; a stack must never leak, not even to stderr.
    // A V8 stack frame is a line of the form "\n    at ...", so its absence is a
    // plain substring check (no regex — avoids a ReDoS-flagged pattern).
    assert.ok(!crashed.stderr.includes('\n    at '), 'a stack trace leaked to stderr');
  });

  it('emits model-visible catch-up guidance as ONE valid JSON additionalContext (exit-0)', () => {
    // #8: the model must NOT see a clean, successful no-op when the gate silently
    // failed to advance. On exit 0 VS Code parses stdout as one JSON document; the
    // recovery guidance rides the documented additionalContext channel.
    const ctx = additionalContextOf(crashed.stdout);
    assert.ok(ctx !== null, `expected model-visible additionalContext on stdout; got: ${JSON.stringify(crashed.stdout)}`);
    // Actionable recovery/catch-up guidance — the next call heals the gate.
    assert.match(ctx, /recoverable/i);
    assert.match(ctx, /next tool call|catches the gate up|catch/i);
    // No stack, path, or raw error detail bleeds into the model-visible channel.
    assert.doesNotMatch(ctx, /injected crash|InjectedFaultError|\.mjs/i);
  });

  it('wrote the artifact whole and parseable — an atomic write survives the crash after it', () => {
    const artifactPath = join(ws.root, '.devmate', 'state', 'discovery-merged.json');
    assert.ok(existsSync(artifactPath), 'discovery-merged.json should be on disk despite the crash');
    // Atomicity beyond existence: the file parses as complete JSON with the merged
    // shape, and no partial `.tmp` sibling from the atomic write remains.
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
    assert.ok(Array.isArray(parsed.claims), 'the merged artifact must be complete (claims[] present)');
    assert.equal(existsSync(artifactPath + '.tmp'), false, 'a partial .tmp sibling was left behind');
  });

  it('left the gate at lane-set — not half-advanced', () => {
    assert.equal(readState(ws.root).workflowGate, 'lane-set');
  });

  it('heals on the next (unarmed) invocation: lane-set -> discovery-done', () => {
    const healed = fireGateAdvance(ws.hostCwd, plainReturn('toolu_heal__vscode-1'));
    assert.equal(healed.status, 0, healed.stderr);
    assert.equal(
      readState(ws.root).workflowGate,
      'discovery-done',
      'catch-up must advance every gate whose artifact has since landed',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Hook timeout injection (HARNESS-EMULATED) — the host kills a hung hook.
// ---------------------------------------------------------------------------

describe('E2E — a hung hook is killed by the host, and catch-up still heals the gate', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let hung;

  before(() => {
    ws = boot();
    fireGateAdvance(ws.hostCwd, subagentReturn('router', ROUTER_OK, 'toolu_router__vscode-1'));
    assert.equal(readState(ws.root).workflowGate, 'lane-set', 'precondition: router advanced to lane-set');

    // Arm a hang and give the spawn a generous-but-bounded timeout. devmate does
    // not implement a hook timeout — the host does; the spawn timeout stands in
    // for the host's SIGTERM kill (HARNESS-EMULATED). The seam blocks for 60s
    // AFTER the atomic artifact write, so 4000ms is far below the hang yet leaves
    // ample headroom over node cold-start + gate-advance + projection on a slow
    // CI runner (the 1500ms window could race the atomic write on the slowest
    // Windows/macOS matrix — this makes the kill deterministic without waiting
    // anywhere near the full 60s hang).
    hung = fireGateAdvance(
      ws.hostCwd,
      subagentReturn('discovery', DISCOVERY_OK, 'toolu_discovery__vscode-1'),
      { env: { DEVMATE_FAULT: 'gate-advance:timeout' }, timeoutMs: 4000 },
    );
  });

  it('was killed by a signal, not a clean exit (the emulated host timeout)', () => {
    assert.equal(hung.signal, 'SIGTERM', `expected a SIGTERM kill; got status=${hung.status} signal=${hung.signal}`);
  });

  it('emitted nothing on stdout — no process can speak to the model after SIGTERM', () => {
    // A host-killed hook is fundamentally different from a caught crash: there is
    // no exit-0 path, so NO additionalContext can be emitted this turn. Model
    // visibility for a timeout comes only from the NEXT invocation's catch-up
    // (asserted below). This test pins that we do not (and cannot) claim same-turn
    // model visibility for a kill.
    assert.equal(hung.stdout.trim(), '', `a killed hook must not have emitted stdout; got: ${JSON.stringify(hung.stdout)}`);
  });

  it('still wrote the artifact whole and parseable before it hung', () => {
    const artifactPath = join(ws.root, '.devmate', 'state', 'discovery-merged.json');
    assert.ok(existsSync(artifactPath));
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
    assert.ok(Array.isArray(parsed.claims), 'the merged artifact must be complete (claims[] present)');
    assert.equal(existsSync(artifactPath + '.tmp'), false, 'a partial .tmp sibling was left behind');
  });

  it('left the gate at lane-set — a killed hook advanced nothing', () => {
    assert.equal(readState(ws.root).workflowGate, 'lane-set');
  });

  it('heals on the next (unarmed) invocation, with model-visible catch-up guidance', () => {
    const healed = fireGateAdvance(ws.hostCwd, plainReturn('toolu_heal__vscode-1'));
    assert.equal(readState(ws.root).workflowGate, 'discovery-done');
    // The recovery for a kill is on the NEXT turn: the healing advance emits its
    // normal model-visible anchor naming the gate it caught up to.
    const ctx = additionalContextOf(healed.stdout);
    assert.ok(ctx !== null, `expected model-visible catch-up guidance on the next call; got: ${JSON.stringify(healed.stdout)}`);
    assert.match(ctx, /discovery-done/);
  });
});

// ---------------------------------------------------------------------------
// 7. Trace-write failure — the gate still moves; the loss is loud, not silent.
// ---------------------------------------------------------------------------

describe('E2E — a broken trace write does not roll back the gate it recorded', () => {
  /** @type {ReturnType<typeof seedMonorootWorkspace>} */
  let ws;
  /** @type {ReturnType<typeof spawnHook>} */
  let ran;
  /** @type {string} */
  let taskId;

  before(() => {
    ws = boot();
    taskId = readState(ws.root).taskId;
    // Make the trace append fail: put a DIRECTORY where the hook wants to write
    // `<taskId>.jsonl`. The gate transition is persisted BEFORE the trace append,
    // so the gate must survive the append's failure.
    mkdirSync(join(ws.root, '.devmate', 'state', 'trace', `${taskId}.jsonl`), { recursive: true });
    ran = fireGateAdvance(ws.hostCwd, subagentReturn('router', ROUTER_OK, 'toolu_router__vscode-1'));
  });

  it('advanced the gate anyway — a lost audit line is not a lost transition', () => {
    assert.equal(readState(ws.root).workflowGate, 'lane-set');
    assert.ok(
      existsSync(join(ws.root, '.devmate', 'state', 'router-result.json')),
      'the evidence artifact still landed',
    );
  });

  it('did not block the tool call (best-effort exit 0)', () => {
    assert.equal(ran.status, 0, ran.stderr);
  });

  it('emits the normal advance anchor to the model — a trace loss is not a crash', () => {
    // The scoped best-effort guard keeps the trace failure OUT of main()'s catch,
    // so the model gets the ordinary gate-advanced anchor (not the recovery text
    // reserved for a genuine handler crash).
    const ctx = additionalContextOf(ran.stdout);
    assert.ok(ctx !== null, `expected the normal advance anchor on stdout; got: ${JSON.stringify(ran.stdout)}`);
    assert.match(ctx, /gate advanced on evidence/i);
    assert.doesNotMatch(ctx, /recoverable error/i);
  });

  it('was loud about the failed write with a trace-SPECIFIC signal on stderr', () => {
    // No "gap" placeholder is synthesized for a failed append — the honest signal
    // is this structured stderr warning and the missing line itself. The oracle is
    // trace-specific (the gate_transition trace_error event + EISDIR cause), not a
    // broad `/gate-advance/i` that any unrelated handler throw would also satisfy.
    assert.match(ran.stderr, /"event":"gate-advance\.trace_error"/);
    assert.match(ran.stderr, /"type":"gate_transition"/);
    assert.match(ran.stderr, /EISDIR|illegal operation on a directory/i);
  });
});
