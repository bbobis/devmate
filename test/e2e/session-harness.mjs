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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookManifest, extractScriptPath } from '../../lib/hooks/registry.mjs';
import { getOwn } from '../../lib/object-utils.mjs';
import { readJsonlSync } from '../../lib/json-io.mjs';
import { markDevmateSession } from '../../lib/hooks/session-marker.mjs';
import { TRANSITIONS, STEERING } from '../../lib/gate-transitions.mjs';

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
 * Canonical session id for the default test session — derived from the captured
 * fixture (`test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json`),
 * so the harness payloads and the fixture share one id.
 */
export const DEFAULT_SESSION_ID = 'fd634936-8166-4295-a74f-2a397c9c5226';

/** Frozen wall-clock timestamp for deterministic test payloads. */
export const DEFAULT_CLOCK = '2026-01-01T00:00:00.000Z';

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
  // These E2E suites simulate ACTIVE devmate sessions, so enforcement must be
  // live. In a real session the marker is set by the first devmate
  // SubagentStart; here we mark the payload's session up front so every spawned
  // hook runs in a devmate-scoped session (a hook that no longer enforces
  // because of runtime scoping cannot then hide behind an unmarked session).
  const sid = getOwn(/** @type {Record<string, unknown>} */ (payload ?? {}), 'session_id');
  if (typeof sid === 'string' && sid !== '') markDevmateSession(sid, 'router');
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
 * A `runSubagent` PostToolUse payload in the host's captured shape (prose then
 * embedded JSON), matching
 * `test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json` key-for-key:
 * `tool_input` is the elided literal, and `tool_response` is the agent's chat
 * text — prose followed by the embedded JSON contract, which is exactly where
 * the gate-advance hook reads the agent's identity and result from.
 *
 * The `agentName` argument is the default identity embedded in the JSON;
 * a matching key inside `returnBody` overrides it (so a self-identifying body
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
  const toolUseId = opts.toolUseId ?? `toolu_${agentName}__vscode-1783942732395`;
  const embedded = { agentName, ...(/** @type {any} */ (returnBody)) };
  return {
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
 * Fire the real SessionStart hook over an EXISTING workspace — a "second
 * session over the same workspace" (issue #7): a chat fork, an overnight
 * restart, or a post-compaction resume all begin exactly this way. Nothing is
 * reset by the harness; whatever the hook does to the durable state IS the
 * behavior under test.
 * @param {string} hostCwd    The workspace's own `.devmate/` folder.
 * @param {string} sessionId  Host session id for the new session.
 * @param {{ source?: string }} [opts]  SessionStart `source` (default 'new').
 * @returns {{ script: string, status: number, stdout: string, stderr: string }[]}
 */
export function startSession(hostCwd, sessionId, opts = {}) {
  return replaySession(
    [{ hook_event_name: 'SessionStart', session_id: sessionId, source: opts.source ?? 'new' }],
    hostCwd,
  );
}

// ---------------------------------------------------------------------------
// #131: a scripted-turn driver (`runSession`) and a stuck-state assertion
// helper (`isUserStuck`) on top of the primitives above. The invariant this
// whole epic protects — after any turn EITHER the gate advanced OR the model
// was told why not — needs an assertion, and every scenario issue needs to
// drive real turns without hand-assembling each payload.
// ---------------------------------------------------------------------------

/**
 * The gate events some REAL runtime caller actually fires, keyed BY LANE — because
 * fireability is still lane-specific for steering: `revise-scope`/`re-plan` fire
 * only on the feature lane (`steerFeature` throws for any other lane,
 * `lib/workflow/lanes/feature.mjs`), reached from the approval listener. Crediting
 * a feature-only event to the wrong lane is the "looks-fireable-isn't" false-negative
 * this helper exists to catch.
 *
 * `pass-verification` is now fired by the gate-advance hook on EVERY lane: #132 put
 * it in `LANE_CHAINS` for all three, so the hook advances `impl-started →
 * verification-passed` once the verify precondition holds. Before #132 it was in no
 * chain and its only firer (`runChoreLane`, reached from tests only — never a hook
 * or script) never ran at runtime, so a feature or bug task dead-ended at
 * `impl-started` — the false-negative that lane-scoping caught, now fixed at the source.
 *
 * Re-derive per lane with a grep over the runtime surface for every event handed
 * to a gate mover, plus the chain the gate-advance hook walks:
 *
 *   grep -rnE '(transitionGate|advanceGate|advanceAlongLane|steerFeature)\(' hooks lib/workflow
 *   # then read LANE_CHAINS in lib/workflow/gate-advance.mjs for the spine events
 *
 * A listed-but-uncalled event is deliberately ABSENT from every lane: `mark-pr-ready`
 * and `complete` (verification-passed/pr-ready advance by the "approve pr" phrase or
 * the chore lane's verified terminal — no hook fires these events), `approve-plan`
 * (the phrase fires `start-impl`, not this vestigial event), and
 * `new-requirements` / `park` / `resume` / `abandon` (fired only by the gatectl CLI,
 * a manual recovery tool). Encoded as a maintained constant, not a live grep, for
 * determinism (CONTRIBUTING §4).
 * @type {Readonly<Record<Lane, ReadonlySet<GateEvent>>>}
 */
export const RUNTIME_FIREABLE_EVENTS = Object.freeze(/** @type {Record<Lane, ReadonlySet<GateEvent>>} */ ({
  // LANE_CHAINS[feature] (gate-advance hook, incl. #132's `pass-verification`) +
  // the approve-spec continuation (`start-impl`) + the approval listener's
  // steerFeature (#127).
  feature: new Set(/** @type {GateEvent[]} */ ([
    'set-lane', 'finish-discovery', 'finish-grill', 'finish-plan', 'draft-spec',
    'start-impl', 'pass-verification', 'revise-scope', 're-plan',
  ])),
  // LANE_CHAINS[bug] (incl. #132's `pass-verification`) + the approve-plan
  // continuation (`start-impl`). No steering (feature-only).
  bug: new Set(/** @type {GateEvent[]} */ ([
    'set-lane', 'finish-grill', 'present-plan', 'start-impl', 'pass-verification',
  ])),
  // LANE_CHAINS[chore] (mechanical, incl. `start-impl` and #132's `pass-verification`).
  chore: new Set(/** @type {GateEvent[]} */ ([
    'set-lane', 'present-plan', 'start-impl', 'pass-verification',
  ])),
}));

/**
 * Gates where a task is at a LEGITIMATE rest, so it is never "stuck" even though
 * the event intersection finds no runtime-fireable exit:
 *   - `done` / `abandoned` : terminal — a legitimate end, not a dead end.
 *   - `parked`             : a deliberate pause; `resume` (the gatectl recovery
 *                            CLI, or a fresh session) is the way back.
 *   - `spec-draft`         : the "approve spec" / "revise spec:" human gate —
 *                            advanced by a phrase through `advanceHumanGate`,
 *                            which carries no GateEvent, so the event check
 *                            cannot see it.
 *   - `verification-passed`: the "approve pr" human gate on feature/bug, and the
 *                            chore lane's verified terminal (its verified rest;
 *                            only the CLI walks it to `done`).
 *   - `pr-ready`           : the PR is ready — the workflow has succeeded. Only
 *                            the vestigial `complete` (CLI-only) remains, so the
 *                            user is finished here, never wedged.
 * @type {ReadonlySet<WorkflowGate>}
 */
const RESTING_GATES = new Set(/** @type {WorkflowGate[]} */ ([
  'done', 'abandoned', 'parked', 'spec-draft', 'verification-passed', 'pr-ready',
]));

/**
 * Every gate EVENT legal from (lane, gate): the lane-owned events keyed in
 * {@link TRANSITIONS} unioned with the lane-agnostic {@link STEERING} events.
 * Distinct from `legalTransitions()`, which returns the target GATES — the stuck
 * check needs the EVENT names, to intersect with the runtime-fireable allowlist.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {GateEvent[]}
 */
function legalEventsFrom(lane, gate) {
  /** @type {GateEvent[]} */
  // @bounded-alloc — the events keyed at one gate across two frozen tables (< 10).
  const events = [];
  const laneTable = getOwn(TRANSITIONS, lane);
  const gateTable = laneTable ? getOwn(laneTable, gate) : undefined;
  if (gateTable) events.push(.../** @type {GateEvent[]} */ (Object.keys(gateTable)));
  const steerTable = getOwn(STEERING, gate);
  if (steerTable) events.push(.../** @type {GateEvent[]} */ (Object.keys(steerTable)));
  return events;
}

/**
 * True when, from the CURRENT persisted task state, no legal event is fireable by
 * any real runtime caller ON THIS LANE and the task is not at a legitimate resting
 * gate — i.e. the user has no path forward.
 *
 * "Fireable" is the lane's legal events ({@link legalEventsFrom}, derived from
 * lib/gate-transitions.mjs) INTERSECTED with the lane's slice of
 * {@link RUNTIME_FIREABLE_EVENTS}, so an event legal in the table but that no
 * caller on THIS lane invokes does NOT count. That intersection is the check that
 * caught two dead-ends this epic closed: `revise-scope`/`re-plan` legal at feature
 * `impl-started` but with no caller (before #127 wired the steering), and the
 * forward `pass-verification` legal at every `impl-started` but fired by nothing
 * at runtime (before #132 put it in every LANE_CHAIN — its only firer,
 * `runChoreLane`, is reached from tests only). Pass a flat `opts.fireableEvents`
 * to prove the verdict against a hand-built table; the {@link RESTING_GATES}
 * carve-outs never mask it.
 * @param {TaskState} state
 * @param {{ fireableEvents?: ReadonlySet<GateEvent>|GateEvent[] }} [opts]
 *        Inject a lane-independent allowlist that overrides the per-lane default.
 * @returns {boolean}
 */
export function isUserStuck(state, opts = {}) {
  const gate = /** @type {WorkflowGate} */ (state.workflowGate);
  if (RESTING_GATES.has(gate)) return false;
  const lane = /** @type {Lane} */ (state.lane);
  /** @type {ReadonlySet<GateEvent>} */
  const fireable =
    opts.fireableEvents === undefined
      ? getOwn(RUNTIME_FIREABLE_EVENTS, lane) ?? new Set()
      : opts.fireableEvents instanceof Set
        ? opts.fireableEvents
        : new Set(opts.fireableEvents);
  for (const event of legalEventsFrom(lane, gate)) {
    if (fireable.has(event)) return false;
  }
  return true;
}

/**
 * One turn in a scripted session: a user prompt, then zero or more tool-call /
 * subagent-return steps, in order.
 * @typedef {Object} Turn
 * @property {string} prompt        UserPromptSubmit prompt text.
 * @property {ToolStep[]} [tools]   Tool calls / subagent returns after the prompt, in order.
 */

/**
 * One tool step. With `subagentReturn`, it is a subagent dispatch whose typed
 * return is replayed as the full SubagentStart -> PostToolUse(return) ->
 * SubagentStop trio ({@link subagentDispatch}); `toolName` is then the AGENT name
 * (e.g. 'router', 'planner'). Without it, `toolName` is an ordinary tool driven
 * as a PreToolUse / PostToolUse pair.
 * @typedef {Object} ToolStep
 * @property {string} toolName
 * @property {Record<string, unknown>} [toolInput]
 * @property {unknown} [subagentReturn]
 */

/**
 * What one turn produced.
 * @typedef {Object} TurnResult
 * @property {string} prompt      The turn's prompt.
 * @property {{ script: string, status: number, stdout: string, stderr: string }[]} ran
 *           Every hook that ran this turn (prompt hooks + each tool step's hooks).
 * @property {TaskState|null} stateAfter  Persisted task state after the turn, or null if none exists yet.
 * @property {WorkflowGate|null} gate     `stateAfter.workflowGate`, or null.
 * @property {boolean} stuck              {@link isUserStuck}(stateAfter); false when there is no state.
 */

/**
 * Read the persisted task state if it exists, else null — before the bootstrap
 * SessionStart writes it, or in a torn state a scenario deliberately creates.
 * @param {string} root
 * @returns {TaskState|null}
 */
function readStateOrNull(root) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  if (!existsSync(statePath)) return null;
  try {
    return /** @type {TaskState} */ (JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Replay a scripted session turn-by-turn through the REAL hooks and return one
 * {@link TurnResult} per turn. Bootstraps its own task state with a SessionStart
 * (which also marks the session devmate-scoped, so enforcement is live), then for
 * each turn fires the UserPromptSubmit followed by its tool steps in order, and
 * reads the state that landed. Every payload the driver authors is stamped with
 * the injected clock (`opts.now`, default {@link DEFAULT_CLOCK}) so timestamp-based
 * assertions stay deterministic; hook-internal clocks are per-module and already
 * deterministic or injected.
 * @param {Turn[]} turns
 * @param {{ hostCwd: string, root: string, now?: () => string }} opts
 * @returns {Promise<TurnResult[]>}
 */
export async function runSession(turns, opts) {
  const { hostCwd, root } = opts;
  const now = opts.now ?? (() => DEFAULT_CLOCK);

  // Bootstrap: the first SessionStart writes task.json and marks the session.
  startSession(hostCwd, DEFAULT_SESSION_ID, { source: 'new' });

  /** @type {TurnResult[]} */
  // @bounded-alloc — one result per scripted turn.
  const results = [];
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    /** @type {Record<string, unknown>[]} */
    // @bounded-alloc — the events one turn authors (a prompt plus its tool steps).
    const events = [
      { hook_event_name: 'UserPromptSubmit', session_id: DEFAULT_SESSION_ID, prompt: turn.prompt, timestamp: now() },
    ];
    const steps = turn.tools ?? [];
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      if (step.subagentReturn !== undefined) {
        // Deterministic per-step agent id so its return links to its start.
        const agentId = `toolu_t${t}s${s}`;
        for (const ev of subagentDispatch(agentId, step.toolName, step.subagentReturn)) {
          events.push({ ...ev, timestamp: now() });
        }
      } else {
        events.push(
          { hook_event_name: 'PreToolUse', session_id: DEFAULT_SESSION_ID, tool_name: step.toolName, tool_input: step.toolInput ?? {}, timestamp: now() },
          { hook_event_name: 'PostToolUse', session_id: DEFAULT_SESSION_ID, tool_name: step.toolName, tool_input: step.toolInput ?? {}, tool_response: '', timestamp: now() },
        );
      }
    }

    const ran = replaySession(events, hostCwd);
    const stateAfter = readStateOrNull(root);
    results.push({
      prompt: turn.prompt,
      ran,
      stateAfter,
      gate: stateAfter ? /** @type {WorkflowGate} */ (stateAfter.workflowGate) : null,
      stuck: stateAfter ? isUserStuck(stateAfter) : false,
    });
  }
  return results;
}
