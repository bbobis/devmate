// @ts-check
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { appendTextFile, ensureDir, readTextFileSync } from "../lib/fs-safe.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { buildResumePlan } from "../lib/resume/plan.mjs";
import { STATE_PATH } from "../lib/task-state.mjs";
import { TRACE_DIR } from "../lib/trace/append.mjs";
import { withAppendLock } from "../lib/trace/lock.mjs";
import { validateTraceEvent } from "../lib/trace/schema.mjs";

/** @typedef {import('../lib/types.mjs').ResumePlan} ResumePlan */
/** @typedef {import('../lib/types.mjs').TraceStepCompleteEvent} TraceStepCompleteEvent */

/**
 * E6-5: `resume` — the single canonical resume entry point.
 *
 * Reads a task's trace (and optional handoff) via buildResumePlan, prints a
 * compact plan, and enforces no-repeat-work semantics. Also writes the plan
 * summary to .devmate/state/resume-plan.json so the agent can read_file when
 * shell integration is absent (E11-1).
 *
 * Flags:
 *   --task <taskId>     Required. Which task to resume.
 *   --trace-dir <dir>   Optional. Directory holding trace files (tests).
 *   --handoff-dir <dir> Optional. Directory holding handoff artifacts (tests).
 *   --confirm           Proceed past a confirm_needed (malformed-line) plan.
 *   --strategy-change   Unblock a halted step by appending a strategy-change marker.
 *   --dry-run           Print the plan; never mutate trace state.
 *
 * Exit codes:
 *   0 = proceed or already complete
 *   1 = error (missing taskId, unreadable trace)
 *   2 = blocked (requires a human decision)
 *
 * Never prints raw trace content — only ResumePlan fields.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const valueOf = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    const next = args.at(i + 1);
    return i !== -1 && next ? next : undefined;
  };

  const taskId = valueOf("--task");
  const traceDir = valueOf("--trace-dir");
  const handoffDir = valueOf("--handoff-dir");
  // Trace/handoff dirs default internally (TRACE_DIR/HANDOFF_DIR); the
  // compaction load is opt-in per dir, so default it to the canonical location.
  const compactionDir = valueOf("--compaction-dir") ?? ".devmate/state/compaction";
  const confirm = args.includes("--confirm");
  const strategyChange = args.includes("--strategy-change");
  const dryRun = args.includes("--dry-run");

  if (!taskId) {
    process.stdout.write(
      "Usage: resume --task [taskId] [--trace-dir [dir]] [--handoff-dir [dir]] " +
        "[--compaction-dir [dir]] [--confirm] [--strategy-change] [--dry-run]\n",
    );
    return 1;
  }

  // Feed the persisted acceptance-criteria labels so per-AC progress is
  // authoritative on the manual resume path exactly as it is via
  // scripts/session-start.mjs. Without this, implProgress.total is 0, the
  // already_complete -> proceed correction in buildResumePlan never fires, and
  // an AC-incomplete task is wrongly reported "nothing to resume" (AC-4).
  const acceptanceCriteria = resolveAcceptanceCriteria();

  /** @type {ResumePlan} */
  let plan;
  try {
    plan = await buildResumePlan(taskId, {
      traceDir,
      handoffDir,
      compactionDir,
      acceptanceCriteria,
    });
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`ERROR: could not build resume plan: ${msg}\n`);
    return 1;
  }

  // Write plan summary to state file so agent can read_file (E11-1). Carry
  // implProgress so the manual path's resume-plan.json reports per-AC progress
  // equivalently to the session-start path for identical state (AC-4).
  const planSummary = {
    taskId: plan.taskId,
    action: plan.action,
    message: plan.message,
    nextStepId: plan.nextStepId ?? null,
    nextStepLabel: plan.nextStepLabel ?? null,
    handoffAvailable: plan.handoffAvailable,
    implProgress: plan.implProgress ?? null,
  };
  await writeResult(".devmate/state/resume-plan.json", planSummary);

  printPlan(plan, { dryRun });

  switch (plan.action) {
    case "already_complete":
      return 0;

    case "proceed":
      return 0;

    case "confirm_needed":
      if (confirm) {
        process.stdout.write("Confirmed: proceeding past malformed lines.\n");
        return 0;
      }
      process.stdout.write("Blocked: re-run with --confirm to proceed.\n");
      return 2;

    case "blocked_halt":
      if (!strategyChange) {
        process.stdout.write(
          "Blocked: re-run with --strategy-change to retry with a new approach.\n",
        );
        return 2;
      }
      if (dryRun) {
        process.stdout.write(
          "Dry run: would append a strategy-change marker; no state written.\n",
        );
        return 0;
      }
      await appendStrategyChange(taskId, plan, traceDir);
      process.stdout.write(
        "Strategy change recorded as a new step; resume with the new approach.\n",
      );
      return 0;

    default:
      // Exhaustive guard — unreachable for the known ResumeAction union.
      process.stdout.write(`ERROR: unknown action "${plan.action}".\n`);
      return 1;
  }
}

