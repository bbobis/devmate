// @ts-check

/**
 * #91: PostToolUse hook that ADVANCES the workflow gate on observed evidence.
 *
 * Until this hook existed, nothing could. The pre-implementation spine
 * (`no-lane → lane-set → … → spec-draft` / `plan-approved`) had exactly one
 * writer — the `gatectl` CLI — and the orchestrator that owns gate state
 * declares no `execute` tool, so it could never run it. Every "advance the
 * gate" line in its prompt and both lane skills was unrunnable prose; the
 * `spec-integrity-guard` line that claimed a hook did it for you was simply
 * false (that hook only ever rolls BACK). So `bootstrapTaskState` seeded
 * `no-lane` and the gate stayed there for the life of every session — the human
 * spec gate unreachable, and `evaluateGuard` (which denied only at
 * `plan-approved`) waving every source edit straight through.
 *
 * What this hook does, on every PostToolUse:
 *
 *  1. If a subagent just returned, project its result onto the canonical
 *     artifact its gate precondition reads (`router-result.json`,
 *     `grill-result.json`, `critique-result.json`, `discovery-merged.json`).
 *     Those files had no writer at all: every analyst agent is read-only and
 *     cannot author its own evidence. The host is the only party that sees a
 *     return, so the hook is the only honest place to write it down.
 *  2. If `spec.md` is on disk, stamp `artifactHashes.spec` + `specDigest` —
 *     the metadata `spec-writer` is contracted to record but, holding only an
 *     `edit` tool, cannot compute.
 *  3. Walk the lane's chain as far as the evidence allows, and stop.
 *
 * Advancement is a pure function of what is on disk. A gate never moves because
 * an agent said the work happened — only because the artifact proving it landed.
 * Human gates are not in any chain: the feature lane stops at `spec-draft` and
 * the bug lane at `plan-approved`, awaiting the human phrase that
 * `hooks/approval-listener.mjs` handles.
 *
 * Doc reference (PostToolUse event name + stdout capture):
 *   https://code.visualstudio.com/docs/copilot/customization/hooks
 *
 * Best-effort by design: this is bookkeeping. It must never take down a session
 * or block a tool call — but it reports every failure on stderr, so it cannot
 * fail silently the way the layer it replaces did.
 */

import path from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { loadDevmateConfig } from '../lib/config/devmate-config.mjs';
import { getOwn } from '../lib/object-utils.mjs';
import { extractAgentResult } from '../lib/hooks/agent-result.mjs';
import { createTextCapture, EXIT_BLOCK, writeHookOutput } from '../lib/hooks/output-schema.mjs';
import { resolveAgentName } from '../lib/hooks/subagent-index.mjs';
import { readTaskState, STATE_PATH, writeTaskState } from '../lib/task-state.mjs';
import { injectFaultIfArmed } from '../lib/testing/fault-injection.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';
import { artifactsFor } from '../lib/workflow/agent-contracts.mjs';
import { persistWorkerReturn } from '../lib/workflow/persist-worker-return.mjs';
import {
  advanceAlongLane,
  projectWorkerReturn,
  stampSpecDigest,
  STATE_DIR,
} from '../lib/workflow/gate-advance.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../lib/types.mjs').Lane} Lane */
/** @typedef {import('../lib/workflow/gate-advance.mjs').GateMove} GateMove */

/** Trace schema version this hook emits. */
const SCHEMA_VERSION = 1;

/** Step id stamped on every trace event written by this hook. */
const STEP_ID = 'gate-advance';

/** Actor recorded on the gate transitions this hook makes. */
const HOOK_ACTOR = 'hook-evidence';

/**
 * The internal event the handler consumes — derived, never the wire payload.
 * Field names are devmate's: the host sends `tool_name` / `tool_response` /
 * `tool_use_id`, and only {@link eventFromPayload} may read those keys.
 *
 * @typedef {Object} GateAdvanceEvent
 * @property {string}  repoRoot     Absolute workspace root (from resolveHookRoot).
 * @property {string} [toolName]    Derived from the wire's `tool_name`.
 * @property {string} [toolResponse] Derived: a subagent's returned text, if any.
 * @property {string} [toolUseId]   Derived: unique per dispatch.
 */

