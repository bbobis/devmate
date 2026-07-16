// @ts-check
/**
 * Shared harness for the end-to-end session suites.
 *
 * The point of an E2E here is to run the hooks the way the HOST runs them —
 * real subprocesses, real payloads, real cwd — and then look at what actually
 * landed on disk. Every helper below exists to keep a suite honest:
 *
 *   - `hooksFor` reads the REAL `hooks/hooks.json`, so a hook that is registered
 *     but broken cannot hide behind a test that forgot to run it.
 *   - `seedMonorootWorkspace` builds the layout devmate actually ships into
 *     (`.devmate/` at the workspace root, sibling repos each with their own
 *     `.git`) and seeds NOTHING under `state/`. A pre-seeded workspace is how the
 *     old tests passed against broken code.
 *   - `spawnHook` passes the payload on stdin with cwd = the workspace's own
 *     `.devmate/` folder, which is what monoroot makes workspaceFolders[0] and
 *     therefore what VS Code hands every hook.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookManifest, extractScriptPath } from '../../lib/hooks/registry.mjs';
import { getOwn } from '../../lib/object-utils.mjs';
import { readJsonlSync } from '../../lib/json-io.mjs';
import { TRANSITIONS, STEERING, legalTransitions } from '../../lib/gate-transitions.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo under test. */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** The cwd the host actually hands every hook in the monoroot layout. */
export const HOST_CWD_REL = '.devmate';

/**
 * Build the workspace in the shape devmate ships into: a monoroot worktree whose
 * `.devmate/` sits at the ROOT, beside repo subfolders that each carry their own
 * `.git`. The root itself is not a git repo.
 *
 * Nothing under `.devmate/state/` is seeded. A session must create its own state
 * — that is the whole assertion.
 *
 * @param {{ persona?: string }} [opts]
 * @returns {{ root: string, hostCwd: string, stateDir: string }}
 */
export function seedMonorootWorkspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-session-'));

  mkdirSync(join(root, '.devmate'), { recursive: true });
  mkdirSync(join(root, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(root, 'repo-a', 'lib'), { recursive: true });
  mkdirSync(join(root, 'repo-b', '.git'), { recursive: true });

  // A real config: a hook handed an invalid one takes its config-missing branch,
  // which would let assertions pass for the wrong reason.
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [
        {
          persona: opts.persona ?? 'backend',
          editableGlobs: ['repo-a/lib/**', '.devmate/**'],
          offLimitsGlobs: [],
          testGlobs: ['repo-a/test/**'],
          instructionFile: null,
        },
      ],
    }),
    'utf8',
  );

  return {
    root,
    hostCwd: join(root, HOST_CWD_REL),
    stateDir: join(root, '.devmate', 'state'),
  };
}

/**
 * Every hook command `hooks/hooks.json` registers for one event, in order.
 * @param {string} event
 * @returns {{ script: string, args: string[] }[]}
 */
