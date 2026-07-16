// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";
import { applyRollback, buildRollbackPlan } from "../lib/workflow/rollback.mjs";

/**
 * `/devmate-rollback` backing entrypoint. The ONLY way to run a rollback — no
 * destructive git command may be pasted into agent prose. Also writes a
 * structured result to .devmate/state/rollback-result.json so the agent can
 * read_file when shell integration is absent (E11-1).
 *
 * Flags:
 *   --state-file <path>   TaskState JSON (defaults to STATE_PATH).
 *   --dry-run             Print the plan; run no git mutations (wins over --confirm).
 *   --confirm             Required for a live, destructive run.
 *
 * Exit: 0 success / dry-run, 1 on failure or missing confirmation.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let stateFile;
  const sIdx = args.indexOf("--state-file");
  const sVal = args.at(sIdx + 1);
  if (sIdx !== -1 && sVal) stateFile = sVal;
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm");

  const stateResult = readTaskState(stateFile);
  if (!stateResult.ok) {
    const errMsg = stateResult.errors.join("; ");
    await writeResult(".devmate/state/rollback-result.json", {
      mode: "error",
      success: false,
      message: errMsg,
      recoveryHints: [],
    });
    process.stdout.write(errMsg + "\n");
    return 1;
  }

  /** @type {import('../lib/types.mjs').RollbackPlan} */
  let plan;
  try {
    plan = await buildRollbackPlan(stateResult.state);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeResult(".devmate/state/rollback-result.json", {
      mode: "error",
      success: false,
      message: msg,
      recoveryHints: [],
    });
    process.stdout.write(msg + "\n");
    return 1;
  }

  // Always show the plan first.
  process.stdout.write(plan.drySummary + "\n");

  // Dry-run wins over --confirm: no mutations.
  if (dryRun) {
    await writeResult(".devmate/state/rollback-result.json", {
      mode: "dry-run",
      success: true,
      planSummary: plan.drySummary,
      message: "Dry run complete — no mutations performed.",
      recoveryHints: [],
    });
    return 0;
  }

  if (!confirmed) {
    const msg =
      "Rollback NOT executed. Re-run with --confirm to perform the destructive rollback.";
    await writeResult(".devmate/state/rollback-result.json", {
      mode: "awaiting-confirm",
      success: false,
      planSummary: plan.drySummary,
      message: msg,
      recoveryHints: [],
    });
    process.stdout.write(msg + "\n");
    return 1;
  }

  const result = await applyRollback(plan, { confirmed: true });
  await writeResult(".devmate/state/rollback-result.json", {
    mode: "live",
    success: result.success,
    planSummary: plan.drySummary,
    message: result.message,
    recoveryHints: result.recoveryHints,
  });
  process.stdout.write(result.message + "\n");
  if (!result.success && result.recoveryHints.length > 0) {
    process.stdout.write(
      "Recovery hints:\n" +
        result.recoveryHints.map((h) => `  - ${h}`).join("\n") +
        "\n",
    );
  }
  return result.success ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
