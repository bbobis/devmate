// @ts-check
// E4-6: session-budget checker (TCM-11). A budget warning that never fires is
// worse than no budget system — it lets context silently overflow. This module
// measures the real context component sizes, compares them against BudgetClass
// caps, and emits compact, actionable warnings. It is pure where it can be:
// checkBudget, checkTraceSize, reportId and formatWarning have no I/O; only
// measureSession and resetContextBudget touch disk.
//
// #87 — what this module is allowed to count.
//
// It used to sum the byte size of the per-task trace JSONL into the context
// total. The trace is an append-only hook event log that is NEVER injected into
// the model's prompt (it is read on demand by buildResumePlan and the
// session-start progress line, and nowhere else). It was also the only counted
// component with real bytes in it, so it drove every budget warning the plugin
// ever emitted — and it only ever grows. Three consequences, all shipped:
//
//   1. The warning named a component that is not in context (a category error).
//   2. It re-fired on every PostToolUse forever, because nothing trims a trace.
//   3. At critical it wrote budget-critical.json, which makes the gate guard
//      deny every source edit — and compaction, the advertised remedy, cleared
//      the marker without shrinking the trace. The next tool call re-measured
//      the same file and rewrote the marker. Edits were blocked permanently.
//
// The rule this module now holds: a context budget counts what enters the
// prompt, and every counted component must be one COMPACTION CAN REDUCE. That
// second half is not a nicety — it is what makes a critical breach recoverable
// instead of a livelock. measureSession and resetContextBudget therefore live
// side by side, and a component added to one must be handled in the other.
//
// The trace is still measured — a runaway trace is a real operational signal —
// but it is reported through its own non-blocking diagnostic (checkTraceSize),
// which can never write the marker and can never block an edit.
import { dirname, resolve } from "node:path";
import { readTextFile, removeFileSync, statPath, writeTextFile } from "../fs-safe.mjs";
import { readJsonFile } from "../json-io.mjs";
import { traceFilePath } from "../trace/append.mjs";
import { estimateTokens } from "./estimate-tokens.mjs";
import { readContextMeter, resetContextMeter } from "./context-meter.mjs";
import { getOwn } from "../object-utils.mjs";

/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../types.mjs').BudgetSnapshot} BudgetSnapshot */
/** @typedef {import('../types.mjs').BudgetWarning} BudgetWarning */
/** @typedef {import('../types.mjs').TraceSizeDiagnostic} TraceSizeDiagnostic */
/** @typedef {import('../types.mjs').ContextBudgetReset} ContextBudgetReset */

/** Default session markdown path (relative to the workspace root). */
const DEFAULT_SESSION_PATH = ".devmate/session.md";
/** Marker filename written next to task.json on a critical breach (E9-08). */
const BUDGET_CRITICAL_MARKER = "budget-critical.json";
// There is deliberately no DEFAULT_TRACE_FILE. It used to be
// `.devmate/state/trace.jsonl` — a single-file trace layout that no longer
// exists; the real trace is per-task at `.devmate/state/trace/<taskId>.jsonl`.
// So `safeSize` always stat'd a file that was never there and the trace
// component of every budget snapshot measured 0 bytes. The trace path is now
// derived from the task's own id via `traceFilePath`, the one function that
// owns that layout.
// Byte->token conversion is delegated to the shared canonical estimator
// (lib/context/estimate-tokens.mjs, UTF-8 bytes / 4) — E9-09.

/**
 * Per-class warn/critical token thresholds.
 * @type {Record<BudgetClass, { warn: number, critical: number }>}
 */
const THRESHOLDS = {
  tiny: { warn: 2000, critical: 4000 },
  standard: { warn: 8000, critical: 16000 },
  large: { warn: 20000, critical: 40000 },
};

/**
 * The per-class token budget the evidence packer (#30) fills: the WARN
 * threshold — the point at which context is "getting full", so the packer keeps
 * admitted evidence under it. Reads the canonical {@link THRESHOLDS} rather than
 * duplicating the numbers; an unknown class falls back to `standard`.
 * @param {BudgetClass} budgetClass
 * @returns {number}
 */
export function tokenBudgetForClass(budgetClass) {
  return (getOwn(THRESHOLDS, budgetClass) ?? THRESHOLDS.standard).warn;
}

/**
 * Size at which the trace file itself is worth mentioning. This is a diagnostic
 * threshold, not a budget: crossing it costs the model nothing, because the
 * trace is not in its context. It is reported because a trace growing without
 * bound is evidence of a loop.
 * TODO: calibrate — provisional placeholder
 */
