// @ts-check
import { resolve } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { isDevmatePayload } from "../lib/hooks/session-marker.mjs";
import { pathExists, readTextFileSync, statPathSync } from '../lib/fs-safe.mjs';
import { loadDevmateConfig, resolvePersonaScopeMode } from '../lib/config/devmate-config.mjs';
import { assertPersonaScope } from '../lib/workflow/orchestrator.mjs';
import { isFileReadTool, matchGlob } from '../lib/gate-guard-core.mjs';
import { extractAgentResult, personaFromAgentResult } from '../lib/hooks/agent-result.mjs';
import { resolveAgentName } from '../lib/hooks/subagent-index.mjs';
import { blockOutput, contextOutput } from '../lib/hooks/output-schema.mjs';
import { firstToolInputPath } from '../lib/hooks/tool-input.mjs';
import { persistWorkerReturn } from '../lib/workflow/persist-worker-return.mjs';
import { writeFact } from "../lib/memory/fact-writer.mjs";
import { taskLedgerPath, validateTaskId } from '../lib/memory/paths.mjs';
import { getOwn } from '../lib/object-utils.mjs';
import { mutateTaskStateUnderLock, readTaskState } from '../lib/task-state.mjs';
import { auditAction } from "../lib/trace/audit-action.mjs";
import { appendTraceEvent } from "../lib/trace/append.mjs";
import { createPack, addPointer, BudgetExceededError } from '../lib/context/evidence-pack.mjs';

/** @typedef {import('../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../lib/types.mjs').FactWriteResult} FactWriteResult */
/** @typedef {import('../lib/types.mjs').FactEntry} FactEntry */
/** @typedef {import('../lib/types.mjs').AuditActionEntry} AuditActionEntry */

/**
 * Fallback value for any audit field missing from the hook stdin payload.
 * The hook must still record a well-formed action line, so unknowns are
 * stamped explicitly rather than dropped.
 */
const UNKNOWN = "unknown";

/** @typedef {import('../lib/types.mjs').DevmateConfig} DevmateConfig */

/**
 * Read the entire `stdin` stream to a UTF-8 string.
 * Resolves to '' if stdin is closed or empty.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function readAll(stream) {
  return new Promise((resolveStream, rejectStream) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on("data", (/** @type {Buffer | string} */ chunk) => {
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
 * Run the PostToolUse fact-writer using an injectable stdin (for tests).
 * Reads JSON, calls `writeFact`, emits the result as a single JSON line to
 * `stdout`. Returns the exit code the entrypoint should use.
 *
 * Exit codes:
 *  - 0: payload processed (fact written or intentionally skipped — including
 *       the pre-task window, when .devmate/state/task.json does not exist yet
 *       and the hook emits a single quiet memory.skip line; HITL-3).
 *  - 1: stdin could not be parsed as JSON, OR the task state exists but is
 *       corrupted (malformed JSON / schema-invalid) — memory.error stays loud.
 *
 * Lock timeouts and other recoverable errors are surfaced inside the result
 * object with exit code 0, so the hook never crashes the host session.
 *
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<number>}
 */
