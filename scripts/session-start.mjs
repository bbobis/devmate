// @ts-check
import { pathExists, readTextFileSync, statPathSync } from '../lib/fs-safe.mjs';
import { resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { createTextCapture, writeHookOutput } from '../lib/hooks/output-schema.mjs';
import { resolveRepoRoot } from '../lib/init/repo-root.mjs';
import { ensureDevmateLayout, layoutExists } from '../lib/init/devmate-init.mjs';
import { loadDevmateConfig, resolveStaleTaskHours } from '../lib/config/devmate-config.mjs';
import { evaluateStaleness } from '../lib/task-staleness.mjs';
import { checkPersonaInstructionFiles } from '../lib/persona-instructions.mjs';
import { checkDomainContextFiles } from '../lib/context/domain-context-load.mjs';
import { fallbackReposOf, formatFallbackNudge } from '../lib/init/multi-root-init.mjs';
import { assertDevmateReady } from '../lib/startup.mjs';
import { MEMORY_PATH, repoLedgerPath } from '../lib/memory/paths.mjs';
import { queryMemory } from '../lib/memory/query.mjs';
import { buildMemoryContext } from '../lib/memory/memory-context.mjs';
import { buildResumePlan } from '../lib/resume/plan.mjs';
import { reconcileActiveSubagents } from '../lib/resume/reconcile-subagents.mjs';
import { bootstrapTaskState } from '../lib/workflow/bootstrap-task-state.mjs';
import { writeResult } from '../lib/output/write-result.mjs';
import { readTaskState, writeTaskState, STATE_PATH } from '../lib/task-state.mjs';
import { buildStateAnchor } from '../lib/orchestrator/state-anchor.mjs';
import { readTrace } from '../lib/trace/read-trace.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';
import { completedAcNumbers, summarizeImplProgress } from '../lib/spec-progress.mjs';

/** @typedef {import('../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../lib/types.mjs').DevmateConfig} DevmateConfig */

/**
 * How many recalled facts to inject at session start (single-root). Bounded to
 * keep the startup context token-disciplined (TCM-9); mirrors queryMemory's
 * default top-N.
 * @type {number}
 */
const MEMORY_INJECT_TOP_N = 10;

/**
 * B3: In multi-root mode, pre-load each repo's own memory file
 * (resolve(repoPath, MEMORY_PATH)) into a map keyed by repo name. Personas that
 * share a repo are de-duped (keyed by repo name, and the same repo is read at
 * most once). A repo whose memory file is missing is simply absent from the
 * map — never a failure.
 *
 * @param {DevmateConfig} config  A validated config with mode === 'multi-root'.
 * @returns {Record<string, string>} repo name -> memory file contents
 */
export function loadRepoMemories(config) {
  // Same repo shared by several personas is read at most once: de-dupe the
  // repo -> memory-path mapping first, then read each unique repo's file.
  /** @type {Map<string, string>} */
  const repoMemoryPaths = new Map();
  for (const persona of config.personas) {
    const repo = /** @type {string} */ (persona.repo);
    const repoPath = /** @type {string} */ (persona.repoPath);
    if (!repoMemoryPaths.has(repo)) {
      repoMemoryPaths.set(repo, resolve(repoPath, MEMORY_PATH));
    }
  }
  return Object.fromEntries(
    [...repoMemoryPaths].flatMap(([repo, repoMemoryPath]) => {
      try {
        return [[repo, readTextFileSync(repoMemoryPath)]];
      } catch {
        // Missing per-repo memory file is expected — skip silently. Any other
        // read error (permissions, etc.) is likewise non-fatal to session start.
        return [];
      }
    }),
  );
}

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
    stream.on('data', (/** @type {Buffer | string} */ chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    stream.on('end', () => resolveStream(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', rejectStream);
  });
}

/**
 * Run the SessionStart initializer using injectable IO (for tests).
 *
 * Reads the hook payload from stdin, filters internally on
 * `hook_event_name === 'SessionStart'` (matchers are not relied upon), derives
 * a start dir from the payload `cwd` (falling back to `process.cwd()` because
 * VS Code may omit `cwd`), resolves the correct repo root for multi-root
 * workspace correctness, and idempotently seeds the `.devmate/` layout.
 *
 * Startup invariants (gate-guard hook registered + valid config) are asserted
 * BEFORE any layout work. When the environment is degraded (missing/invalid
 * config or an unregistered gate-guard), the warning is surfaced and the session
 * exits 1 without attempting init — a broken environment must fail fast rather
 * than run layout code (e.g. mkdir) that may itself throw and mask the real
 * cause.
 *
 * Only the CONFIG half of that check is repo-relative. The gate-guard manifest
 * and script are plugin-shipped, so `assertDevmateReady` anchors them to the
 * plugin root on its own — passing `repoRoot` for them made every plugin
 * consumer's session fail readiness and skip this entire initializer (#72).
 *
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<number>}
 */
export async function runWithIO(stdin, stdout, stderr) {
  let raw = '';
  try {
    raw = await readAll(stdin);
  } catch (/** @type {unknown} */ err) {
    stderr.write(`[session-start] stdin read error (ignored): ${errMsg(err)}\n`);
    return 0;
  }

  /** @type {Partial<HookPayload>} */
  let payload = {};
  if (raw.trim() !== '') {
    try {
      payload = /** @type {Partial<HookPayload>} */ (JSON.parse(raw));
    } catch (/** @type {unknown} */ err) {
      // Malformed payload must not block the session; default the start dir.
      stderr.write(`[session-start] malformed stdin JSON (ignored): ${errMsg(err)}\n`);
    }
  }

  // Only act on SessionStart. Other events (if any are routed here) are no-ops.
  if (payload.hook_event_name && payload.hook_event_name !== 'SessionStart') {
    return 0;
  }

  const startDir = payload.cwd ?? process.cwd();
  let repoRoot = startDir;

  try {
    repoRoot = await resolveRepoRoot(startDir);
    stderr.write(`[session-start] resolved repoRoot: ${repoRoot}\n`);

    // Assert startup readiness invariants BEFORE any layout work. A degraded
    // environment (missing/invalid config or an unregistered gate-guard) must
    // surface the warning and exit 1 up front, rather than running init/mkdir
    // that could throw first and hide the real cause.
    const readinessCheck = assertDevmateReady(repoRoot);
    if (!readinessCheck.ok) {
      for (const error of readinessCheck.errors) {
        stderr.write(`devmate: ${error}\n`);
      }
      return 1;
    }

    const result = await ensureDevmateLayout(repoRoot);

    // Post-init verification: confirm layout actually exists on disk.
    const verified = await layoutExists(repoRoot);
    if (!verified) {
      stdout.write(
        JSON.stringify({
          ok: false,
          warning: 'devmate: .devmate layout could not be verified after init. Run `devmate init` manually.',
          repoRoot,
        }) + '\n'
      );
      return 0;
    }

    if (!result.skipped && result.created.length > 0) {
      stdout.write(
        JSON.stringify({ ok: true, repoRoot, created: result.created.length }) + '\n'
      );
    }

    // Bootstrap .devmate/state/task.json if absent. Nothing else creates it:
    // init-task-state is invoked only from a line in the orchestrator prompt,
    // and the orchestrator has no `execute` tool, so it never ran. Without
    // task.json the trace, the handoff, the memory ledger and the budget guard
    // all go quiet at once — the session looks like it did nothing. Bootstrapped
    // at the PRE-ROUTER gate (`no-lane`), never at `plan-approved`: this must
    // not hand @fullstack an open implementation gate. Create-if-absent, so a
    // resumed task keeps its own gate and progress. Best-effort — a bootstrap
    // failure must never block the session from starting.
    try {
      const bootstrap = await bootstrapTaskState(repoRoot, {
        ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}),
      });
      if (bootstrap.created) {
        stdout.write(
          JSON.stringify({ ok: true, event: 'task.bootstrapped', taskId: bootstrap.taskId }) + '\n'
        );
      } else if (bootstrap.reason === 'no_session_id') {
        stderr.write(
          '[session-start] no session_id in payload; task.json not bootstrapped ' +
            '(trace, handoff, memory and budget stay inactive until a task exists)\n'
        );
      }
    } catch (/** @type {unknown} */ err) {
      stderr.write(`[session-start] task bootstrap failed (ignored): ${errMsg(err)}\n`);
    }

    // E13-2: warn (non-blocking) when any persona declares an instructionFile
    // that does not exist on disk. Missing files are treated as no-op at
    // dispatch time, so this is a warning only — never a hard failure.
    const cfgResult = loadDevmateConfig(resolve(repoRoot, '.devmate/devmate.config.json'));
    if (cfgResult.ok) {
      if (Array.isArray(cfgResult.warnings) && cfgResult.warnings.length > 0) {
        for (const warning of cfgResult.warnings) {
          stdout.write(JSON.stringify({ ok: true, warning, repoRoot }) + '\n');
        }
      }
      const check = checkPersonaInstructionFiles(
        repoRoot,
        cfgResult.config.personas,
        pathExists,
      );
      if (check.missing.length > 0) {
        const personaWarning = JSON.stringify({
          ok: true,
          warning:
            `devmate: persona instructionFile(s) declared but missing on disk: ${check.missing.join(', ')}. Dispatch will proceed without injection for these personas.`,
          repoRoot,
          missingPersonaInstructions: check.missing,
        });
        stdout.write(personaWarning + '\n');
      }

      // DN-3: same non-blocking warning for domain contextFiles — a declared
      // but missing file degrades to a "context file missing" note at
      // dispatch time, so this is advisory only, never a hard failure.
      const domainCheck = checkDomainContextFiles(
        repoRoot,
        cfgResult.config.domains ?? [],
        pathExists,
      );
      if (domainCheck.missing.length > 0) {
        const domainWarning = JSON.stringify({
          ok: true,
          warning:
            `devmate: domain contextFile(s) declared but missing on disk: ${domainCheck.missing.join(', ')}. Dispatch will proceed without domain context for these domains.`,
          repoRoot,
          missingDomainContextFiles: domainCheck.missing,
        });
        stdout.write(domainWarning + '\n');
      }

      // B3: multi-root only — pre-load each repo's scoped memory file into a
      // map keyed by repo name and attach it to the session context. B4 selects
      // the right entry at dispatch time; the workspace memory file remains the
      // base context.
      if (cfgResult.config.mode === 'multi-root') {
        // B10: non-blocking nudge for any repo running on a synthesized fallback
        // persona — advisory only; the session is fully usable either way.
        const fallbackRepos = fallbackReposOf(cfgResult.config);
        if (fallbackRepos.length > 0) {
          stdout.write(
            JSON.stringify({
              ok: true,
              warning: formatFallbackNudge(fallbackRepos),
              repoRoot,
              fallbackRepos,
            }) + '\n',
          );
        }
        const repoMemories = loadRepoMemories(cfgResult.config);
        stdout.write(JSON.stringify({ ok: true, repoRoot, repoMemories }) + '\n');
      } else {
        // Single-root: inject a bounded, scored top-N recall block so the agent
        // starts with relevant prior facts instead of re-inferring them. This is
        // the previously-missing recall path — single-root sessions injected
        // zero memory before. Best-effort: never blocks the session.
        await emitMemoryContext(repoRoot, stdout, stderr);
      }
    }

    // DN-6: a fresh session implies no sub-agent from a prior session can
    // still be running, so reconcile a stale (leaked) activeSubagents
    // counter to 0 before the resume plan is computed — the plan, and any
    // subsequent dispatch, must see a clean counter.
    await reconcileSubagentsAtSessionStart(repoRoot, stderr);

    // E9-16: crash recovery is automatic — when a task is in progress,
    // compute the resume plan and surface it instead of waiting for a human
    // to remember scripts/resume.mjs.
    await emitResumePlan(repoRoot, stdout, stderr);

    // E10-02: alongside the resume plan line, emit the same model-visible
    // workflow-state anchor block the UserPromptSubmit hook prints, so
    // resumed/compacted sessions re-anchor to the durable gate immediately.
    await emitStateAnchorBlock(repoRoot, stdout, stderr);
  } catch (/** @type {unknown} */ err) {
    // Never crash the session on an init failure (e.g. permission error).
    // Surface to stdout so it shows in the Claude chat, not just stderr.
    stderr.write(`[session-start] init error (ignored): ${errMsg(err)}\n`);
    stdout.write(
      JSON.stringify({
        ok: false,
        warning: 'devmate: .devmate layout could not be created. Run `devmate init` manually.',
        repoRoot,
        error: errMsg(err),
      }) + '\n'
    );
  }

  return 0;
}

