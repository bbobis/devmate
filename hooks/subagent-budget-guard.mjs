// @ts-check

/**
 * E13-4: Sub-agent budget guard.
 *
 * Registered under the official VS Code SubagentStart and SubagentStop hook
 * events (see https://code.visualstudio.com/docs/copilot/customization/hooks).
 *
 * On SubagentStart the guard reads the persisted activeSubagents count from
 * task.json, compares it to devmate.config.json maxConcurrentAgents (default
 * 3), and either denies the start or persists an incremented count plus a
 * subagent_start trace event. On SubagentStop the guard decrements the count
 * (floored at 0) and appends a subagent_complete trace event with the
 * sub-agent's run duration.
 *
 * The two handlers are pure side-effecting functions over the file system.
 * Tests call them directly with a tmp repo root; the registered hook script
 * (a separate entrypoint, not in this file) is responsible for wiring stdin.
 *
 * Direct function imports per the user preference: no CLI wrappers.
 */

import { resolve } from "node:path";
import { loadDevmateConfig } from "../lib/config/devmate-config.mjs";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { readTextFileSync } from "../lib/fs-safe.mjs";
import {
  EXIT_BLOCK,
  EXIT_OK,
  stopProcessingOutput,
} from "../lib/hooks/output-schema.mjs";
import { recordSubagentStart } from "../lib/hooks/subagent-index.mjs";
import { isDevmateAgentType } from "../lib/agents/roster.mjs";
import { markDevmateSession } from "../lib/hooks/session-marker.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { mutateTaskStateUnderLock, readTaskState } from "../lib/task-state.mjs";
import { appendTraceEvent } from "../lib/trace/append.mjs";
import {
  isImplementationDispatch,
  evaluateImplementationDispatch,
} from "../lib/workflow/dispatch-gate.mjs";
import { normalizeLane } from "../lib/workflow/orchestrator.mjs";
import { readScopeForTask } from "../lib/workflow/scope.mjs";
import { validateDiagnosisResult } from "../lib/workflow/bug-handoff.mjs";

/** @typedef {import('../lib/types.mjs').SubagentStartEvent} SubagentStartEvent */
/** @typedef {import('../lib/types.mjs').SubagentStopEvent} SubagentStopEvent */
/** @typedef {import('../lib/types.mjs').SubagentBudgetResult} SubagentBudgetResult */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../lib/types.mjs').ActiveAgentEntry} ActiveAgentEntry */

/**
 * Add a sub-agent to the in-flight roster, keyed by the host's `agent_id` so two
 * concurrent dispatches of the same agent are two entries (and one stop removes
 * one of them). A repeated id replaces its entry rather than duplicating it.
 * @param {readonly ActiveAgentEntry[]} roster
 * @param {ActiveAgentEntry} entry
 * @returns {ActiveAgentEntry[]}
 */
export function addActiveAgent(roster, entry) {
  // A payload carrying neither agent_type nor agent_id leaves us with no name.
  // Stamping it would write an entry task-state validation rejects — throwing
  // inside the hook and losing the whole start write, concurrency count included.
  // Record nothing instead: an unnamed agent has no identity, and no identity is
  // already the deny-by-default case in the guard.
  if (entry.agentName === '') return roster.slice();
  const kept =
    entry.agentId === ''
      ? roster.slice()
      : roster.filter((e) => e.agentId !== entry.agentId);
  kept.push(entry);
  return kept;
}

/**
 * Remove a sub-agent from the in-flight roster. Prefers the host's `agent_id`;
 * falls back to dropping ONE entry with the same name when the stop payload
 * carried no id, so a missing id leaks at most one stale entry instead of
 * clearing every instance of that agent.
 * @param {readonly ActiveAgentEntry[]} roster
 * @param {ActiveAgentEntry} entry
 * @returns {ActiveAgentEntry[]}
 */
export function removeActiveAgent(roster, entry) {
  const index =
    entry.agentId !== ''
      ? roster.findIndex((e) => e.agentId === entry.agentId)
      : roster.findIndex((e) => e.agentName === entry.agentName);
  if (index === -1) return roster.slice();
  return [...roster.slice(0, index), ...roster.slice(index + 1)];
}