export async function runWithIO(stdin, stdout, stderr) {
  const raw = await readAll(stdin);
  if (raw.trim() === "") {
    stderr.write("[post-tool-use] empty stdin — nothing to do.\n");
    return 0;
  }

  /** @type {HookPayload} */
  let payload;
  try {
    payload = /** @type {HookPayload} */ (JSON.parse(raw));
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] malformed stdin JSON: ${msg}\n`);
    return 1;
  }

  // Runtime scope: plugin-level hooks fire in EVERY Copilot session. Act only
  // inside a marked devmate session (lib/hooks/session-marker.mjs); otherwise
  // exit silently — no fact writes, no worker-return persistence, no state.
  if (!isDevmatePayload(payload)) return 0;

  // Anchor on the workspace root even if the hook's cwd is the workspace's own
  // .devmate/ folder (or a directory below the root): resolveHookRoot climbs
  // out of .devmate/ and walks up to the nearest repo marker, so state lands in
  // .devmate/state/, never the doubled .devmate/.devmate/state/.
  //
  // There is no `payload.workspaceRoot` escape hatch any more. It was a
  // "synthetic override for tests" — which is to say, the suite handed this hook
  // a root by a route production could never use, and so never exercised the
  // resolution that production depends on. The tests pass `cwd` now, like the
  // host does (#77).
  const workspaceRoot = resolveHookRoot(payload);

  // 0) Persist the subagent's result BEFORE anything else, including the
  // pre-task early return below. This is the artifact the entire dispatch
  // protocol is built on — `orch-assert-dispatch --file <path>` validates it and
  // `merge-discovery` reads the directory — and until now nothing could write
  // it: every analysis agent is read-only and the orchestrator has no edit or
  // execute tool. So the file never existed, and a wave of workers that had in
  // fact returned good results looked like it had returned nothing.
  //
  // It runs before the task-state check because a dispatch result is worth
  // recording even in the pre-task window, and it never blocks: a persistence
  // failure warns and the hook carries on.
  const subagentResult = await recordSubagentReturn(payload, workspaceRoot, stderr);

  const statePath = resolve(workspaceRoot, '.devmate/state/task.json');
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    // HITL-3: discriminate missing from corrupted, using the same not-found
    // prefix check as the SubagentStart guard. A missing task.json is the
    // legitimate pre-task window (chat/help/analysis before init-task-state
    // runs) — skip quietly; the fail-closed safety for ungoverned work lives
    // in the dispatch gate (HITL-1). A task.json that exists but cannot be
    // read is a real fault and stays loud.
    const firstError = stateResult.errors[0] ?? '';
    if (firstError.startsWith('State file not found:')) {
      stderr.write(
        `${JSON.stringify({ event: 'memory.skip', reason: 'pre_task' })}\n`,
      );
      return 0; // legitimate pre-task window — memory collection skipped
    }
    stderr.write(
      `${JSON.stringify({ event: 'memory.error', reason: 'state_unreadable' })}\n`,
    );
    return 1; // corrupted state stays loud
  }

  const taskId = stateResult.state.taskId;
  try {
    validateTaskId(taskId);
  } catch {
    stderr.write(
      `${JSON.stringify({ event: 'memory.error', reason: 'invalid_task_id' })}\n`,
    );
    return 1;
  }

  const ledgerPath = taskLedgerPath(workspaceRoot, taskId);

  // 1) Audit the action into the unified trace. This is best-effort: an audit
  //    failure must NEVER block the agent, so we warn to stderr and continue.
  await auditFromPayload(payload, taskId, workspaceRoot, stderr);

  // 1b) E9-19: record an EvidencePointer for file-read tool calls so
  // state.evidencePack carries real citations (best-effort, never blocks).
  await recordReadPointer(payload, stateResult.state, statePath, workspaceRoot, stderr);

  // 2) Fact-write (existing behavior, unchanged).
  /** @type {FactWriteResult} */
  const result = await writeFact(payload, ledgerPath, { workspaceRoot });

  // 2b) Emit a fact_write trace event so the memory pipeline is observable
  // (TCM-11) — a devmate-doctor can reconstruct collection from the trace.
  // Best-effort: a trace failure must never block the hook.
  if (result.ok && result.fact) {
    await emitFactWriteTrace(result.fact, taskId, workspaceRoot, stderr);
  }

  // 3) TDD completion tripwire (best-effort): only checks runSubagent calls
  // that target the fullstack agent.
  //
  // Identity comes from the agent's OWN returned contract first. `tool_input` is
  // elided to the literal "..." in the agent log, so `tool_input.agentName` is
  // unverifiable and may never have been there at all — reading it alone is the
  // same mistake that left five layers inert. It stays as a fallback only so a
  // host that does send it keeps working.
  // Narrow first: `tool_input` is a string ("...") for exactly the tools this
  // branch cares about, so reading a key off it without checking is reading a
  // key off a string.
  const toolInput =
    payload.tool_input !== null && typeof payload.tool_input === 'object'
      ? payload.tool_input
      : undefined;
  const maybeAgentName = subagentResult.agentName ?? extractString(toolInput, 'agentName');
  // The persona comes from the worker's OWN returned contract, for the same
  // reason `agentName` does: `tool_input` arrives as the literal string "...",
  // so `tool_input.persona` was `undefined` on every real dispatch — and it was
  // the condition guarding this whole block, so the completion-time persona
  // boundary AND the TDD tripwire behind it both computed nothing, forever (#99).
  // `tool_input` stays a fallback for a host that does send it.
  const maybePersona =
    personaFromAgentResult(subagentResult.result) ?? extractString(toolInput, 'persona');
  if (payload.tool_name === 'runSubagent' && maybeAgentName === 'fullstack') {
    const configPath = resolve(workspaceRoot, '.devmate/devmate.config.json');
    const cfgResult = loadDevmateConfig(configPath);
    if (cfgResult.ok) {
      // Persona-scope (completion-time): verify this dispatch's changedFiles are
      // inside its persona's territory. Source is `tool_response` (this one
      // dispatch's result), NOT the task-wide ledger — the ledger interleaves
      // concurrent personas, so it cannot attribute an edit under parallel
      // dispatch. This is now the ONLY per-worker edit boundary: gate-guard
      // Rule 5 was deleted in #99, because PreToolUse carries no agent identity
      // at all (captured payload), so an edit can never be attributed to one of
      // several concurrent workers at the tool call. Runtime backstop to the
      // orch-assert-persona-scope script.
      const mode = resolvePersonaScopeMode(cfgResult.config);
      if (mode !== 'off') {
        // No persona, no boundary. A `@fullstack` reply that declares none is a
        // contract violation, not a dispatch that happens to be unbounded —
        // treating it as the latter would let a worker opt out of its own
        // territory by omitting one field, which is exactly how this layer spent
        // its life inert.
        if (maybePersona === undefined) {
          await appendPersonaContractTrace(
            taskId,
            'persona-missing',
            ['a fullstack dispatch returned no `persona`, so its edit boundary cannot be checked'],
            workspaceRoot,
            stderr,
          );
          stdout.write(
            JSON.stringify({
              ...personaVerdict(
                mode,
                'persona_missing',
                'This @fullstack dispatch returned no `persona`, so devmate cannot check the files ' +
                  'it changed against a territory. Report the persona you were dispatched with at ' +
                  'the top level of your JSON reply, as a `persona` field alongside `agentName`.',
              ),
              ok: false,
              mode,
            }) + '\n',
          );
          return 0;
        }

        const changed = extractChangedFilesFromToolResponse(payload.tool_response);
        if (changed !== null) {
          const scope = assertPersonaScope(maybePersona, changed, cfgResult.config);
          // `violations` is set only for a real breach; usage errors (unknown
          // persona) carry no violations and must not deny at runtime.
          if (!scope.ok && scope.violations) {
            await appendPersonaScopeViolationTrace(taskId, maybePersona, scope.violations, workspaceRoot, stderr);
            // This used to emit `{ok: false, reason: '…'}` and exit 0 — a shape
            // with no meaning to the host. VS Code blocks a PostToolUse on a
            // TOP-LEVEL `decision: "block"`, and reads nothing else (#77). The
            // internal keys ride along; the host ignores what it does not know,
            // and devmate's own tests still read them.
            const detail =
              `Persona "${maybePersona}" edited files outside its territory: ` +
              `${scope.violations.join(', ')}. Revert them, or dispatch the persona that owns those paths.`;
            stdout.write(
              JSON.stringify({
                ...personaVerdict(mode, 'persona_scope_violation', detail),
                ok: false,
                persona: maybePersona,
                violations: scope.violations,
                mode,
              }) + '\n',
            );
            return 0;
          }
        }
      }

      if (maybePersona !== undefined) {
        const filesChanged = loadFilesChangedFromLedger(ledgerPath);
        const tripwire = assertTestFileTouched({ filesChanged }, cfgResult.config, maybePersona);
        if (!tripwire.ok) {
          stdout.write(
            JSON.stringify({
              ...tripwire,
              ...blockOutput(
                'PostToolUse',
                tripwire.reason ?? 'tdd_skipped',
                'TDD tripwire: this dispatch changed source without touching a test file. Write the failing test first.',
              ),
            }) + '\n',
          );
          return 0;
        }
      }
    }
  }

  stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

/**
 * Emit a `fact_write` trace event for an appended fact. Best-effort — any
 * failure (validation, I/O, unknown-type) warns to stderr and never blocks the
 * hook. Makes stage-1 collection observable in the unified trace (TCM-11).
 * @param {FactEntry} fact
 * @param {string} taskId
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function emitFactWriteTrace(fact, taskId, workspaceRoot, stderr) {
  try {
    await appendTraceEvent(
      {
        type: 'fact_write',
        taskId,
        stepId: fact.stepId && fact.stepId.length > 0 ? fact.stepId : 'none',
        ts: new Date().toISOString(),
        schemaVersion: 1,
        factKey: fact.key,
        scope: fact.lane && fact.lane.length > 0 ? fact.lane : 'unknown',
        sourcePointer: fact.source,
      },
      { root: workspaceRoot },
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] fact_write trace skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * Safely extract a string property from a tool_input record.
 * @param {Record<string, unknown>|undefined} obj
 * @param {string} key
 * @returns {string|undefined}
 */
function extractString(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const value = getOwn(obj, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read changed file paths from the fact ledger.
 * @param {string} ledgerPath
 * @returns {string[]}
 */
function loadFilesChangedFromLedger(ledgerPath) {
  if (!pathExists(ledgerPath)) return [];
  const raw = readTextFileSync(ledgerPath);
  /** @type {string[]} */
  const paths = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(trimmed));
      if (parsed['event'] === 'fact' && typeof parsed['source'] === 'string') {
        paths.push(parsed['source']);
      }
    } catch {
      // ignore malformed historical lines
    }
  }
  return paths;
}

/**
 * Persist a `runSubagent` result to `.devmate/state/worker-returns/` and report
 * what came back.
 *
 * An EMPTY return is the failure the user actually hit: VS Code renders it as
 * "Agent completed with no output", the orchestrator saw nothing, decided the
 * agent was broken, and did the work inline — the exact delegation violation its
 * own prompt forbids. Silence is what made that possible, so this says so out
 * loud, on the channel the model reads.
 *
 * Best-effort throughout: this is bookkeeping, and it must never take down a
 * session or block a tool call.
 *
 * @param {HookPayload} payload
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<{ agentName: string|null, result: Record<string, unknown>|null }>}
 *   `result` is the worker's parsed contract — the channel the persona rides back
 *   on (#99), so the caller must not have to re-parse `tool_response` to find it.
 */
async function recordSubagentReturn(payload, workspaceRoot, stderr) {
  if (payload.tool_name !== 'runSubagent') return { agentName: null, result: null };

  const extracted = extractAgentResult(payload.tool_response);

  // Identity from the HOST first. `SubagentStart` named this agent and `agent_id` is
  // the parent link to this very completion, so a return that forgot to sign itself
  // is still attributable. It used to be discarded — which meant a chatty worker's
  // entire dispatch vanished, leaving the orchestrator to conclude the agent was
  // broken when it had in fact done the work.
  const hostName = resolveAgentName(workspaceRoot, payload.tool_use_id);

  if (extracted.empty) {
    stderr.write(
      `${JSON.stringify({
        event: 'subagent.empty_result',
        agentName: hostName,
        toolUseId: payload.tool_use_id ?? null,
        note: 'subagent returned no output; the gate must not advance and the orchestrator must re-dispatch, never do the work inline',
      })}\n`,
    );
    return { agentName: null, result: null };
  }

  const agentName = hostName ?? extracted.agentName;

  if (extracted.result === null || agentName === null) {
    // The agent replied, but with no contract the host could attribute. Loud,
    // because a result that cannot be attributed cannot be validated.
    stderr.write(
      `${JSON.stringify({
        event: 'subagent.malformed_result',
        toolUseId: payload.tool_use_id ?? null,
      })}\n`,
    );
    return { agentName: null, result: null };
  }

  // The return file is keyed by tool_use_id precisely so a parallel wave of K
  // same-named workers does not overwrite itself. A sentinel id would defeat
  // that: every id-less dispatch would collide on one filename, a fan-out would
  // look like it produced a single return, and the dispatch floor would read
  // that as evidence. This is the shape of #76 (the `unknown.jsonl` no reader
  // ever consults) — so a missing id is an ERROR, never a fabricated name.
  const toolUseId = payload.tool_use_id;
  if (typeof toolUseId !== 'string' || toolUseId === '') {
    stderr.write(
      `${JSON.stringify({
        event: 'subagent.unattributable_result',
        agentName,
        note: 'no tool_use_id on the payload; the return cannot be keyed to its dispatch and was NOT persisted',
      })}\n`,
    );
    return { agentName, result: extracted.result };
  }

  try {
    const path = await persistWorkerReturn(workspaceRoot, {
      agentName,
      toolUseId,
      result: extracted.result,
    });
    stderr.write(
      `${JSON.stringify({ event: 'subagent.return_persisted', agentName, path })}\n`,
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(
      `${JSON.stringify({ event: 'subagent.persist_error', reason: msg })}\n`,
    );
  }

  return { agentName, result: extracted.result };
}

/**
 * Extract `payload.changedFiles` from a runSubagent `tool_response` — the
 * per-dispatch, parallel-safe source of the files this one dispatch changed
 * (the task-wide fact ledger cannot separate concurrent personas). Handles an
 * object, a JSON string, or a `{ content: <json string> }` wrapper. Returns
 * null when changedFiles cannot be extracted (best-effort — the caller skips).
 * @param {unknown} toolResponse
 * @returns {string[]|null}
 */
export function extractChangedFilesFromToolResponse(toolResponse) {
  // Was `JSON.parse(tool_response)`. The captured payload shows the real value
  // is the agent's final chat text — PROSE followed by the JSON — so that parse
  // threw and this returned null on every real dispatch, quietly disabling the
  // persona-scope and TDD tripwires it feeds. `extractAgentResult` owns the
  // shape now (see lib/hooks/agent-result.mjs).
  const obj = extractAgentResult(toolResponse).result;
  if (!obj || typeof obj !== 'object') return null;
  const payload = getOwn(/** @type {Record<string, unknown>} */ (obj), 'payload');
  if (payload === null || typeof payload !== 'object') return null;
  const cf = getOwn(/** @type {Record<string, unknown>} */ (payload), 'changedFiles');
  return Array.isArray(cf) ? cf.filter((x) => typeof x === 'string') : null;
}

/**
 * Render a persona-boundary verdict in the shape the configured `personaScope`
 * mode promises.
 *
 * `block` halts the dispatch (top-level `decision: "block"` — the only field VS
 * Code reads on PostToolUse). `warn` — the DEFAULT — records and surfaces the
 * breach to the model via `additionalContext` without halting, which is what
 * docs/gate-guard.md and docs/config.md have always said it does. The old code
 * emitted `blockOutput` for both, and nobody noticed because the check it fed
 * never fired (#99): switching it on unchanged would have turned the documented
 * default from "warn" into "halt" for every consumer at once.
 *
 * The verdict id rides along in both modes so devmate's own tests and doctor can
 * read it — but in `warn` it must NOT be called `reason`. `reason` is the host's
 * own key, honored only alongside `decision: "block"`, and emitting it without one
 * is a contract error by this repo's own validator ("`reason` without
 * decision:'block' does nothing" — lib/hooks/output-schema.mjs). Shipping a key the
 * host reads in one mode and silently drops in another is the exact shape of the
 * defects this PR exists to remove, so the non-blocking verdict travels under
 * devmate's own key.
 * @param {string} mode  Resolved personaScope mode ('warn' | 'block').
 * @param {string} reason  Machine-readable verdict id.
 * @param {string} detail  Human/model-facing explanation.
 * @returns {Record<string, unknown>}
 */
function personaVerdict(mode, reason, detail) {
  if (mode === 'block') {
    return blockOutput('PostToolUse', reason, detail);
  }
  return { ...(contextOutput('PostToolUse', detail) ?? {}), devmateReason: reason };
}

/**
 * Append a `contract_violation` trace event for a persona-contract fault that is
 * not a per-file breach — today, a `@fullstack` reply that declares no persona.
 * Best-effort: a trace failure warns to stderr and never blocks the hook.
 * @param {string} taskId
 * @param {string} stepSuffix
 * @param {string[]} errors
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function appendPersonaContractTrace(taskId, stepSuffix, errors, workspaceRoot, stderr) {
  try {
    await appendTraceEvent(
      {
        type: 'contract_violation',
        taskId,
        stepId: `persona-scope-${stepSuffix}`,
        ts: new Date().toISOString(),
        schemaVersion: 1,
        contract: 'persona-scope',
        path: 'unknown',
        errors,
      },
      { root: workspaceRoot },
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] persona-contract trace skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * Append a `contract_violation` trace event for a persona-scope breach (reuses
 * the existing event type — no schema change). Best-effort: a trace failure
 * warns to stderr and never blocks the hook.
 * @param {string} taskId
 * @param {string} persona
 * @param {string[]} violations
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function appendPersonaScopeViolationTrace(taskId, persona, violations, workspaceRoot, stderr) {
  try {
    await appendTraceEvent(
      {
        type: 'contract_violation',
        taskId,
        stepId: `persona-scope-${persona}`,
        ts: new Date().toISOString(),
        schemaVersion: 1,
        contract: 'persona-scope',
        path: violations[0] ?? 'unknown',
        errors: [
          `persona '${persona}' edited files outside its scope`,
          ...violations.map((f) => `- ${f} (not in editableGlobs, or matches offLimitsGlobs)`),
        ],
      },
      { root: workspaceRoot },
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] persona-scope trace skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * Checks whether a completion result touched at least one file matching the
 * consumer's declared testGlobs for the given persona.
 * Returns ok:false with reason 'tdd_skipped' if no test file was touched.
 *
 * @param {{ filesChanged: string[] }} result
 * @param {DevmateConfig} config
 * @param {string} persona
 * @returns {{ ok: boolean, reason?: string, filesChanged?: string[], expectedGlobs?: string[] }}
 */
export function assertTestFileTouched(result, config, persona) {
  const personaConfig = config.personas.find((entry) => entry.persona === persona);
  const globs = personaConfig?.testGlobs;

  // Graceful fallback: no persona globs configured means no hard gate.
  if (!Array.isArray(globs) || globs.length === 0) {
    return { ok: true };
  }

  const filesChanged = Array.isArray(result.filesChanged) ? result.filesChanged : [];
  const touched = filesChanged.some((filePath) => globs.some((glob) => matchGlob(glob, filePath)));

  if (touched) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'tdd_skipped',
    filesChanged,
    expectedGlobs: globs,
  };
}

/**
 * Build an AuditActionEntry from the hook stdin fields and append one action
 * line to the trace, keyed on the ACTIVE TASK's id.
 *
 * The entry used to be keyed on `session_id` (a Copilot session UUID), so
 * every action landed in a session-uuid-named trace file while fact writes,
 * contract violations, and gate transitions landed in the task's file —
 * `view-trace.mjs --task` never saw the actions (#76). The caller passes the
 * state-derived taskId it already validated; session identity remains
 * available in the VS Code transcript, not here.
 *
 * Fields used from stdin: `tool_name` → actionType; the target path via the one
 * `tool_input` parser; `timestamp` → part of the derived stepId.
 *
 * The `GITHUB_COPILOT_TOOL_NAME` / `GITHUB_COPILOT_TOOL_PATH` env overrides are
 * gone. They were `[UNVERIFIED]` — no VS Code doc describes them and no captured
 * payload environment carries them — so they were a guess that could only ever
 * *override* correct data with something else. Worse, they were read first: any
 * process that happened to export those names would have silently rewritten
 * devmate's audit trail (#77).
 *
 * @param {HookPayload & { session_id?: string, timestamp?: string }} payload
 * @param {string} taskId  Active task id from task.json (validated by the caller).
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
export async function auditFromPayload(payload, taskId, workspaceRoot, stderr) {
  const actionType = payload.tool_name ?? UNKNOWN;
  const actionPath =
    payload.path ?? firstToolInputPath(payload.tool_input) ?? UNKNOWN;

  // stepId: no official per-step id exists on stdin. Derive a stable id from
  // the action + timestamp so distinct actions get distinct steps; fall back
  // to 'unknown' when neither is present.
  const ts = payload.timestamp;
  const stepId =
    ts || payload.tool_name ? `${actionType}@${ts ?? UNKNOWN}` : UNKNOWN;

  /** @type {AuditActionEntry} */
  const entry = { taskId, stepId, actionType, path: actionPath };

  // Best-effort: a failed (or even throwing) audit must never block the agent.
  try {
    const res = await auditAction(entry, { root: workspaceRoot });
    if (!res.ok) {
      const detail = res.errors ? res.errors.join("; ") : "unknown error";
      stderr.write(`[post-tool-use] action audit skipped: ${detail}\n`);
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] action audit error (ignored): ${msg}\n`);
  }
}