/**
 * Normalize an unknown thrown value to a message string.
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort staleness of the current task, measured from the gitignored
 * state file's mtime. Never throws — returns undefined when it can't be
 * determined (missing file, unreadable config, etc.).
 * @param {string} repoRoot
 * @param {import('../lib/types.mjs').WorkflowGate} workflowGate
 * @returns {import('../lib/task-staleness.mjs').Staleness|undefined}
 */
function computeTaskStaleness(repoRoot, workflowGate) {
  try {
    const mtimeMs = statPathSync(resolve(repoRoot, STATE_PATH)).mtimeMs;
    const cfg = loadDevmateConfig(resolve(repoRoot, '.devmate/devmate.config.json'));
    const staleHours = resolveStaleTaskHours(cfg.ok ? cfg.config : null);
    return evaluateStaleness({ workflowGate, mtimeMs, nowMs: Date.now(), staleHours });
  } catch {
    return undefined;
  }
}

/**
 * DN-6: reconcile a stale `activeSubagents` counter at SessionStart. A fresh
 * session implies no sub-agent from a prior session can still be running, so
 * any nonzero count left by a hard interrupt (host crash, session kill
 * mid-dispatch, hook OOM that skipped `SubagentStop`) is stale. Resets it to
 * 0 under the existing task-state lock and appends a `subagent_reconciled`
 * trace event carrying the previous value. A no-op (no write, no trace
 * event) when task.json is absent/unreadable or the counter is already 0 —
 * this must never add churn to every ordinary session. Never blocks session
 * start: any failure (e.g. lock contention) is warned and swallowed.
 * @param {string} repoRoot
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function reconcileSubagentsAtSessionStart(repoRoot, stderr) {
  try {
    const statePath = resolve(repoRoot, STATE_PATH);
    const stateResult = readTaskState(statePath);
    const taskState = stateResult.ok ? stateResult.state : null;
    const { needed, previous } = reconcileActiveSubagents({ taskState });
    if (!needed || taskState === null) return;

    // #93: the in-flight agent roster shares this lifecycle — a leaked entry
    // would let a dead sub-agent's identity authorize a session-artifact write.
    await writeTaskState({ ...taskState, activeSubagents: 0, activeAgents: [] }, statePath);

    await appendTraceEvent(
      {
        type: 'subagent_reconciled',
        taskId: taskState.taskId,
        stepId: 'session-start-reconcile',
        ts: new Date().toISOString(),
        schemaVersion: 1,
        previous,
      },
      { root: repoRoot },
    );
  } catch (/** @type {unknown} */ err) {
    stderr.write(`[session-start] subagent reconciliation skipped (non-fatal): ${errMsg(err)}\n`);
  }
}