/**
 * What the handler did — structured so tests assert on the decision, not on
 * printed text.
 * @typedef {Object} GateAdvanceResult
 * @property {'advanced'|'no_action'} action
 * @property {GateMove[]} moves        Gate moves made, in order.
 * @property {string|null} artifact    Canonical artifact projected this call, if any.
 * @property {string|null} blockedBy   The precondition that stopped the walk (the evidence boundary).
 * @property {string|null} alert       A dispatch produced no evidence — text the MODEL must be shown (exit 2).
 */

/**
 * Append a `gate_transition` trace event for one move, so the advance is
 * auditable and the actor is never mistaken for a human.
 * @param {string} taskId
 * @param {GateMove} move
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
async function recordGateTransition(taskId, move, repoRoot) {
  await appendTraceEvent(
    {
      type: 'gate_transition',
      taskId,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      from: move.from,
      to: move.to,
      gate: move.to,
      actor: HOOK_ACTOR,
      evidence: move.event,
    },
    { root: repoRoot },
  );
}

/**
 * Record that a grill or critique completed, in the trace the human reads.
 *
 * Best-effort: the audit trail is a record of the workflow, never a gate on it. A
 * trace that cannot be appended must not undo an artifact that landed.
 *
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {string} artifact  The artifact that was just written.
 * @param {Record<string, unknown>} result
 * @returns {Promise<void>}
 */
async function appendRubberDuckTrace(repoRoot, taskId, artifact, result) {
  const type =
    artifact === 'grill-result.json'
      ? 'grill_complete'
      : artifact === 'critique-result.json'
        ? 'critique_complete'
        : null;
  if (type === null) return;

  /** @param {string} key */
  const list = (key) => {
    const value = getOwn(result, key);
    return Array.isArray(value) ? value : [];
  };

  const event =
    type === 'grill_complete'
      ? {
          assumptions: list('assumptions'),
          edgeCases: list('edgeCases'),
          cornerCases: list('cornerCases'),
          blockingQuestions: list('blockingQuestions'),
        }
      : {
          verdict: typeof getOwn(result, 'verdict') === 'string' ? getOwn(result, 'verdict') : '',
          missingAcceptanceCriteria: list('missingAcceptanceCriteria'),
          missingTests: list('missingTests'),
        };

  try {
    await appendTraceEvent(
      /** @type {any} */ ({
        type,
        taskId,
        stepId: type,
        ts: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
        ...event,
      }),
      { root: repoRoot },
    );
  } catch (/** @type {any} */ err) {
    // A missing audit line is a smaller loss than a lost artifact — but it is still a
    // loss, and swallowing it without a word is the habit that produced this whole
    // class of bug. Say so.
    process.stderr.write(
      `${JSON.stringify({ event: 'gate-advance.trace_error', type, reason: String(err?.message ?? err) })}\n`,
    );
  }
}

/**
 * The message a model gets when a dispatch it made produced no evidence.
 *
 * It must carry four things, because leaving any one of them out is what made the
 * old diagnostic useless: WHO failed, WHICH file was therefore not written, WHY, and
 * WHAT TO DO. The last one matters most — an orchestrator that knows only "something
 * is missing" will invent a recovery, and the recovery it invented was to abandon
 * delegation and do the work in its own context.
 *
 * @param {{ agentName: string|null, gate: string, problem: string, reason: string }} failure
 * @returns {string}
 */