/** Default sub-agent concurrency cap when devmate.config.json omits the field. */
// TODO: calibrate via the "Calibrating the ceilings" decision rule in
// docs/parallel-dispatch.md (FO-8, issue #17): change this value only with a
// fanout-report snapshot that satisfies the rule, recorded in the CHANGELOG.
export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;

/**
 * Resolve the effective maxConcurrentAgents from devmate.config.json at the
 * given repo root. Falls back to DEFAULT_MAX_CONCURRENT_AGENTS when the
 * config is missing, malformed, or omits the field.
 * @param {string} repoRoot
 * @returns {number}
 */
function resolveMaxConcurrentAgents(repoRoot) {
  const configPath = resolve(repoRoot, ".devmate/devmate.config.json");
  const result = loadDevmateConfig(configPath);
  if (!result.ok) return DEFAULT_MAX_CONCURRENT_AGENTS;
  const mca = result.config.maxConcurrentAgents;
  if (typeof mca === "number" && Number.isInteger(mca) && mca >= 1) return mca;
  return DEFAULT_MAX_CONCURRENT_AGENTS;
}

/**
 * Read and validate .devmate/state/diagnosis.json under a repo root for the
 * lane-gated dispatch check. Returns false on any read/parse/validation
 * failure — never throws.
 *
 * The `taskId` check is the point of the second argument. This gate is what
 * enforces diagnose-before-fix, and it used to ask only "is there a well-formed
 * diagnosis.json on disk?" — a question a LEFTOVER diagnosis from a previous task
 * answers just as well as a real one. Nothing deletes these files between tasks, so
 * a stale diagnosis silently authorized an implementation dispatch for a bug it had
 * never looked at. The fix must be bounded by a diagnosis of THIS bug.
 *
 * @param {string} repoRoot
 * @param {string} taskId  The task the dispatch belongs to.
 * @returns {boolean}
 */
function readDiagnosisValid(repoRoot, taskId) {
  try {
    const raw = readTextFileSync(resolve(repoRoot, ".devmate/state/diagnosis.json"));
    const parsed = JSON.parse(raw);
    if (!validateDiagnosisResult(parsed).ok) return false;
    return parsed?.taskId === taskId;
  } catch (_err) {
    return false;
  }
}

/**
 * Resolve the absolute task.json path under a given repo root.
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveStatePath(repoRoot) {
  return resolve(repoRoot, ".devmate/state/task.json");
}

/**
 * SubagentStart hook. Increments activeSubagents in task.json.
 * Denies start if the next count would exceed maxConcurrentAgents.
 *
 * Append-trace and persist behaviour:
 *   - Missing task.json (pre-spec, file not found): fails OPEN — allows the
 *     start at count 0, appends a subagent_start trace event (so the dispatch
 *     floor stays enforceable), and mutates no state. A malformed/invalid
 *     task.json still fails closed with a deny.
 *   - On deny: no state mutation, no trace event, returns the typed deny payload.
 *   - On allow: increments activeSubagents in task.json, appends a
 *     subagent_start trace event, returns the typed allow payload.
 *
 * @param {SubagentStartEvent} event
 * @returns {Promise<SubagentBudgetResult>}
 */