/**
 * E9-16: when task state exists, build the resume plan, persist
 * `.devmate/state/resume-plan.json` (atomic), and print a concise plan line.
 * Fresh sessions (no task state) are silent no-ops; a failure to build the
 * plan falls back to `confirm_needed` (matching resume.mjs semantics) and
 * never blocks the session.
 * @param {string} repoRoot
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function emitResumePlan(repoRoot, stdout, stderr) {
  /** @type {string} */
  let taskId;
  /** @type {import('../lib/types.mjs').WorkflowGate} */
  let workflowGate;
  /** @type {string[]|undefined} */
  let acceptanceCriteria;
  try {
    const raw = readTextFileSync(resolve(repoRoot, '.devmate/state/task.json'));
    const state = JSON.parse(raw);
    if (typeof state?.taskId !== 'string' || state.taskId === '') return;
    taskId = state.taskId;
    workflowGate = state.workflowGate;
    // Pass the persisted AC list so the resume plan can report per-AC progress.
    if (
      Array.isArray(state.acceptanceCriteria) &&
      state.acceptanceCriteria.every((/** @type {unknown} */ v) => typeof v === 'string')
    ) {
      acceptanceCriteria = state.acceptanceCriteria;
    }
  } catch {
    // Fresh session (no task state) — skip silently.
    return;
  }

  const staleness = computeTaskStaleness(repoRoot, workflowGate);

  /** @type {{ taskId: string, action: string, message: string, nextStepId: string|null, nextStepLabel: string|null, handoffAvailable: boolean, compactionAvailable: boolean, implProgress: import('../lib/types.mjs').ImplProgress|null, stale: boolean }} */
  let planSummary;
  try {
    const plan = await buildResumePlan(taskId, {
      traceDir: resolve(repoRoot, '.devmate/state/trace'),
      handoffDir: resolve(repoRoot, '.devmate/state/handoff'),
      compactionDir: resolve(repoRoot, '.devmate/state/compaction'),
      acceptanceCriteria,
    });
    planSummary = {
      taskId: plan.taskId,
      action: plan.action,
      message: plan.message,
      nextStepId: plan.nextStepId ?? null,
      nextStepLabel: plan.nextStepLabel ?? null,
      handoffAvailable: plan.handoffAvailable,
      compactionAvailable: plan.compactionAvailable,
      implProgress: plan.implProgress ?? null,
      stale: staleness?.stale ?? false,
    };
  } catch (/** @type {unknown} */ err) {
    // Malformed/unreadable trace must not crash the hook.
    stderr.write(`[session-start] resume plan error (fallback confirm_needed): ${errMsg(err)}\n`);
    planSummary = {
      taskId,
      action: 'confirm_needed',
      message: `Resume plan could not be built (${errMsg(err)}); confirm before proceeding.`,
      nextStepId: null,
      nextStepLabel: null,
      handoffAvailable: false,
      compactionAvailable: false,
      implProgress: null,
      stale: staleness?.stale ?? false,
    };
  }

  // A stale in-flight task should not silently resurface as work-to-resume. Lead
  // with the age so a fresh session starts clean by default rather than picking
  // the old workflow back up.
  if (staleness?.stale) {
    planSummary.message =
      `This task has been idle ~${Math.round(staleness.idleHours)}h and is likely abandoned — ` +
      `starting a fresh task is recommended; resume only if you deliberately want to continue it. ` +
      planSummary.message;
  }

  const written = await writeResult(resolve(repoRoot, '.devmate/state/resume-plan.json'), planSummary);
  if (!written.ok) {
    stderr.write(`[session-start] resume plan write failed (ignored): ${written.error}\n`);
  }
  stdout.write(
    JSON.stringify({
      ok: true,
      repoRoot,
      resumeAction: planSummary.action,
      resumeMessage: planSummary.message,
      implProgress: planSummary.implProgress,
      stale: planSummary.stale,
    }) + '\n'
  );
}