export const TRACE_DIAGNOSTIC_TOKENS = 25000;

/**
 * The one cleanup mechanism that exists.
 *
 * Every string in `cleanupActions` must name something a caller can actually
 * run. The old list ("Unload unused skills", "Cap or trim session markdown",
 * "Trim the largest component: Trace summaries") named three things that are
 * implemented nowhere — the model was handed unactionable advice on every turn,
 * and the one component it was told to trim had no trimmer at all. There is
 * exactly one mechanism, `compact-session`, and after #87 it genuinely reduces
 * every component this module counts.
 */
const COMPACT_ACTION =
  "Run compact-session (scripts/compact-session.mjs) — it archives the session markdown, " +
  "clears the recorded tool-output pointer, and resets the context meter";

/**
 * Size of a file in bytes, or 0 if it is absent/unreadable. Never throws.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function safeSize(filePath) {
  try {
    const st = await statPath(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Read and parse a TaskState JSON file, or return an empty object on any error.
 * @param {string} taskStatePath
 * @returns {Promise<Record<string, any>>}
 */
async function readState(taskStatePath) {
  try {
    const raw = await readTextFile(taskStatePath);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the paths of the components a session is made of. Shared by
 * measureSession (which sizes them) and resetContextBudget (which reduces
 * them), so the two can never disagree about what a session contains.
 * @param {Record<string, any>} state  Parsed TaskState (possibly empty).
 * @param {string} repoRoot
 * @returns {{ sessionPath: string, traceFile: string|null, lastToolOutputPath: string|null }}
 */
function resolveComponentPaths(state, repoRoot) {
  const sessionPath = resolve(
    repoRoot,
    typeof state.sessionPath === "string" ? state.sessionPath : DEFAULT_SESSION_PATH,
  );
  // The trace lives at <root>/.devmate/state/trace/<taskId>.jsonl. With no
  // taskId there is no trace to measure — 0 bytes, honestly, rather than a
  // stat against a path that cannot exist.
  const traceFile =
    typeof state.traceFile === "string"
      ? resolve(repoRoot, state.traceFile)
      : typeof state.taskId === "string" && state.taskId !== ""
        ? traceFilePath(state.taskId, repoRoot)
        : null;
  const lastToolOutputPath =
    typeof state.lastToolOutputPath === "string"
      ? resolve(repoRoot, state.lastToolOutputPath)
      : null;
  return { sessionPath, traceFile, lastToolOutputPath };
}

/**
 * <root>/.devmate/state/task.json → up two levels is <root>.
 * @param {string} taskStatePath
 * @returns {string}
 */
function rootFromTaskState(taskStatePath) {
  return resolve(dirname(taskStatePath), "..", "..");
}

/**
 * Measure current session context component sizes. Any absent file counts as
 * 0 bytes — this function never throws on missing inputs.
 *
 * Every path is anchored on the workspace root, not on cwd. A relative path
 * recorded in TaskState (or the default) resolves against `repoRoot`; an
 * absolute one is used as-is. Resolving these against the process cwd is how
 * the budget silently measured nothing in any workspace whose cwd is not the
 * root (the monoroot layout).
 *
 * `traceSummaryBytes` is measured but NOT summed into `totalEstimatedTokens` —
 * see the module header. The context total is the components that actually
 * enter the prompt: the session markdown, the recorded tool output, and the
 * running context meter (the tool results the host has fed back to the model).
 *
 * @param {{ taskStatePath: string, repoRoot?: string, traceDir?: string, skillsDir?: string }} opts
 * @returns {Promise<BudgetSnapshot>}
 */
export async function measureSession(opts) {
  const state = await readState(opts.taskStatePath);
  const repoRoot = opts.repoRoot ?? rootFromTaskState(opts.taskStatePath);
  const { sessionPath, traceFile, lastToolOutputPath } = resolveComponentPaths(state, repoRoot);

  const loadedSkills = Array.isArray(state.loadedSkills) ? state.loadedSkills : [];

  const sessionMarkdownBytes = await safeSize(sessionPath);
  const traceSummaryBytes = traceFile ? await safeSize(traceFile) : 0;
  const recentToolOutputBytes = lastToolOutputPath ? await safeSize(lastToolOutputPath) : 0;
  const { contextTokens } = await readContextMeter(opts.taskStatePath);

  const totalEstimatedTokens =
    estimateTokens(sessionMarkdownBytes + recentToolOutputBytes) + contextTokens;

  return {
    sessionMarkdownBytes,
    traceSummaryBytes,
    loadedSkillCount: loadedSkills.length,
    recentToolOutputBytes,
    contextTokens,
    totalEstimatedTokens,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Identify the dominant (largest) IN-CONTEXT component for messaging.
 *
 * The trace is deliberately not a candidate: naming it as "the largest
 * component" is what produced `Trim the largest component: Trace summaries` on
 * every tool call — an instruction to trim a file that is not in context and
 * that nothing can trim.
 * @param {BudgetSnapshot} snapshot
 * @returns {{ label: string, tokens: number }}
 */
function dominantComponent(snapshot) {
  const components = [
    { label: "Session markdown", tokens: estimateTokens(snapshot.sessionMarkdownBytes) },
    { label: "Recent tool output", tokens: estimateTokens(snapshot.recentToolOutputBytes) },
    { label: "Tool results in context", tokens: snapshot.contextTokens },
  ];
  components.sort((a, b) => b.tokens - a.tokens);
  return components[0];
}

/**
 * Compare a BudgetSnapshot against the BudgetClass thresholds. Pure.
 * @param {BudgetSnapshot} snapshot
 * @param {BudgetClass} budgetClass
 * @returns {BudgetWarning}
 */
export function checkBudget(snapshot, budgetClass) {
  const t = getOwn(THRESHOLDS, budgetClass) ?? THRESHOLDS.standard;
  const total = snapshot.totalEstimatedTokens;
  const dom = dominantComponent(snapshot);

  if (total < t.warn) {
    return {
      level: "ok",
      message: `Within budget: ${total.toLocaleString("en-US")} tokens (${budgetClass} warn threshold: ${t.warn.toLocaleString("en-US")})`,
      cleanupActions: [],
      snapshot,
      thresholdTokens: t.warn,
    };
  }

  const breached = total < t.critical ? "warn" : "critical";
  const threshold = breached === "warn" ? t.warn : t.critical;
  return {
    level: breached,
    message:
      `Context is ${total.toLocaleString("en-US")} tokens ` +
      `(${budgetClass} ${breached} threshold: ${threshold.toLocaleString("en-US")}); ` +
      `largest component: ${dom.label} at ${dom.tokens.toLocaleString("en-US")} tokens`,
    cleanupActions: [COMPACT_ACTION],
    snapshot,
    thresholdTokens: threshold,
  };
}

/**
 * The trace-size diagnostic (#87 AC3). Pure, and deliberately separate from
 * checkBudget: the trace is not in context, so it gets its own tag and its own
 * threshold, it never contributes to a BudgetWarning level, and no caller may
 * turn it into a marker or a block. Its remedy is to look at why the trace is
 * growing, not to "trim" it.
 * @param {BudgetSnapshot} snapshot
 * @param {number} [limitTokens]
 * @returns {TraceSizeDiagnostic}
 */
export function checkTraceSize(snapshot, limitTokens = TRACE_DIAGNOSTIC_TOKENS) {
  const tokens = estimateTokens(snapshot.traceSummaryBytes);
  if (tokens < limitTokens) {
    return { level: "ok", tokens, limitTokens, message: "" };
  }
  return {
    level: "warn",
    tokens,
    limitTokens,
    message:
      `Trace file is ${tokens.toLocaleString("en-US")} tokens ` +
      `(diagnostic threshold: ${limitTokens.toLocaleString("en-US")}). ` +
      "The trace is an on-disk event log, not context — this does not consume the model's " +
      "window and nothing is blocked. A trace growing without bound usually means a loop.",
  };
}

/**
 * The identity of a budget report: same level, same dominant component, same
 * size bucket → the same line, and re-printing it teaches the model nothing.
 * Pure. The bucket is coarse (quarter of the threshold) so that a breach that
 * is genuinely getting worse still re-reports.
 * @param {BudgetWarning} warning
 * @returns {string|null} Null when there is nothing to report (level ok).
 */
export function reportId(warning) {
  if (warning.level === "ok") return null;
  const bucketSize = Math.max(1, Math.round(warning.thresholdTokens / 4));
  const bucket = Math.floor(warning.snapshot.totalEstimatedTokens / bucketSize);
  return `${warning.level}:${dominantComponent(warning.snapshot).label}:${bucket}`;
}

/**
 * Format a BudgetWarning as a compact one-block string for hook output. Pure.
 * @param {BudgetWarning} warning
 * @returns {string}
 */
export function formatWarning(warning) {
  if (warning.level === "ok") {
    return "[BUDGET:ok] Within budget.";
  }
  return `[BUDGET:${warning.level}] ${warning.message}\nActions: ${warning.cleanupActions.join(" | ")}`;
}

/**
 * Format a trace diagnostic for hook output, or "" when there is nothing to
 * say. Pure.
 * @param {TraceSizeDiagnostic} diagnostic
 * @returns {string}
 */
export function formatTraceDiagnostic(diagnostic) {
  return diagnostic.level === "ok" ? "" : `[TRACE:size] ${diagnostic.message}`;
}

/**
 * Reduce every component `measureSession` counts, so the next measurement of
 * this session is strictly smaller. This is the other half of the budget: a
 * `critical` level blocks source edits (via the gate guard's budget-critical
 * marker), so a critical breach that CANNOT be reduced is a livelock, not a
 * guard. Compaction calls this; nothing else needs to.
 *
 * It is deliberately in this file, next to `measureSession`: a component that is
 * counted there and not reduced here re-breaches immediately, and the pair being
 * adjacent is what makes that hard to ship. Concretely, it:
 *
 *   - archives the session markdown and leaves a pointer stub in its place
 *     (TCM-3: the content moves out of context, a pointer stays behind);
 *   - clears the recorded tool-output pointer from TaskState;
 *   - zeroes the context meter — the compacted window no longer holds the tool
 *     results it counted;
 *   - clears the budget-critical marker, so the gate guard lets edits resume.
 *
 * Best-effort by design: every step is independently guarded, because this runs
 * inside PreCompact and a failure to tidy one component must not abort the
 * compaction that is the caller's actual job.
 *
 * @param {{ taskStatePath: string, archivePath: string, repoRoot?: string }} opts
 *   `archivePath` is where the session markdown is moved to — the caller derives
 *   it from the compaction artifact it just wrote, so each compaction archives
 *   to its own file.
 * @returns {Promise<ContextBudgetReset>}
 */
export async function resetContextBudget(opts) {
  const { taskStatePath, archivePath } = opts;
  const repoRoot = opts.repoRoot ?? rootFromTaskState(taskStatePath);

  /** @type {ContextBudgetReset} */
  const result = {
    sessionArchivedTo: null,
    toolOutputPointerCleared: false,
    contextMeterReset: false,
    markerCleared: false,
    errors: [],
  };

  const state = await readState(taskStatePath);
  const { sessionPath } = resolveComponentPaths(state, repoRoot);

  // 1. Session markdown → archive, leaving a pointer stub behind.
  try {
    if ((await safeSize(sessionPath)) > 0) {
      const contents = await readTextFile(sessionPath);
      await writeTextFile(archivePath, contents);
      await writeTextFile(
        sessionPath,
        "# Session (compacted)\n\n" +
          `The pre-compaction session notes were archived to ${archivePath}.\n` +
          "Resume from the compaction artifact alongside it.\n",
      );
      result.sessionArchivedTo = archivePath;
    }
  } catch (/** @type {unknown} */ err) {
    result.errors.push(`session markdown not archived: ${errMsg(err)}`);
  }

  // 2. The recorded tool-output pointer.
  try {
    if (typeof state.lastToolOutputPath === "string") {
      const parsed = await readJsonFile(taskStatePath);
      if (parsed !== null && typeof parsed === "object") {
        const next = { .../** @type {Record<string, unknown>} */ (parsed), lastToolOutputPath: null };
        await writeTextFile(taskStatePath, JSON.stringify(next, null, 2));
        result.toolOutputPointerCleared = true;
      }
    }
  } catch (/** @type {unknown} */ err) {
    result.errors.push(`tool-output pointer not cleared: ${errMsg(err)}`);
  }

  // 3. The context meter.
  try {
    await resetContextMeter(taskStatePath);
    result.contextMeterReset = true;
  } catch (/** @type {unknown} */ err) {
    result.errors.push(`context meter not reset: ${errMsg(err)}`);
  }

  // 4. The budget-critical marker — the thing the gate guard reads. Cleared
  //    last, and only after the components above have actually shrunk, so the
  //    marker is never removed on the strength of a recovery that did not
  //    happen.
  try {
    removeFileSync(resolve(dirname(taskStatePath), BUDGET_CRITICAL_MARKER));
    result.markerCleared = true;
  } catch (/** @type {unknown} */ err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
    if (code !== "ENOENT") result.errors.push(`marker not cleared: ${errMsg(err)}`);
  }

  return result;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