function evidenceFailure(failure) {
  const who = failure.agentName === null ? 'a subagent' : `@${failure.agentName}`;
  const expected = failure.agentName === null ? [] : artifactsFor(failure.agentName);
  const artifactText =
    expected.length === 0
      ? 'no artifact could be written'
      : `${expected.join(' / ')} was NOT written`;

  return (
    `[devmate] ${who} ${failure.problem}, so ${artifactText}.\n` +
    `  why: ${failure.reason}\n` +
    `  effect: the gate stays at "${failure.gate}" — it advances on artifacts, never on a dispatch having completed.\n` +
    `  do: re-dispatch ${who} and have it return the contract its card documents.\n` +
    `  do NOT: do this work inline, hand-write the artifact, or ask the human to approve past it. ` +
    `A hand-authored artifact fabricates the very evidence the gate exists to check.`
  );
}

/**
 * PostToolUse hook entry point.
 *
 * @param {GateAdvanceEvent} event
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [opts] Test seams.
 * @returns {Promise<GateAdvanceResult>}
 */
export async function handlePostToolUse(event, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const repoRoot = event.repoRoot;

  const statePath = path.join(repoRoot, STATE_PATH);
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    // No task yet (the pre-task window: chat/help before SessionStart bootstraps
    // state). Nothing to advance, and creating state here is not this hook's job.
    return { action: 'no_action', moves: [], artifact: null, blockedBy: null, alert: null };
  }

  /** @type {TaskState} */
  let state = stateResult.state;
  let dirty = false;
  /** @type {string|null} */
  let artifact = null;

  /** @type {string|null} */
  let alert = null;

  // 1. A subagent returned → persist it, then project it onto the artifact its
  //    gate precondition reads.
  if (event.toolName === 'runSubagent' && typeof event.toolResponse === 'string') {
    const extracted = extractAgentResult(event.toolResponse);

    // Identity comes from the HOST first (the SubagentStart index), and only then
    // from what the model wrote about itself. A worker that forgot to sign its
    // return used to become unattributable, and an unattributable return was
    // dropped — which is how a completed dispatch left no trace whatsoever.
    const agentName = resolveAgentName(repoRoot, event.toolUseId) ?? extracted.agentName;

    if (extracted.empty) {
      alert = evidenceFailure({
        agentName,
        gate: state.workflowGate,
        problem: 'returned no output at all',
        reason: 'the dispatch completed with an empty response',
      });
    } else if (extracted.result === null) {
      alert = evidenceFailure({
        agentName,
        gate: state.workflowGate,
        problem: 'returned prose with no contract in it',
        reason: 'no JSON object could be found in the reply',
      });
    } else if (agentName === null) {
      alert = evidenceFailure({
        agentName: null,
        gate: state.workflowGate,
        problem: 'returned a contract that names no agent',
        reason: 'the host saw no SubagentStart for this tool_use_id and the return carries no agentName',
      });
    } else {
      // Persisted here as well as in post-tool-use.mjs, and deliberately so:
      // hook execution order is not a guarantee any host makes, and the
      // discovery fan-in re-reads this directory. The write is keyed by
      // tool_use_id and byte-identical, so doing it twice is a no-op — whereas
      // depending on another hook having run first would be a race.
      if (typeof event.toolUseId === 'string' && event.toolUseId !== '') {
        try {
          await persistWorkerReturn(repoRoot, {
            agentName,
            toolUseId: event.toolUseId,
            result: extracted.result,
          });
        } catch (/** @type {any} */ err) {
          stderr.write(
            `${JSON.stringify({ event: 'gate-advance.persist_error', reason: String(err?.message ?? err) })}\n`,
          );
        }
      }

      try {
        // #92: the scope.md the planner/diagnose projections derive needs the
        // config's test-glob floor. A missing config is not fatal — the scope is
        // still written from the plan's own file list, just without the floor.
        const cfg = loadDevmateConfig(path.join(repoRoot, '.devmate', 'devmate.config.json'));
        const projected = await projectWorkerReturn(
          repoRoot,
          agentName,
          extracted.result,
          state,
          cfg.ok ? cfg.config : null,
          new Date().toISOString(),
        );
        artifact = projected.artifact;

        // The router is what makes the lane known. Until it has spoken, task
        // state carries a PLACEHOLDER lane ('feature'), so advancing before this
        // write would walk a bug task down the feature chain.
        if (projected.lane !== null && projected.lane !== state.lane) {
          state = /** @type {TaskState} */ ({ ...state, lane: projected.lane });
          dirty = true;
        }
        // Report a reason whenever there IS one — not only when nothing was
        // written. A projection can half-succeed: the planner's plan.json lands
        // while its scope.md is refused (an empty file list would serialize to a
        // contract that denies every edit, so writeScope declines it). Keying the
        // log on `artifact === null` swallowed exactly that case, and the run then
        // died later at the dispatch gate — "scope.md is missing" — with no record
        // of why it was never written. A silent partial failure is the bug class
        // this hook exists to end; it does not get to reappear inside it.
        if (projected.reason !== null) {
          stderr.write(
            `${JSON.stringify({
              event:
                projected.artifact === null
                  ? 'gate-advance.no_projection'
                  : 'gate-advance.partial_projection',
              agentName,
              artifact: projected.artifact,
              reason: projected.reason,
            })}\n`,
          );
        }

        // The grill/critique trace events. `lib/trace/schema.mjs` has defined them
        // since E11-3, `scripts/view-trace.mjs` renders them, `agents/rubber-duck.agent.md`
        // promises them — and NOTHING ever emitted one. The tests proved the schema
        // accepted the event and that `appendTraceEvent` could write it; neither
        // proved anything ever called it. So the audit trail for the one stage that
        // grills the work was permanently empty. It is written here, where the result
        // actually arrives.
        // Trace what LANDED, not what arrived: a `report`-enveloped return keeps its
        // findings one level down, so tracing the raw payload would faithfully record
        // an empty grill.
        if (projected.artifact !== null && projected.body !== undefined) {
          await appendRubberDuckTrace(repoRoot, state.taskId, projected.artifact, projected.body);
        }

        // A worker ran, and produced nothing the workflow can use. THIS is the
        // failure the user actually hit, and the reason it cost hours: the note
        // above goes to the Output panel, `main()` returned 0, and the model was
        // told nothing at all. It saw a completed dispatch and an unmoved gate,
        // concluded its agents were broken, and started doing the work inline.
        // Silence did that. So say it on the channel the model reads.
        if (projected.artifact === null) {
          alert = evidenceFailure({
            agentName,
            gate: state.workflowGate,
            problem: 'returned a contract that does not satisfy its artifact',
            reason: projected.reason ?? 'the return did not match any contract this agent can produce',
          });
        }
      } catch (/** @type {any} */ err) {
        stderr.write(
          `${JSON.stringify({ event: 'gate-advance.project_error', reason: String(err?.message ?? err) })}\n`,
        );
      }
    }
  }

  // 2. Stamp the spec digest whenever a spec is on disk. Keyed on the file, not
  //    on the tool call that wrote it, so a spec written by any means still gets
  //    its metadata — spec-writer holds only an `edit` tool and cannot hash.
  const stamped = await stampSpecDigest(repoRoot, state);
  if (stamped !== null) {
    state = stamped;
    dirty = true;
  }

  // TEST-ONLY seam (#8): fault the hook AFTER step 1 has written the artifact to
  // disk but BEFORE the gate advances, so the injection suite can prove the gate
  // never half-moves and the next invocation catches up. Inert unless the seam's
  // env var is armed for this site — one Set lookup in production. See
  // lib/testing/fault-injection.mjs.
  injectFaultIfArmed('gate-advance');

  // 3. Walk the lane's chain as far as the evidence on disk allows.
  const advanced = await advanceAlongLane(state, {
    stateDir: path.join(repoRoot, STATE_DIR),
  });

  if (advanced.moves.length === 0) {
    if (dirty) await writeTaskState(state, statePath);
    return {
      action: 'no_action',
      moves: [],
      artifact,
      blockedBy: advanced.blockedBy,
      alert,
    };
  }

  await writeTaskState(advanced.state, statePath);

  for (const move of advanced.moves) {
    await recordGateTransition(advanced.state.taskId, move, repoRoot);
  }

  const last = advanced.moves[advanced.moves.length - 1];
  const chainText = advanced.moves.map((m) => m.to).join(' → ');
  stdout.write(
    `[devmate] gate advanced on evidence: ${advanced.moves[0]?.from} → ${chainText}. ` +
      `Now at ${last?.to}.\n`,
  );

  return {
    action: 'advanced',
    moves: advanced.moves,
    artifact,
    blockedBy: advanced.blockedBy,
    alert,
  };
}

