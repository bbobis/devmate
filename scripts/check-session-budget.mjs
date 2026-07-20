// @ts-check
import { dirname, join, resolve } from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { renamePath, writeTextFile } from "../lib/fs-safe.mjs";
import { readJsonFile } from "../lib/json-io.mjs";
import { readBudget } from "../lib/context/output-contract.mjs";
import { compactAndReclaim } from "../lib/context/compaction.mjs";
import {
  checkBudget,
  checkTraceSize,
  formatTraceDiagnostic,
  formatWarning,
  measureSession,
  reportId,
} from "../lib/context/session-budget.mjs";
import {
  readContextMeter,
  recordToolResult,
  rememberReport,
} from "../lib/context/context-meter.mjs";
import { appendTraceEvent } from "../lib/trace/append.mjs";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import {
  EXIT_BLOCK,
  createTextCapture,
  writeHookOutput,
} from "../lib/hooks/output-schema.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { isDevmatePayload } from "../lib/hooks/session-marker.mjs";

/** TaskState path, relative to the resolved workspace root. */
const DEFAULT_TASK_STATE = ".devmate/state/task.json";

/**
 * Read the hook payload from stdin, best-effort. Returns `{}` when stdin is a
 * TTY (a developer running the script by hand), empty, or malformed — the
 * budget signal must never hang or crash on its own input.
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stdin
 * @returns {Promise<{ cwd?: string, tool_response?: unknown }>}
 */
async function readHookPayload(stdin) {
  if (stdin.isTTY) return {};
  /** @type {string} */
  let raw = "";
  try {
    raw = await readStreamText(stdin);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[BUDGET:stdin-error] ${msg}\n`);
    return {};
  }
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[BUDGET:stdin-error] malformed JSON: ${msg}\n`);
    return {};
  }
}

/** Trace schema version this script emits. */
const SCHEMA_VERSION = 1;

/** Marker filename written next to task.json on a critical breach (E9-08). */
export const BUDGET_CRITICAL_MARKER = "budget-critical.json";

/**
 * Write the budget-critical marker atomically (tmp + rename) next to the
 * TaskState file. Best-effort: failures warn to stderr, never change the
 * exit-code contract.
 * @param {string} taskStatePath
 * @param {import('../lib/types.mjs').BudgetCriticalMarker} marker
 * @returns {Promise<void>}
 */
async function writeCriticalMarker(taskStatePath, marker) {
  const markerPath = join(dirname(taskStatePath), BUDGET_CRITICAL_MARKER);
  const tmpPath = markerPath + ".tmp";
  await writeTextFile(tmpPath, JSON.stringify(marker, null, 2));
  await renamePath(tmpPath, markerPath);
}

/**
 * Read the persisted taskId from TaskState, or null on any error.
 * @param {string} taskStatePath
 * @returns {Promise<string|null>}
 */