/**
 * E10-02: emit the model-visible `<devmate-state>` anchor block (current
 * gate, lane, step, legal next transitions) read from the durable task state,
 * mirroring what the UserPromptSubmit hook prints on every prompt. Fresh
 * sessions (no task state) and invalid state files emit nothing; a failure
 * never blocks the session.
 * @param {string} repoRoot
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
async function emitStateAnchorBlock(repoRoot, stdout, stderr) {
  try {
    const result = readTaskState(resolve(repoRoot, STATE_PATH));
    if (!result.ok) return;
    const state = result.state;
    /** @type {{ implProgress?: import('../lib/types.mjs').ImplProgress, staleness?: import('../lib/task-staleness.mjs').Staleness }} */
    const anchorOpts = {};
    anchorOpts.staleness = computeTaskStaleness(repoRoot, state.workflowGate);
    // During implementation, join the trace with the persisted AC list so the
    // anchor shows which acceptance criteria remain, not just the gate.
    if (state.workflowGate === 'impl-started') {
      try {
        const { steps } = await readTrace(state.taskId, {
          traceDir: resolve(repoRoot, '.devmate/state/trace'),
        });
        anchorOpts.implProgress = summarizeImplProgress(
          completedAcNumbers(steps),
          state.acceptanceCriteria,
        );
      } catch (/** @type {unknown} */ err) {
        // A trace read failure must never block the anchor — emit without it.
        stderr.write(`[session-start] impl progress skipped (non-fatal): ${errMsg(err)}\n`);
      }
    }
    stdout.write(`${buildStateAnchor(state, anchorOpts)}\n`);
  } catch (/** @type {unknown} */ err) {
    stderr.write(`[session-start] state anchor skipped (non-fatal): ${errMsg(err)}\n`);
  }
}