/**
 * Read all of stdin as UTF-8. Returns '' when stdin is closed or empty, so a
 * hook fired with no payload degrades to a no-op instead of hanging.
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
function readAll(stdin) {
  return new Promise((res, rej) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    stdin.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', rej);
  });
}

/**
 * Translate a VS Code PostToolUse stdin payload into the {@link GateAdvanceEvent}
 * this module's handler consumes.
 *
 * The subagent's result arrives in `tool_response` — a plain STRING of the
 * agent's final chat text with the contract JSON embedded in it, per the
 * captured payload (`test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json`).
 * `tool_input` is elided by the host to the literal `"..."` for `runSubagent`,
 * so agent identity CANNOT come from there; it comes from `agentName` inside the
 * returned JSON, via the one shared parser (`lib/hooks/agent-result.mjs`).
 * @param {unknown} raw  Parsed stdin JSON.
 * @returns {GateAdvanceEvent}
 */
export function eventFromPayload(raw) {
  const obj =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};

  /** @type {GateAdvanceEvent} */
  const event = { repoRoot: resolveHookRoot(/** @type {{ cwd?: string }} */ (obj)) };
  if (typeof obj['tool_name'] === 'string') event.toolName = obj['tool_name'];
  if (typeof obj['tool_response'] === 'string') event.toolResponse = obj['tool_response'];
  if (typeof obj['tool_use_id'] === 'string') event.toolUseId = obj['tool_use_id'];
  return event;
}