/**
 * Entrypoint: read JSON payload from stdin, call writeFact, emit result to
 * stdout. Follows CONTRIBUTING §6.
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  return runWithIO(process.stdin, process.stdout, process.stderr);
}

/**
 * E9-19 producer: on a file-read tool call, append an EvidencePointer to
 * state.evidencePack (created on first use, capped at the persisted
 * outputContract.max_context_sources). Best-effort — any failure warns and
 * never blocks the hook.
 * @param {HookPayload} payload
 * @param {import('../lib/types.mjs').TaskState} state
 * @param {string} statePath
 * @param {string} workspaceRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function recordReadPointer(payload, state, statePath, workspaceRoot, stderr) {
  try {
    if (!isFileReadTool(payload.tool_name)) return;
    const filePath = typeof payload.path === 'string' && payload.path !== ''
      ? payload.path
      : firstToolInputPath(payload.tool_input);
    if (filePath === undefined || filePath === '') return;

    // freshness = the file's mtime when readable; fall back to now.
    let freshness = new Date().toISOString();
    try {
      const abs = resolve(workspaceRoot, filePath);
      freshness = statPathSync(abs).mtime.toISOString();
    } catch {
      // keep the fallback
    }

    /** @type {import('../lib/types.mjs').EvidencePointer} */
    const pointer = {
      path: filePath,
      lineRange: null,
      reason: `read via ${payload.tool_name}`,
      confidence: 1,
      freshness,
      kind: 'file',
    };

    // #189: dedup + append + budget-cap are all recomputed against the FRESH
    // in-lock pack, so a concurrent evidence append is not lost (the field is no
    // longer last-writer-wins from a stale snapshot) and a gate advance is not
    // clobbered. A duplicate or a budget-cap hit returns null (no write); a real
    // failure surfaces as a non-throwing { ok: false } logged below.
    const outcome = await mutateTaskStateUnderLock(
      (fresh) => {
        const maxSources = fresh.outputContract?.max_context_sources ?? 10;
        const pack =
          fresh.evidencePack ??
          createPack({ taskId: fresh.taskId, stage: fresh.workflowGate, maxSources });
        // Skip duplicates: one pointer per (path, whole-file) read.
        if (pack.pointers.some((p) => p.path === filePath && p.lineRange === null)) return null;
        try {
          return { ...fresh, evidencePack: addPointer(pack, pointer) };
        } catch (/** @type {unknown} */ err) {
          // TODO: confirm cap policy after E9-21 budget evals — provisional
          // (current policy: stop appending at max_context_sources).
          if (err instanceof BudgetExceededError) return null;
          throw err;
        }
      },
      statePath,
      { event: 'evidence-pointer' },
    );
    if (!outcome.ok) {
      stderr.write(`[post-tool-use] evidence pointer skipped (non-fatal): ${outcome.error}\n`);
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`[post-tool-use] evidence pointer skipped (non-fatal): ${msg}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