export function hooksFor(event) {
  const manifest = loadHookManifest(REPO_ROOT);
  // getOwn, not a bare index — the event name is a runtime value.
  const entries = getOwn(manifest.hooks ?? {}, event) ?? [];
  /** @type {{ script: string, args: string[] }[]} */
  // @bounded-alloc — one entry per registration for a single event (at most 4).
  const out = [];
  for (const entry of entries) {
    const command = entry.command;
    if (typeof command !== 'string') continue;
    const script = extractScriptPath(command);
    if (script === null) continue;
    const args = command
      .slice(command.indexOf(script) + script.length)
      .replace(/^["']/, '')
      .trim()
      .split(/\s+/)
      .filter((a) => a !== '');
    out.push({ script, args });
  }
  return out;
}

/**
 * Rebase a captured payload onto the temp workspace. Only `cwd` is touched, so
 * "captured" keeps meaning captured.
 * @param {Record<string, unknown>} event
 * @param {string} hostCwd
 * @returns {Record<string, unknown>}
 */
export function rebase(event, hostCwd) {
  return { ...event, cwd: hostCwd };
}

/**
 * Spawn one hook exactly as the host does.
 *
 * `opts` is a purely additive test seam (issue #8) with two knobs, both of which
 * mimic something the real host controls:
 *   - `env`       extra environment variables layered over the process env — the
 *                 host owns a hook's environment, and this is the ONLY way the
 *                 fault seam (lib/testing/fault-injection.mjs) is ever armed.
 *   - `timeoutMs` overrides the spawn timeout. A short value stands in for the
 *                 host's own hook-timeout kill: when a hook hangs, the host
 *                 SIGTERMs it, and spawnSync's timeout does exactly that. This is
 *                 HARNESS-EMULATED — devmate does not implement the host timeout.
 *
 * When a spawn is killed by its timeout, spawnSync returns a null exit status and
 * a `signal` (SIGTERM); `signal` is surfaced so a caller can tell a host-killed
 * hang apart from an ordinary exit. `status` keeps its historical `?? 1` fallback
 * so existing callers that only compare against 0 are unaffected.
 * @param {string} script
 * @param {string[]} args
 * @param {unknown} payload
 * @param {string} cwd
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} [opts]
 * @returns {{ script: string, status: number, signal: string|null, stdout: string, stderr: string }}
 */
export function spawnHook(script, args, payload, cwd, opts = {}) {
  const r = spawnSync('node', [join(REPO_ROOT, script), ...args], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 20000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return {
    script,
    status: r.status ?? 1,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Replay an ordered event stream through every hook registered for each event.
 * @param {Record<string, unknown>[]} events
 * @param {string} hostCwd
 * @returns {{ script: string, status: number, stdout: string, stderr: string }[]}
 */
export function replaySession(events, hostCwd) {
  /** @type {{ script: string, status: number, stdout: string, stderr: string }[]} */
  // @bounded-alloc — one entry per (event, registered hook) pair in a fixture.
  const ran = [];
  for (const event of events) {
    const payload = rebase(event, hostCwd);
    for (const { script, args } of hooksFor(String(event.hook_event_name))) {
      ran.push(spawnHook(script, args, payload, hostCwd));
    }
  }
  return ran;
}

/**
 * Every file under `dir`, relative and slash-normalized.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
export function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  // @bounded-alloc — the state a session writes into a fresh temp workspace.
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(abs.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
}

/**
 * Read the task state a session produced.
 * @param {string} root
 * @returns {Record<string, any>}
 */
export function readState(root) {
  return JSON.parse(readFileSync(join(root, '.devmate', 'state', 'task.json'), 'utf8'));
}

/**
 * Read the task state a session produced, or `null` when no task.json exists
 * yet (the pre-bootstrap window). Unlike {@link readState}, never throws.
 * @param {string} root
 * @returns {TaskState|null}
 */
export function readStateOrNull(root) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  if (!existsSync(statePath)) return null;
  try {
    return /** @type {TaskState} */ (JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scripted-turn driver (issue #131)
//
// The primitives above (`hooksFor`/`spawnHook`/`replaySession`/`readState`)
// run the real hooks as real subprocesses against a real workspace. What they
// lack is a *turn* — a user prompt followed by the tool calls and subagent
// returns it triggers — and a way to assert, after every turn, the single
// invariant this whole family of suites exists to protect: EITHER the gate
// advanced, OR no runtime caller could have advanced it (the user is stuck).
// Everything below is that layer, built ON the primitives, never replacing them.
// ---------------------------------------------------------------------------

/** The host session id stamped on every event this driver builds. */
export const DEFAULT_SESSION_ID = 'fd634936-8166-4295-a74f-2a397c9c5226';

/**
 * Fixed ISO timestamp the driver stamps when no clock is injected, so a scripted
 * session yields byte-identical payloads run to run. Injectable via `opts.now`.
 */
const DEFAULT_CLOCK = '2026-01-01T00:00:00.000Z';

/**
 * Gate events that a REAL, hook-reachable runtime caller actually fires — the
 * caller allowlist `isUserStuck` intersects with the transition table. An event
 * that is in the table but that nothing fires is NOT fireable, so it does not
 * count as a path forward.
 *
 * Re-derive from the repo root with:
 *   grep -rnoE "(transitionGate|advanceGate)\(.+, *['\"][a-z-]+['\"]" hooks/ lib/workflow/
 * then union the LANE_CHAINS in lib/workflow/gate-advance.mjs (fired by
 * `advanceAlongLane`, which the PostToolUse `hooks/gate-advance.mjs` calls).
 *
 * Callers, by the three categories the {@link isUserStuck} contract names:
 *   - approval phrase:      hooks/approval-listener.mjs — "approve plan" fires
 *                           `start-impl` (bug/chore) via transitionGate.
 *   - PostToolUse catch-up: hooks/gate-advance.mjs → advanceAlongLane fires the
 *                           LANE_CHAINS events set-lane, finish-discovery,
 *                           finish-grill, finish-plan, present-plan, draft-spec,
 *                           start-impl as the evidence for each gate lands.
 *   - dispatchable agent:   folded into PostToolUse catch-up — an agent dispatch
 *                           produces the evidence that fires the chain event.
 *
 * Deliberately EXCLUDED — present in lib/gate-transitions.mjs, but NO
 * hook-reachable caller fires them (a listed-but-uncalled event is NOT
 * fireable). This is exactly the "steering is dead code" class this epic exists
 * to surface, so the exclusion is load-bearing, not an oversight:
 *   - pass-verification, complete: fired only inside lib/workflow/lanes/*.mjs
 *       executor functions that no hook calls.
 *   - mark-pr-ready:   "approve pr" advances the verification-passed → pr-ready
 *       GATE edge via advanceHumanGate; nothing fires the `mark-pr-ready` event.
 *   - revise-scope, re-plan, new-requirements, park, resume, abandon: the
 *       steering edges. Their only runtime caller is the `gatectl workflow
 *       set` CLI a human runs in the integrated terminal (docs/gates.md) —
 *       nothing hook-reachable fires them, so they cannot rescue a stuck
 *       session on their own. (`lib/workflow/lanes/feature.mjs`'s
 *       `steerFeature` also fires revise-scope/re-plan but has no caller.)
 *   - approve-plan:    in the GateEvent union but in no transition table and
 *                      fired by nothing.
 * @type {ReadonlySet<GateEvent>}
 */
export const FIREABLE_EVENTS = new Set(
  /** @type {GateEvent[]} */ ([
    'set-lane',
    'finish-discovery',
    'finish-grill',
    'finish-plan',
    'present-plan',
    'draft-spec',
    'start-impl',
  ]),
);

/**
 * Gates a human approval PHRASE advances FROM through a gate-EDGE
 * (advanceHumanGate), which carries no GateEvent — so {@link FIREABLE_EVENTS}
 * cannot see the move and it must be recorded here. A task sitting on one of
 * these is never stuck: the human types the phrase and the gate moves.
 *   spec-draft          "approve spec" → spec-approved   (hooks/approval-listener.mjs)
 *   verification-passed "approve pr"   → pr-ready         (hooks/approval-listener.mjs)
 * plan-approved is NOT listed: its forward move IS an event (`start-impl` on
 * bug/chore, `draft-spec` on feature), so {@link FIREABLE_EVENTS} already covers
 * it. Re-derive by grepping hooks/approval-listener.mjs for advanceHumanGate targets.
 * @type {ReadonlySet<WorkflowGate>}
 */
const HUMAN_APPROVAL_GATES = new Set(
  /** @type {WorkflowGate[]} */ (['spec-draft', 'verification-passed']),
);

/**
 * The GateEvents legal from `(lane, gate)`: the keys of the lane-owned
 * transition table and the lane-agnostic steering table, plus `resume` at
 * `parked` (transitionGate's dynamic edge, which lives in no static table).
 * Mirrors {@link legalTransitions} but at the event level, because the caller
 * allowlist is event-keyed.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {GateEvent[]}
 */
function legalEventsFrom(lane, gate) {
  /** @type {Set<GateEvent>} */
  // @bounded-alloc — a handful of events per gate across two frozen tables.
  const events = new Set();
  const laneTable = getOwn(TRANSITIONS, lane);
  const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, gate);
  if (gateTable) {
    for (const event of Object.keys(gateTable)) events.add(/** @type {GateEvent} */ (event));
  }
  const steeringTable = getOwn(STEERING, gate);
  if (steeringTable) {
    for (const event of Object.keys(steeringTable)) events.add(/** @type {GateEvent} */ (event));
  }
  if (gate === 'parked') events.add('resume');
  return [...events];
}

/**
 * True when, from the CURRENT persisted task state, no legal event is fireable
 * by any real runtime caller — the user has no path forward and, unless the hook
 * that just ran said why, will sit forever.
 *
 * The verdict is `legalTransitions()` (what the table permits from here)
 * intersected with a maintained caller allowlist ({@link FIREABLE_EVENTS} +
 * {@link HUMAN_APPROVAL_GATES}), NOT the full theoretical table: a transition
 * the table lists but no caller fires does not rescue the user. A gate with no
 * legal successor at all is terminal (`done`/`abandoned`) — a legitimate END,
 * not stuck.
 *
 * The allowlist is injectable so a test can assert genericity against a
 * hand-built table (e.g. prove impl-started reads as stuck the moment the
 * feature-lane steering events are treated as uncalled — the check that would
 * have caught this epic's "steering is dead code" defect before it was fixed).
 *
 * @param {TaskState} state
 * @param {{ fireableEvents?: Iterable<GateEvent> }} [opts]  Override the caller
 *   allowlist (defaults to {@link FIREABLE_EVENTS}). {@link HUMAN_APPROVAL_GATES}
 *   is always consulted — a human phrase does not go away because a test narrowed
 *   the event allowlist.
 * @returns {boolean}
 */
export function isUserStuck(state, opts = {}) {
  const gate = /** @type {WorkflowGate} */ (state.workflowGate);
  const lane = /** @type {Lane} */ (state.lane);

  // A human approval phrase advances this gate through a bare gate-edge that no
  // event names — a legitimate path forward the event allowlist cannot express.
  if (HUMAN_APPROVAL_GATES.has(gate)) return false;

  // No legal successor at all ⇒ terminal (done/abandoned): a legitimate end.
  if (legalTransitions(lane, gate).length === 0) return false;

  const fireable = opts.fireableEvents ? new Set(opts.fireableEvents) : FIREABLE_EVENTS;
  const anyFireable = legalEventsFrom(lane, gate).some((event) => fireable.has(event));
  return !anyFireable;
}

/**
 * Build a realistic `runSubagent` PostToolUse payload for a subagent's return,
 * in the shape the host actually delivers
 * (test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json):
 * `tool_name` is `runSubagent`, `tool_input` is the elided literal `"..."`, and
 * `tool_response` is the agent's final CHAT TEXT — prose FOLLOWED BY the embedded
 * JSON contract, which is where `lib/hooks/agent-result.mjs` reads the agent's
 * identity and result from. The prose-before-JSON shape is deliberate: a bare
 * JSON string would dodge the harder path `extractEmbeddedJson` must handle.
 *
 * The embedded contract carries `agentName` (the identity channel the real hook
 * uses when the host index has no entry). The `agentName` argument is the
 * default; a matching key inside `returnBody` overrides it.
 *
 * The prose deliberately carries a literal `{}` BEFORE the JSON: a real agent
 * reply narrates and quotes code ("the guard returns `{}` for anonymous
 * callers"), so a brace-span parser that took first-`{`-to-last-`}` would swallow
 * the empty braces and the contract together and parse nothing (#105). Baking the
 * hardening in here means every scripted return exercises the harder path
 * `extractEmbeddedJson` must survive, and no suite has to re-invent it.
 *
 * @param {string} agentName            Agent whose return this simulates (e.g. 'router').
 * @param {unknown} returnBody          The agent's contract object (its typed return).
 * @param {{ toolUseId?: string }} [opts]
 * @returns {Record<string, unknown>}
 */
export function subagentReturnPayload(agentName, returnBody, opts = {}) {
  const body =
    returnBody !== null && typeof returnBody === 'object' && !Array.isArray(returnBody)
      ? /** @type {Record<string, unknown>} */ (returnBody)
      : { value: returnBody };
  const embedded = { agentName, ...body };
  const toolUseId = opts.toolUseId ?? `toolu_${agentName}_1__vscode-1783942732395`;

  // Keys mirror the captured fixture exactly (structural-shape contract). `cwd`
  // is a placeholder — replaySession/rebase overwrites it with the workspace's
  // own `.devmate/` before the payload reaches a hook.
  return {
    timestamp: DEFAULT_CLOCK,
    hook_event_name: 'PostToolUse',
    session_id: DEFAULT_SESSION_ID,
    transcript_path: '.devmate/state/transcript.jsonl',
    tool_name: 'runSubagent',
    tool_input: '...',
    tool_response:
      `Returning the ${agentName} contract. The {} braces in this prose come before the JSON, ` +
      `so a brace-span parser cannot cheat.\n\n${JSON.stringify(embedded)}`,
    tool_use_id: toolUseId,
    cwd: HOST_CWD_REL,
  };
}

/**
 * The full SubagentStart → PostToolUse(return) → SubagentStop trio a real
 * dispatch emits, built from the canonical fixture-shaped payload
 * ({@link subagentReturnPayload}). The return's `tool_use_id` is derived from
 * `agentId` with the host's `__vscode` suffix, so it links back to its start the
 * way `resolveAgentName` joins them; `agentType` is both the SubagentStart
 * `agent_type` (the host identity channel) and the embedded `agentName`.
 *
 * This is the one place the trio is defined: journey suites replay it rather than
 * re-authoring the wire shape, so a change to the captured fixture updates every
 * suite through this single builder.
 *
 * @param {string} agentId              Host `agent_id` for the SubagentStart/Stop pair.
 * @param {string} agentType            Agent name (SubagentStart `agent_type` + embedded `agentName`).
 * @param {unknown} returnBody          The agent's typed contract object.
 * @returns {Record<string, unknown>[]}
 */
export function subagentDispatch(agentId, agentType, returnBody) {
  const toolUseId = `${agentId}__vscode-1783942732395`;
  return [
    { hook_event_name: 'SubagentStart', session_id: DEFAULT_SESSION_ID, agent_id: agentId, agent_type: agentType },
    subagentReturnPayload(agentType, returnBody, { toolUseId }),
    { hook_event_name: 'SubagentStop', session_id: DEFAULT_SESSION_ID, agent_id: agentId, agent_type: agentType },
  ];
}

/**
 * Read a JSONL trace file into objects, via the canonical reader. Shared so the
 * journey suites do not each re-wrap {@link readJsonlSync}.
 * @param {string} filePath
 * @returns {Record<string, any>[]}
 */
export function readTraceEvents(filePath) {
  return /** @type {Record<string, any>[]} */ (readJsonlSync(filePath));
}

/**
 * One turn in a scripted session: a user prompt, followed by zero or more
 * tool-call / subagent-return steps, in order.
 * @typedef {Object} Turn
 * @property {string} prompt                 UserPromptSubmit prompt text.
 * @property {ToolStep[]} [tools]            Tool calls / returns after the prompt, in order.
 * @property {TurnExpectation} [expect]      Assertions to run once this turn's events have replayed.
 */

/**
 * One PreToolUse/PostToolUse pair, or a subagent dispatch+return trio.
 * @typedef {Object} ToolStep
 * @property {string} toolName                        Host tool name for an ordinary call, or — when
 *                                                    `subagentReturn` is set — the subagent's name.
 * @property {Record<string, unknown>} [toolInput]    tool_input for an ordinary PreToolUse/PostToolUse pair.
 * @property {unknown} [subagentReturn]               When present, this step is a subagent dispatch+return:
 *                                                    a SubagentStart, then a PostToolUse built by
 *                                                    {@link subagentReturnPayload}, then a SubagentStop.
 */

/**
 * Assertion made after a turn's events have replayed.
 * @typedef {Object} TurnExpectation
 * @property {WorkflowGate} [gate]                Expected `workflowGate` after this turn.
 * @property {boolean} [notStuck]                 When true, assert `isUserStuck(stateAfter) === false`.
 * @property {(ctx: TurnResult) => void} [assert] Free-form assertion callback.
 */

/**
 * What a single turn produced: every hook subprocess result it ran, the task
 * state as it stood at the end of the turn, and the gate that state names.
 * @typedef {Object} TurnResult
 * @property {string} prompt                                                    The turn's prompt.
 * @property {{ script: string, status: number, stdout: string, stderr: string }[]} hookOutputs
 *   Every hook invocation for every event this turn fired, in order.
 * @property {TaskState|null} stateAfter                                        Persisted task state, or null.
 * @property {WorkflowGate|null} gate                                           `stateAfter.workflowGate`, or null.
 */

/**
 * Replay a full scripted session turn-by-turn through the real hooks, stamping a
 * deterministic clock on every event this driver builds, and return one
 * {@link TurnResult} per turn. A `SessionStart` is fired once up front so the
 * session bootstraps its own task.json — nothing is pre-seeded.
 *
 * The injected clock governs the timestamps/ids the harness stamps on its
 * payloads (so a script replays byte-identically); a hook's own `new Date()`
 * for its trace `ts` runs inside the subprocess and is out of the harness's
 * reach — honestly, not injected.
 *
 * When a turn carries `expect`, its assertions run against that turn's result
 * before the next turn begins, so a failure points at the exact turn.
 *
 * @param {Turn[]} turns
 * @param {{ hostCwd: string, root: string, now?: () => string }} opts
 * @returns {Promise<TurnResult[]>}
 */
export async function runSession(turns, opts) {
  const { hostCwd, root } = opts;
  const now = opts.now ?? (() => DEFAULT_CLOCK);

  // Bootstrap: SessionStart writes task.json (scripts/session-start.mjs). Nothing
  // under state/ is seeded — the session must create its own.
  replaySession(
    [{ hook_event_name: 'SessionStart', session_id: DEFAULT_SESSION_ID, source: 'new', timestamp: now() }],
    hostCwd,
  );

  /** @type {TurnResult[]} */
  // @bounded-alloc — one entry per scripted turn.
  const results = [];

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    /** @type {Record<string, unknown>[]} */
    // @bounded-alloc — prompt + a few events per tool step in a single turn.
    const events = [{ hook_event_name: 'UserPromptSubmit', session_id: DEFAULT_SESSION_ID, prompt: turn.prompt, timestamp: now() }];

    const tools = turn.tools ?? [];
    for (let s = 0; s < tools.length; s++) {
      const step = tools[s];
      const agentId = `toolu_t${t}s${s}`;
      const toolUseId = `${agentId}__vscode-1`;

      if (step.subagentReturn !== undefined) {
        // A subagent dispatch+return: SubagentStart names the agent (the host's
        // identity channel), the PostToolUse carries its contract, SubagentStop
        // closes it — the exact trio a real dispatch emits.
        events.push({
          hook_event_name: 'SubagentStart',
          session_id: DEFAULT_SESSION_ID,
          agent_id: agentId,
          agent_type: step.toolName,
          timestamp: now(),
        });
        events.push(subagentReturnPayload(step.toolName, step.subagentReturn, { toolUseId }));
        events.push({
          hook_event_name: 'SubagentStop',
          session_id: DEFAULT_SESSION_ID,
          agent_id: agentId,
          agent_type: step.toolName,
          timestamp: now(),
        });
      } else {
        // An ordinary tool call: the PreToolUse/PostToolUse pair the host fires.
        const toolInput = step.toolInput ?? {};
        events.push({
          hook_event_name: 'PreToolUse',
          session_id: DEFAULT_SESSION_ID,
          tool_name: step.toolName,
          tool_input: toolInput,
          tool_use_id: toolUseId,
          timestamp: now(),
        });
        events.push({
          hook_event_name: 'PostToolUse',
          session_id: DEFAULT_SESSION_ID,
          tool_name: step.toolName,
          tool_input: toolInput,
          tool_response: '',
          tool_use_id: toolUseId,
          timestamp: now(),
        });
      }
    }

    const hookOutputs = replaySession(events, hostCwd);
    const stateAfter = readStateOrNull(root);
    /** @type {TurnResult} */
    const result = {
      prompt: turn.prompt,
      hookOutputs,
      stateAfter,
      gate: stateAfter ? /** @type {WorkflowGate} */ (stateAfter.workflowGate) : null,
    };
    results.push(result);

    if (turn.expect) applyTurnExpectation(turn.expect, result);
  }

  return results;
}

/**
 * Apply a {@link TurnExpectation} to a {@link TurnResult}, failing the test at
 * the exact turn when it does not hold.
 * @param {TurnExpectation} expect
 * @param {TurnResult} result
 * @returns {void}
 */
function applyTurnExpectation(expect, result) {
  if (expect.gate !== undefined) {
    assert.equal(
      result.gate,
      expect.gate,
      `after turn "${result.prompt}": expected gate ${expect.gate}, got ${result.gate}\n` +
        result.hookOutputs.map((r) => `  [${r.script}] ${r.stdout}${r.stderr}`).join('\n'),
    );
  }
  if (expect.notStuck) {
    assert.ok(result.stateAfter, `after turn "${result.prompt}": no task state to check for stuck-ness`);
    assert.equal(
      isUserStuck(result.stateAfter),
      false,
      `after turn "${result.prompt}": the user is stuck at gate ${result.gate} — no runtime caller can advance it`,
    );
  }
  if (expect.assert) expect.assert(result);
}