/**
 * Resolve the persisted, ordered acceptance-criteria labels from task state so
 * `buildResumePlan` can report authoritative per-AC progress on the manual
 * resume path. Mirrors `scripts/session-start.mjs`: read the canonical
 * `.devmate/state/task.json` (resolved against the repo root, which for this CLI
 * is `process.cwd()` — the same cwd the resume-plan output is written under) and
 * accept `acceptanceCriteria` only when it is an array of strings.
 *
 * Best-effort by design: a missing, unreadable, or malformed task.json (a fresh
 * session or a non-feature task) yields `undefined`, leaving the trace as the
 * sole source of truth exactly as before — this never throws and never blocks a
 * resume.
 * @returns {string[]|undefined}
 */
function resolveAcceptanceCriteria() {
  try {
    const state = JSON.parse(readTextFileSync(path.resolve(STATE_PATH)));
    const ac = state?.acceptanceCriteria;
    if (
      Array.isArray(ac) &&
      ac.every((/** @type {unknown} */ v) => typeof v === "string")
    ) {
      return ac;
    }
  } catch {
    // Fresh session / no task state / malformed JSON — trace stays authoritative.
  }
  return undefined;
}

/**
 * Print only ResumePlan fields (never raw trace content).
 * @param {ResumePlan} plan
 * @param {{ dryRun: boolean }} flags
 * @returns {void}
 */
function printPlan(plan, flags) {
  process.stdout.write(`task: ${plan.taskId}\n`);
  process.stdout.write(`action: ${plan.action}\n`);
  process.stdout.write(`message: ${plan.message}\n`);
  process.stdout.write(`nextStepId: ${plan.nextStepId ?? "none"}\n`);
  process.stdout.write(`nextStepLabel: ${plan.nextStepLabel ?? "none"}\n`);
  process.stdout.write(`handoffAvailable: ${plan.handoffAvailable}\n`);
  if (flags.dryRun)
    process.stdout.write("mode: dry-run (no state will be written)\n");
}

/**
 * Clear a halt by appending a step_complete strategy-change marker with a new
 * stepId so the halted step is never re-dispatched as-is.
 *
 * Writes to the EXACT file the trace reader uses (`<traceDir>/<taskId>.jsonl`,
 * defaulting traceDir to TRACE_DIR) so reader and writer always agree. The
 * append is validated and serialized via withAppendLock.
 * @param {string} taskId
 * @param {ResumePlan} plan
 * @param {string|undefined} traceDir
 * @returns {Promise<void>}
 */
async function appendStrategyChange(taskId, plan, traceDir) {
  const blocked = plan.traceSummary.currentBlocked;
  const baseLabel = blocked ? blocked.label : (plan.nextStepLabel ?? "step");

  /** @type {TraceStepCompleteEvent} */
  const event = {
    type: "step_complete",
    taskId,
    stepId: randomUUID(),
    ts: new Date().toISOString(),
    schemaVersion: 1,
    label: `${baseLabel}-strategy-change`,
    artifactPaths: [],
  };

  const { ok, errors } = validateTraceEvent(event);
  if (!ok) {
    throw new Error(`strategy-change event invalid: ${errors.join("; ")}`);
  }

  const dir = traceDir ?? TRACE_DIR;
  const filePath = path.join(dir, `${taskId}.jsonl`);
  const line = JSON.stringify(event) + "\n";

  await withAppendLock(filePath, async () => {
    await ensureDir(dir);
    await appendTextFile(filePath, line);
  });
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