export async function handleSubagentStart(event) {
  const statePath = resolveStatePath(event.repoRoot);
  const stateResult = readTaskState(statePath);

  // HITL-1: lane-gated implementation dispatch (SubagentStart layer). An
  // implementation agent (fullstack + persona wrappers) may only start once the
  // lane's gate and artifacts exist; a missing task.json denies here — unlike the
  // analysis fail-open below — because an implementation dispatch means a gated
  // lane must already be in flight. Fails open when the agent name is absent or
  // 'unknown' (isImplementationDispatch → false), so analysis dispatches keep the
  // fail-open. The PreToolUse gate-guard is the independent first layer.
  if (isImplementationDispatch(event.agentName)) {
    // taskId comes from state or nowhere: no host sends one in the payload, and
    // an implementation dispatch without a task is exactly what the verdict
    // below denies.
    const taskId = stateResult.ok ? stateResult.state.taskId : null;
    const parsedScope = taskId
      ? await readScopeForTask(taskId, { repoRoot: event.repoRoot }).catch(() => null)
      : null;
    const scope = { present: parsedScope != null, nonEmpty: parsedScope != null };
    const lane = stateResult.ok ? normalizeLane(stateResult.state.lane) : "";
    const diagnosisValid =
      lane === "bug" && taskId !== null ? readDiagnosisValid(event.repoRoot, taskId) : false;
    const verdict = evaluateImplementationDispatch({
      agentName: event.agentName,
      stateResult,
      scope,
      diagnosisValid,
    });
    if (verdict.decision === "denied") {
      return { decision: "denied", activeCount: 0, reason: verdict.reason };
    }
  }

  if (!stateResult.ok) {
    // Fail OPEN when task.json does not exist yet. The concurrency budget is
    // meaningless before a task is initialized, and the pre-spec analysis phase
    // (discovery -> tech-design -> grill -> plan) — exactly when the
    // orchestrator most needs to delegate — runs before init-task-state creates
    // task.json. Denying here forced that analysis inline (the reported bug).
    // A malformed or invalid task.json still fails CLOSED.
    //
    // No trace event here. With no task there is no real taskId to file it
    // under; the old code minted one from the literal "unknown", which created
    // `unknown.jsonl` — a file no reader (dispatch floor, corroboration,
    // view-trace --task) ever consults, since they all key on the real id from
    // task.json. Recording it bought nothing and produced junk state (#76).
    const firstError = stateResult.errors[0] ?? "";
    if (firstError.startsWith("State file not found:")) {
      return { decision: "allowed", activeCount: 0 };
    }
    return {
      decision: "denied",
      activeCount: 0,
      reason: `task.json unreadable: ${stateResult.errors.join("; ")}`,
    };
  }

  const state = stateResult.state;
  const max = resolveMaxConcurrentAgents(event.repoRoot);

  // #189: check-and-increment ATOMICALLY on the fresh in-lock state, so two
  // concurrent SubagentStarts cannot both clear the ceiling on a stale count and
  // over-admit — and the identity stamp cannot clobber a concurrent gate advance.
  // #93: stamp the identity the host DID give us (`agent_type`, captured at
  // SubagentStart) so the gate-guard's session-artifact rule has an `activeAgent`
  // to read — PreToolUse carries no agent name of its own.
  /** @type {number} */
  let nextCount = 0;
  let denied = false;
  const outcome = await mutateTaskStateUnderLock(
    (fresh) => {
      const current =
        typeof fresh.activeSubagents === "number" ? fresh.activeSubagents : 0;
      if (current >= max) {
        denied = true;
        nextCount = current;
        return null; // deny → no write
      }
      nextCount = current + 1;
      return {
        ...fresh,
        activeSubagents: nextCount,
        activeAgents: addActiveAgent(fresh.activeAgents ?? [], {
          agentName: event.agentName,
          agentId: event.agentId ?? '',
        }),
      };
    },
    statePath,
    { event: "subagent-start" },
  );
  if (denied) {
    return {
      decision: "denied",
      activeCount: nextCount,
      reason: `maxConcurrentAgents (${max}) reached`,
    };
  }
  if (!outcome.ok) {
    // #189: mutateTaskStateUnderLock is non-throwing (the old writeTaskState threw).
    // Surface the persistence failure instead of swallowing it, and skip the trace
    // — nothing was written, so a subagent_start event would carry a bogus count.
    // Fail OPEN (the guard's deliberate stance) so a lifecycle event never crashes
    // the session.
    process.stderr.write(
      `${JSON.stringify({ event: "subagent-start.persist_failed", reason: outcome.error })}\n`,
    );
    return { decision: "allowed", activeCount: nextCount };
  }

  // taskId comes from the state file, the only source that holds it — the wire
  // payload carries none. So the event lands in the REAL task's trace file, where
  // the dispatch floor and corroboration actually look.
  //
  // `persona` stays empty in production, and now says so honestly. It used to read
  // `state.activePersona`, a field NOTHING ever wrote — so the trace recorded ''
  // while looking like it recorded a persona (#99). No host event carries a
  // persona; the only one that reaches devmate arrives at completion, on the
  // worker's own returned contract (hooks/post-tool-use.mjs).
  await appendTraceEvent(
    {
      type: "subagent_start",
      taskId: state.taskId,
      stepId: `subagent-${event.agentName}`,
      ts: new Date().toISOString(),
      schemaVersion: 1,
      agentName: event.agentName,
      persona: event.persona ?? "",
      activeCount: nextCount,
    },
    { root: event.repoRoot },
  );

  return { decision: "allowed", activeCount: nextCount };
}

