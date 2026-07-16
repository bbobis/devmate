// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { readTextFile } from "../lib/fs-safe.mjs";
import { traceFilePath } from "../lib/trace/append.mjs";
import { validateTraceEvent } from "../lib/trace/schema.mjs";

/**
 * E6-1: `view-trace` — agent-invoked summary viewer for a task's trace file.
 *
 * Reads `.devmate/state/trace/<taskId>.jsonl` line by line, counts good /
 * malformed lines, prints a compact summary (counts by type + last N events),
 * and flags any `loop_halt` or `budget_warning`.
 *
 * Flags:
 *   --task <taskId>   Required. Which task's trace to view.
 *   --last <n>        Optional. How many trailing events to print (default 20).
 *   --root <dir>      Optional. Base dir (tests inject a tmp dir).
 *
 * Exit: 1 if malformed-line ratio > 5% OR any `loop_halt` present; else 0.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let taskId;
  const tIdx = args.indexOf("--task");
  const tVal = args.at(tIdx + 1);
  if (tIdx !== -1 && tVal) taskId = tVal;

  let last = 20;
  const lIdx = args.indexOf("--last");
  const lVal = args.at(lIdx + 1);
  if (lIdx !== -1 && lVal) {
    const parsed = Number(lVal);
    if (Number.isFinite(parsed) && parsed >= 0) last = Math.floor(parsed);
  }

  let root = ".";
  const rIdx = args.indexOf("--root");
  const rVal = args.at(rIdx + 1);
  if (rIdx !== -1 && rVal) root = rVal;

  if (!taskId) {
    process.stdout.write("Usage: view-trace --task [taskId] [--last [n]]\n");
    return 1;
  }

  const filePath = traceFilePath(taskId, root);

  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(filePath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === "ENOENT") {
      process.stdout.write(
        `No trace file found for task "${taskId}" at ${filePath}\n`,
      );
      return 1;
    }
    throw err;
  }

  const rawLines = raw.split("\n").filter((l) => l.trim().length > 0);

  /** @type {Map<string, number>} */
  const typeCounts = new Map();
  /** @type {import('../lib/types.mjs').TraceEvent[]} */
  const goodEvents = [];
  let malformed = 0;
  let halts = 0;
  let warnings = 0;

  // E11-3: Buckets for rubber-duck stage rendering.
  /** @type {import('../lib/types.mjs').GrillCompleteEvent[]} */
  const grillEvents = [];
  /** @type {import('../lib/types.mjs').CritiqueCompleteEvent[]} */
  const critiqueEvents = [];
  /** @type {import('../lib/types.mjs').PlanRevisedEvent[]} */
  const planRevisedEvents = [];

  for (const lineText of rawLines) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      malformed += 1;
      continue;
    }
    const { ok } = validateTraceEvent(parsed);
    if (!ok) {
      malformed += 1;
      continue;
    }
    const ev = /** @type {import('../lib/types.mjs').TraceEvent} */ (parsed);
    goodEvents.push(ev);
    typeCounts.set(ev.type, (typeCounts.get(ev.type) ?? 0) + 1);
    if (ev.type === "loop_halt") halts += 1;
    if (ev.type === "budget_warning") warnings += 1;
    if (ev.type === "grill_complete") {
      grillEvents.push(
        /** @type {import('../lib/types.mjs').GrillCompleteEvent} */ (ev),
      );
    } else if (ev.type === "critique_complete") {
      critiqueEvents.push(
        /** @type {import('../lib/types.mjs').CritiqueCompleteEvent} */ (ev),
      );
    } else if (ev.type === "plan_revised") {
      planRevisedEvents.push(
        /** @type {import('../lib/types.mjs').PlanRevisedEvent} */ (ev),
      );
    }
  }

  const total = rawLines.length;
  const malformedRatio = total > 0 ? malformed / total : 0;

  // --- Summary output ---
  process.stdout.write(`Trace: ${filePath}\n`);
  process.stdout.write(
    `Lines: ${total} total / ${goodEvents.length} valid / ${malformed} malformed\n`,
  );

  process.stdout.write("Counts by type:\n");
  for (const t of [...typeCounts.keys()].sort()) {
    process.stdout.write(`  ${t}: ${typeCounts.get(t)}\n`);
  }

  const lastEvents = last > 0 ? goodEvents.slice(-last) : [];
  process.stdout.write(`Last ${lastEvents.length} event(s):\n`);
  for (const ev of lastEvents) {
    process.stdout.write(`  ${ev.ts}  ${ev.stepId}  ${ev.type}\n`);
  }

  // E11-3: Rubber-duck stage summary sections. Each section renders only when
  // its event bucket has entries — no empty headers in the output.
  if (grillEvents.length > 0) {
    process.stdout.write("\n🦆 Grill:\n");
    for (const ev of grillEvents) {
      const wrong = ev.assumptions.length;
      const edge = ev.edgeCases.length;
      const corner = ev.cornerCases.length;
      const blocking = ev.blockingQuestions.length;
      process.stdout.write(
        `  ${ev.ts}  assumptions=${wrong} edgeCases=${edge} cornerCases=${corner} blockingQuestions=${blocking}\n`,
      );
      for (const ec of ev.edgeCases) {
        process.stdout.write(`    edge: ${ec}\n`);
      }
      for (const bq of ev.blockingQuestions) {
        process.stdout.write(`    blocking: ${bq}\n`);
      }
    }
  }

  if (critiqueEvents.length > 0) {
    process.stdout.write("\n🦆 Critique:\n");
    for (const ev of critiqueEvents) {
      const missing = ev.missingTests.length;
      const risks = ev.risks.length;
      process.stdout.write(
        `  ${ev.ts}  iteration=${ev.iterationNumber} verdict=${ev.verdict} missingTests=${missing} risks=${risks}\n`,
      );
      for (const mt of ev.missingTests) {
        process.stdout.write(`    missing-test: ${mt}\n`);
      }
      for (const r of ev.risks) {
        process.stdout.write(`    risk: ${r}\n`);
      }
    }
  }

  if (planRevisedEvents.length > 0) {
    process.stdout.write("\n🔄 Plan Revised:\n");
    for (const ev of planRevisedEvents) {
      process.stdout.write(
        `  ${ev.ts}  revision=${ev.revision} reason=${ev.reason}\n`,
      );
    }
  }

  if (halts > 0)
    process.stdout.write(`WARNING: ${halts} loop_halt event(s) present\n`);
  if (warnings > 0)
    process.stdout.write(
      `WARNING: ${warnings} budget_warning event(s) present\n`,
    );

  // --- Exit policy ---
  if (malformedRatio > 0.05) {
    process.stdout.write(
      `FAIL: malformed ratio ${(malformedRatio * 100).toFixed(1)}% exceeds 5% threshold\n`,
    );
    return 1;
  }
  if (halts > 0) {
    process.stdout.write("FAIL: trace contains loop_halt event(s)\n");
    return 1;
  }
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