/**
 * Entrypoint: read the PostToolUse payload from stdin and run the handler.
 * Follows CONTRIBUTING §6.
 * @param {string[]} _args  CLI args (hook input arrives on stdin).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  let raw;
  try {
    raw = await readAll(process.stdin);
  } catch (/** @type {any} */ err) {
    process.stderr.write(`[gate-advance] failed to read stdin: ${err?.message ?? err}\n`);
    return 0; // never block a tool call on a hook I/O fault
  }

  if (raw.trim() === '') return 0;

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {any} */ err) {
    process.stderr.write(`[gate-advance] malformed stdin JSON: ${err?.message ?? err}\n`);
    return 0;
  }

  // On exit 0 VS Code parses stdout as JSON, so the handler's human text must be
  // captured and handed back inside the one envelope the host reads — printing
  // it raw is a parse failure that drops the whole output (#77).
  const capture = createTextCapture();
  /** @type {string|null} */
  let alert = null;
  try {
    const result = await handlePostToolUse(eventFromPayload(parsed), { stdout: capture.stream });
    alert = result.alert;
  } catch (/** @type {any} */ err) {
    process.stderr.write(`[gate-advance] ${err?.message ?? err}\n`);
  }

  // A dispatch that produced no evidence exits BLOCK, which routes the text to
  // stderr — the stream VS Code shows the model (the same mechanism
  // hooks/contract-validator.mjs uses for a malformed artifact). Exiting 0 with the
  // explanation in the Output panel is what let a wedged lane look, to the only
  // party who could fix it, exactly like a working one.
  if (alert !== null) {
    return writeHookOutput('PostToolUse', `${capture.text()}\n${alert}`, EXIT_BLOCK);
  }
  return writeHookOutput('PostToolUse', capture.text(), 0);
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