/**
 * SubagentStop hook. Decrements activeSubagents in task.json (floored at 0)
 * and appends a subagent_complete trace event. Returns the post-decrement
 * count for callers that want to observe the floor behaviour.
 *
 * The hook never throws on a missing task.json — sub-agent lifecycle events
 * must not bring down the host session — but it returns 0 in that case.
 *
 * @param {SubagentStopEvent} event
 * @returns {Promise<{ activeCount: number }>}
 */
export async function handleSubagentStop(event) {
  const statePath = resolveStatePath(event.repoRoot);
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    return { activeCount: 0 };
  }

  const state = stateResult.state;
  // #189: atomic decrement-and-deregister on the fresh in-lock state (floored at
  // 0), so a concurrent start's increment is not lost and a gate advance is not
  // clobbered.
  /** @type {number} */
  let nextCount = 0;
  const outcome = await mutateTaskStateUnderLock(
    (fresh) => {
      const current =
        typeof fresh.activeSubagents === "number" ? fresh.activeSubagents : 0;
      nextCount = current > 0 ? current - 1 : 0;
      return {
        ...fresh,
        activeSubagents: nextCount,
        activeAgents: removeActiveAgent(fresh.activeAgents ?? [], {
          agentName: event.agentName,
          agentId: event.agentId ?? '',
        }),
      };
    },
    statePath,
    { event: "subagent-stop" },
  );
  if (!outcome.ok) {
    // #189: surface a persistence failure (non-throwing API) and skip the trace.
    process.stderr.write(
      `${JSON.stringify({ event: "subagent-stop.persist_failed", reason: outcome.error })}\n`,
    );
    return { activeCount: nextCount };
  }

  await appendTraceEvent(
    {
      type: "subagent_complete",
      taskId: state.taskId,
      stepId: `subagent-${event.agentName}`,
      ts: new Date().toISOString(),
      schemaVersion: 1,
      agentName: event.agentName,
      persona: event.persona ?? "",
      // VS Code's SubagentStop payload carries no duration field; 0 records
      // "not provided by the host" rather than a measurement. Tests may inject
      // a real value via the internal event.
      durationMs: event.durationMs ?? 0,
      activeCount: nextCount,
    },
    { root: event.repoRoot },
  );

  return { activeCount: nextCount };
}

/**
 * Read the entire stdin stream to a UTF-8 string.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
function readAll(stream) {
  return new Promise((resolveStream, rejectStream) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on("data", (/** @type {Buffer|string} */ chunk) => {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    stream.on("end", () =>
      resolveStream(Buffer.concat(chunks).toString("utf8")),
    );
    stream.on("error", rejectStream);
  });
}

