// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";
import { escalateChoreToFeature } from "../lib/workflow/lanes/chore.mjs";

/**
 * `escalate-chore` entrypoint. Reads the current task state, escalates an
 * approved chore to the feature lane (re-entering at the real `plan-approved`
 * gate), and prints a compact result JSON. Also writes result to
 * .devmate/state/escalate-chore-result.json so the agent can read_file when
 * shell integration is absent (E11-1).
 *
 * Anti-hallucination note: the spec's escalation target gate `tech-design` is
 * NOT a real WorkflowGate. The feature lane re-enters at `plan-approved`.
 *
 * Flags:
 *   --reason <text>    Why the chore is being escalated (required).
 *
 * Exit: 0 on success, 1 on any failure (bad state, not a chore, missing reason).
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let reason;
  const rIdx = args.indexOf("--reason");
  const rVal = args.at(rIdx + 1);
  if (rIdx !== -1 && rVal) reason = rVal;

  if (!reason) {
    const errResult = {
      ok: false,
      reason: "Missing required flag: --reason <text>",
    };
    await writeResult(".devmate/state/escalate-chore-result.json", errResult);
    process.stdout.write(JSON.stringify(errResult) + "\n");
    return 1;
  }

  const stateResult = readTaskState();
  if (!stateResult.ok) {
    const errResult = { ok: false, reason: stateResult.errors.join("; ") };
    await writeResult(".devmate/state/escalate-chore-result.json", errResult);
    process.stdout.write(JSON.stringify(errResult) + "\n");
    return 1;
  }

  try {
    const next = await escalateChoreToFeature(stateResult.state, { reason });
    const out = {
      ok: true,
      lane: next.lane,
      workflowGate: next.workflowGate,
      taskId: next.taskId,
    };
    await writeResult(".devmate/state/escalate-chore-result.json", out);
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errResult = { ok: false, reason: msg };
    await writeResult(".devmate/state/escalate-chore-result.json", errResult);
    process.stdout.write(JSON.stringify(errResult) + "\n");
    return 1;
  }
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