/**
 * Single-root recall: query the repo ledger for the top-N most relevant facts
 * and emit a compact, model-visible `<devmate-memory>` block so the agent
 * starts with prior knowledge instead of re-inferring it. Emits nothing when
 * the ledger is missing/empty. Best-effort — never blocks the session.
 * @param {string} repoRoot
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
export async function emitMemoryContext(repoRoot, stdout, stderr) {
  try {
    const result = await queryMemory(
      repoLedgerPath(repoRoot),
      { topN: MEMORY_INJECT_TOP_N },
      // Verify-before-use: only inject facts whose source still resolves to
      // live code, so startup recall never points at moved/deleted files.
      { verifyRoot: repoRoot },
    );
    if (result.ok && result.matches.length > 0) {
      const block = buildMemoryContext(result.matches);
      if (block !== '') stdout.write(`${block}\n`);
    }
  } catch (/** @type {unknown} */ err) {
    stderr.write(
      `[session-start] memory injection skipped (non-fatal): ${errMsg(err)}\n`,
    );
  }
}

/**
 * Hook handler: SessionStart.
 * Reads the hook payload from stdin and idempotently seeds the .devmate layout.
 * Filters internally on hook_event_name — matchers are not relied upon.
 *
 * Everything this hook prints — the repo memories, the persona and domain
 * warnings, the state anchor that re-grounds a resumed session — went to stdout
 * as a mix of text and JSON lines. VS Code parses stdout as ONE JSON document on
 * exit 0, so a mixed stream is a parse failure and the entire bootstrap was
 * discarded (#77). It now leaves as `hookSpecificOutput.additionalContext`, the
 * documented channel for injecting context at session start — which is the first
 * time any of it has reached the model.
 * @param {string[]} _args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  const capture = createTextCapture();
  const code = await runWithIO(process.stdin, capture.stream, process.stderr);
  return writeHookOutput('SessionStart', capture.text(), code);
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