/**
 * Entrypoint dispatcher. The first CLI arg selects which handler to run
 * (`start` or `stop`) so a single registered hook script can serve both
 * SubagentStart and SubagentStop entries in hooks.json. Reads a JSON event
 * payload from stdin and emits the typed result to stdout. A best-effort
 * audit: errors never bring down the host session (exit 0).
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const mode = args[0];
  if (mode !== "start" && mode !== "stop") {
    process.stderr.write(
      "[subagent-budget-guard] usage: subagent-budget-guard.mjs [start|stop]\n",
    );
    return 0;
  }

  let raw = "";
  try {
    raw = await readAll(process.stdin);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[subagent-budget-guard] stdin error (ignored): ${msg}\n`,
    );
    return 0;
  }

  if (raw.trim() === "") {
    return 0;
  }

  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[subagent-budget-guard] malformed JSON (ignored): ${msg}\n`,
    );
    return 0;
  }

  if (payload === null || typeof payload !== "object") {
    return 0;
  }
  const p = /** @type {Record<string, unknown>} */ (payload);

  // Read only fields a host actually sends. The old parser read
  // `repoRoot`/`taskId`/`agentName`/`persona` — devmate-invented keys that are
  // in NO host's SubagentStart payload — so every one always took its fallback:
  // repoRoot became raw process.cwd() (the workspace's own .devmate/ folder when
  // it is workspaceFolders[0]), and taskId/agentName became the literal
  // "unknown". Net effect: every dispatch traced to
  // `.devmate/.devmate/state/trace/unknown.jsonl`, and HITL-1's SubagentStart
  // layer never evaluated because isImplementationDispatch("unknown") is false
  // by design (#76).
  //
  // Root: from `cwd` (documented, optional) via resolveHookRoot, which climbs
  // out of a `.devmate/` cwd and walks to the nearest repo marker.
  // Identity: VS Code sends `agent_type` (the agent name, e.g. "fullstack")
  // plus an `agent_id` instance identifier. devmate targets VS Code only, but
  // `agent_id` is kept as a last-resort identifier rather than degrading to a
  // sentinel string.
  // taskId: NOT parsed — the handlers derive it from the task.json they
  // already read, which is the only honest source.
  const repoRoot = resolveHookRoot(/** @type {{ cwd?: string }} */ (p));
  const agentId = typeof p["agent_id"] === "string" ? p["agent_id"] : "";
  const rawAgentType = typeof p["agent_type"] === "string" ? p["agent_type"] : "";
  const agentName = rawAgentType !== "" ? rawAgentType : agentId;

  // Runtime scope: this hook fires for EVERY subagent in EVERY session —
  // including another plugin's. Act ONLY for devmate's own agents; anything else
  // (an unknown agent_type, another plugin's subagent) leaves the guard inert so
  // it can never meter or deny a dispatch that isn't devmate's. The `agent_type`
  // is the one moment agent identity is on the wire, so this is also where a
  // session is FIRST recognized as devmate: a devmate SubagentStart drops the
  // session marker that flips gate-guard and the PostToolUse validators from
  // inert to enforcing for the remainder of the session (lib/hooks/session-marker.mjs).
  if (!isDevmateAgentType(rawAgentType)) return EXIT_OK;
  if (mode === "start") {
    const sessionId = typeof p["session_id"] === "string" ? p["session_id"] : undefined;
    markDevmateSession(sessionId, rawAgentType);
  }

  try {
    if (mode === "start") {
      // Write down who this dispatch IS, while the wire still says so. This is the
      // only event that carries the agent's name, and `agent_id` is the parent link
      // to the completion that will come back later (its `tool_use_id` is this id
      // plus a host suffix). Without this note, attribution at completion time falls
      // back to whatever the model remembered to write about itself — and a return
      // it forgot to sign was thrown away in silence.
      //
      // Best-effort: a failure here degrades attribution, and must never deny a
      // dispatch that the guard itself would have allowed.
      if (agentId !== "" && typeof p["agent_type"] === "string" && p["agent_type"] !== "") {
        await recordSubagentStart(repoRoot, {
          agentId,
          agentType: /** @type {string} */ (p["agent_type"]),
        }).catch(() => {});
      }

      const result = await handleSubagentStart({ agentName, agentId, repoRoot });
      if (result.decision !== "denied") return EXIT_OK;

      // SubagentStart is the one blocking gate VS Code documents NO blocking
      // field for: its hookSpecificOutput carries additionalContext and nothing
      // else. devmate emitted `{"decision":"denied"}` — a key the host does not
      // read on this event, with a value ("denied") that is not in its
      // vocabulary anywhere — and exited 0. So HITL-1's SubagentStart layer
      // computed a correct deny and then threw it away, every time (#77).
      //
      // Both documented stops are used, deliberately: `continue: false` in the
      // common output format, and exit 2 ("blocking error: stop processing"),
      // whose stderr is the channel that reaches the model. That is not hedging
      // — it is what fail-closed means when the host gives you two mechanisms
      // and names neither as the one for this event. Every path here ends in
      // "blocked"; none ends in "silently allowed".
      const reason = result.reason ?? "subagent dispatch denied";
      process.stdout.write(JSON.stringify(stopProcessingOutput(reason)) + "\n");
      process.stderr.write(`[subagent-budget-guard] ${reason}\n`);
      return EXIT_BLOCK;
    }
    // SubagentStop cannot deny — the agent has already run. Its result is
    // bookkeeping (the concurrency count), which the host has no field for, so
    // it goes to stderr and stdout stays empty.
    const result = await handleSubagentStop({ agentName, agentId, repoRoot });
    process.stderr.write(
      `${JSON.stringify({ event: "subagent.stop", activeCount: result.activeCount })}\n`,
    );
    return EXIT_OK;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[subagent-budget-guard] handler error (ignored): ${msg}\n`,
    );
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