async function readTaskId(taskStatePath) {
  const parsed = await readJsonFile(taskStatePath);
  const taskId =
    parsed !== null && typeof parsed === "object"
      ? /** @type {Record<string, unknown>} */ (parsed)["taskId"]
      : null;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/**
 * E4-6: `check-session-budget` — PostToolUse budget guard CLI (TCM-11).
 *
 * Measures the live session context component sizes, compares them against the
 * BudgetClass thresholds derived from the persisted OutputContract, and prints
 * a compact, actionable warning. A warning that never fires is worse than none,
 * so this always prints a status line — even when within budget.
 *
 * Usage:
 *   node scripts/check-session-budget.mjs [taskStatePath]
 *
 * With no argument (how hooks.json registers it) the TaskState path is resolved
 * against the workspace root from `resolveHookRoot(payload)`, exactly as every
 * other hook does. It used to be the bare RELATIVE string `.devmate/state/task.json`,
 * resolved against the hook process's cwd — so in any workspace whose cwd is not
 * the workspace root (the monoroot layout, where cwd lands inside a repo
 * subfolder), it looked for a task.json that was never there and reported
 * `[BUDGET:unclassified]` forever while `measureSession` measured nothing. That
 * is the #76 bug class, and this file was the last one still carrying it.
 *
 * When no OutputContract is persisted yet (unclassified session), a distinct
 * `[BUDGET:unclassified]` diagnostic is printed and the `standard` class is
 * assumed so the guard still produces a meaningful signal.
 *
 * On warn/critical a `budget_warning` trace event `{ field, current, limit }`
 * is appended to the active task trace (best-effort — a trace failure never
 * blocks the budget signal).
 *
 * #87 — this hook is also the context meter's only producer. The PostToolUse
 * payload's `tool_response` is the text the host feeds back to the model, so it
 * is the one thing devmate can see entering the context window. It is metered
 * here, before the measurement, so the snapshot includes the tool call that just
 * completed.
 *
 * Exit: 0 within budget; 1 on warn; 2 on critical.
 *
 * @param {string[]} args
 * @param {{ traceRoot?: string, repoRoot?: string, toolResponse?: unknown }} [opts]  Overrides for tests.
 * @returns {Promise<number>}
 */
export async function main(args, opts = {}) {
  // An explicit path arg wins (CLI + tests). Otherwise anchor on the workspace
  // root the host gives us, never on cwd. The payload is read once and used for
  // both the root and the tool result it carries.
  // stdin is read only when there is no explicit path arg — exactly as before.
  // A CLI/test invocation must never block waiting on a stream nobody will close;
  // those callers inject the tool result through `opts.toolResponse` instead.
  const payload = args[0] ? {} : await readHookPayload(process.stdin);

  // Runtime scope (hook-shaped invocation only — an explicit path arg is an
  // intentional CLI/test run and stays ungated): plugin-level hooks fire in
  // EVERY Copilot session, and this one used to inject a [BUDGET:unclassified]
  // line into every non-devmate session's context. Act only inside a marked
  // devmate session (lib/hooks/session-marker.mjs).
  if (!args[0] && !isDevmatePayload(payload)) return 0;

  const repoRoot = opts.repoRoot ?? (args[0] ? null : resolveHookRoot(payload));
  const taskStatePath = args[0]
    ? args[0]
    : resolve(/** @type {string} */ (repoRoot), DEFAULT_TASK_STATE);

  // This hook is registered on PostToolUse, and it printed its budget line as
  // human text. On exit 0 VS Code parses stdout as JSON, so the line the model
  // was meant to act on never reached it; on a non-zero exit the host does not
  // read stdout at all, so the CRITICAL warning — the one that matters — went
  // nowhere either. Collect the text and route it through the contract (#77).
  const capture = createTextCapture();

  // Meter what this tool call put into the model's context, before measuring.
  // Best-effort: a meter write failure must never block the tool call.
  const toolResponse = opts.toolResponse ?? payload.tool_response;
  try {
    await recordToolResult(taskStatePath, toolResponse);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[BUDGET:meter-error] failed to record tool result: ${msg}\n`);
  }

  const contract = await readBudget(taskStatePath);
  if (contract === null) {
    // E9-07: an unclassified session must be observable, never a silent default.
    capture.stream.write(
      `[BUDGET:unclassified] No OutputContract persisted at ${taskStatePath}; ` +
        `assuming standard thresholds. Run init-task-state (E9-06) to classify this task.\n`,
    );
  }
  const budgetClass = contract?.token_budget_class ?? "standard";

  const snapshot = await measureSession({ taskStatePath });
  const warning = checkBudget(snapshot, budgetClass);

  // #87 AC5: a warn that has not changed since the last tool call teaches the
  // model nothing, and re-emitting it on every PostToolUse is how the old guard
  // became background noise. Suppress an identical warn and exit clean; a
  // critical is always emitted, because it is blocking and the model needs the
  // reason each time it is stopped.
  const currentReportId = reportId(warning);
  const { lastReportId } = await readContextMeter(taskStatePath);
  const alreadyReported = warning.level === "warn" && currentReportId !== null && currentReportId === lastReportId;

  if (alreadyReported) {
    const trace = formatTraceDiagnostic(checkTraceSize(snapshot));
    if (trace !== "") capture.stream.write(`${trace}\n`);
    return writeHookOutput("PostToolUse", capture.text(), 0);
  }

  capture.stream.write(`${formatWarning(warning)}\n`);

  // The trace is reported on its own tag, never as a budget breach (#87 AC3):
  // it is an on-disk log, it is not in the model's context, and no code path
  // below can turn this line into a marker or a block.
  const traceLine = formatTraceDiagnostic(checkTraceSize(snapshot));
  if (traceLine !== "") capture.stream.write(`${traceLine}\n`);

  try {
    await rememberReport(taskStatePath, currentReportId);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[BUDGET:meter-error] failed to persist report key: ${msg}\n`);
  }

  if (warning.level === "warn" || warning.level === "critical") {
    // First production budget_warning emitter (E9-07). Best-effort: a trace
    // failure must never block the budget signal or change the exit code.
    const taskId = await readTaskId(taskStatePath);
    if (taskId !== null) {
      try {
        await appendTraceEvent(
          {
            type: "budget_warning",
            taskId,
            stepId: "session-budget",
            ts: new Date().toISOString(),
            schemaVersion: SCHEMA_VERSION,
            field: "session-total",
            current: snapshot.totalEstimatedTokens,
            limit: warning.thresholdTokens,
          },
          // The trace root must be the SAME root the state path came from —
          // re-deriving it from cwd is how the two drifted apart in the first
          // place. <root>/.devmate/state/task.json → up two levels is <root>.
          {
            root:
              opts.traceRoot ?? repoRoot ?? resolve(dirname(taskStatePath), "..", ".."),
          },
        );
      } catch (/** @type {unknown} */ err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[BUDGET:trace-error] failed to append budget_warning: ${msg}\n`);
      }
    } else {
      process.stderr.write(
        `[BUDGET:trace-error] no taskId in ${taskStatePath}; budget_warning not recorded\n`,
      );
    }
  }

  if (warning.level === "critical") {
    // #87: recover HERE, rather than telling a human to run a command.
    //
    // This hook detects the breach and already holds the correct workspace root —
    // it resolved it from the payload. The old design wrote the edit-blocking
    // marker, printed "run compaction", and left it to the user to paste a node
    // command into a terminal. A terminal resolves the workspace root from ITS
    // cwd, and in a multi-root workspace that is a different directory: the
    // compaction then ran against a task.json that was not there, cleared a marker
    // that did not exist at that path, reported success, and left the real marker
    // and the block exactly where they were. The component that knew the right
    // answer had handed the job to the one that did not.
    //
    // So the recovery runs in-process, with the root already resolved. The marker
    // is written ONLY if the reclaim failed to get back under the threshold — the
    // fail-closed block survives for a breach that genuinely cannot be reduced,
    // which is the only case where a human should be involved at all.
    const taskId = await readTaskId(taskStatePath);
    /** @type {import('../lib/types.mjs').BudgetWarning} */
    let after = warning;

    if (taskId !== null) {
      try {
        const { jsonPath, reset } = await compactAndReclaim({
          taskStatePath,
          outputDir: join(dirname(taskStatePath), "compaction"),
        });
        const remeasured = await measureSession({ taskStatePath });
        after = checkBudget(remeasured, budgetClass);

        capture.stream.write(
          `[BUDGET:compacted] Auto-compaction reclaimed ` +
            `${(snapshot.totalEstimatedTokens - remeasured.totalEstimatedTokens).toLocaleString("en-US")} tokens ` +
            `(${snapshot.totalEstimatedTokens.toLocaleString("en-US")} → ${remeasured.totalEstimatedTokens.toLocaleString("en-US")}). ` +
            `Artifact: ${jsonPath}\n`,
        );
        if (reset.sessionArchivedTo !== null) {
          capture.stream.write(`Session markdown archived: ${reset.sessionArchivedTo}\n`);
        }
        for (const err of reset.errors) {
          process.stderr.write(`[BUDGET:compact-error] ${err}\n`);
        }
      } catch (/** @type {unknown} */ err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[BUDGET:compact-error] auto-compaction failed: ${msg}\n`);
      }
    }

    if (after.level !== "critical") {
      // Recovered. Nothing is blocked, and no human was needed. The meter write
      // is best-effort like every other one in this hook: the recovery already
      // happened, and failing to record a report id must not turn a successful
      // recovery into a failed tool call.
      try {
        await rememberReport(taskStatePath, reportId(after));
      } catch (/** @type {unknown} */ err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[BUDGET:meter-error] failed to persist report id: ${msg}\n`);
      }
      return writeHookOutput("PostToolUse", capture.text(), 0);
    }

    // E9-08: still critical after reclaiming everything there is to reclaim. The
    // marker makes the gate guard deny further non-cleanup source edits — the
    // fail-closed stop, now reserved for a breach that compaction could not fix.
    try {
      await writeCriticalMarker(taskStatePath, {
        at: new Date().toISOString(),
        field: "session-total",
        current: after.snapshot.totalEstimatedTokens,
        limit: after.thresholdTokens,
      });
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[BUDGET:marker-error] failed to write budget-critical marker: ${msg}\n`);
    }
    capture.stream.write(
      "[BUDGET:critical] Still over the critical threshold after auto-compaction — " +
        "there is nothing left to reclaim. Source edits are blocked until the context shrinks.\n",
    );
    // Exit 2 is the documented blocking error, and its stderr is what the model
    // is shown — which is exactly where a critical budget breach belongs.
    return writeHookOutput('PostToolUse', capture.text(), EXIT_BLOCK);
  }
  if (warning.level === "warn") return writeHookOutput('PostToolUse', capture.text(), 1);
  return writeHookOutput('PostToolUse', capture.text(), 0);
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
