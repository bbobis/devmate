// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTrace } from "../lib/trace/read-trace.mjs";

/**
 * E6-2: `resume-status` — agent-invoked resume planner.
 *
 * Reads a task's trace via the canonical `readTrace` reader and prints a
 * compact, human-readable `ResumeSummary`. Also writes a structured JSON result
 * to .devmate/state/resume-status-result.json so the agent can read_file when
 * shell integration is absent (E11-1).
 *
 * Never pastes raw trace content — only the summary fields.
 *
 * Flags:
 *   --task <taskId>       Required. Which task's trace to inspect.
 *   --trace-dir <dir>     Optional. Directory holding trace files (tests).
 *
 * Exit: 1 if any malformed lines OR a currently-blocked step; else 0.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let taskId;
  const tIdx = args.indexOf("--task");
  const tVal = args.at(tIdx + 1);
  if (tIdx !== -1 && tVal) taskId = tVal;

  let traceDir;
  const dIdx = args.indexOf("--trace-dir");
  const dVal = args.at(dIdx + 1);
  if (dIdx !== -1 && dVal) traceDir = dVal;

  if (!taskId) {
    process.stdout.write(
      "Usage: resume-status --task [taskId] [--trace-dir [dir]]\n",
    );
    return 1;
  }

  const { summary, totalLines } = await readTrace(taskId, { traceDir });

  const lc = summary.lastCompleted;
  const cb = summary.currentBlocked;

  const ok = summary.malformedCount === 0 && !cb;

  // Structured result for agent read_file consumption (E11-1).
  const structured = {
    taskId,
    totalLines,
    lastCompleted: lc
      ? { stepId: lc.stepId, label: lc.label, ts: lc.ts }
      : null,
    currentBlocked: cb
      ? { stepId: cb.stepId, label: cb.label, ts: cb.ts }
      : null,
    nextLegalAction: summary.nextLegalAction ?? "task complete",
    malformedCount: summary.malformedCount,
    malformedLines: summary.malformedCount > 0 ? summary.malformedLines : [],
    ok,
  };
  await writeResult(".devmate/state/resume-status-result.json", structured);

  // Human-readable stdout output (preserved for backward compatibility).
  process.stdout.write(`task: ${taskId}\n`);
  process.stdout.write(`totalLines: ${totalLines}\n`);
  process.stdout.write(
    lc
      ? `lastCompleted: ${lc.stepId} (label: ${lc.label}, ts: ${lc.ts})\n`
      : "lastCompleted: none\n",
  );
  process.stdout.write(
    cb
      ? `currentBlocked: ${cb.stepId} (label: ${cb.label}, ts: ${cb.ts})\n`
      : "currentBlocked: none\n",
  );
  process.stdout.write(
    `nextLegalAction: ${summary.nextLegalAction ?? "task complete"}\n`,
  );
  process.stdout.write(`malformedCount: ${summary.malformedCount}\n`);
  if (summary.malformedCount > 0) {
    process.stdout.write(
      `malformedLines: ${summary.malformedLines.join(", ")}\n`,
    );
  }

  if (summary.malformedCount > 0) {
    process.stdout.write("FAIL: trace contains malformed lines\n");
    return 1;
  }
  if (cb) {
    process.stdout.write("FAIL: task has a blocked step awaiting resolution\n");
    return 1;
  }
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
