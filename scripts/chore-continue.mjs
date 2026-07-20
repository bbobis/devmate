// @ts-check
// Manual/recovery CLI (E5-2; reframed by #130). NOT agent-invoked at runtime:
// the orchestrator (which owns the workflow) declares no execute tool, and no
// hook, skill, or agent instruction wires this script. The chore lane's
// plan-approved -> impl-started move happens in hooks/approval-listener.mjs on
// the human phrase "approve plan" (the generic, lane-blind start-impl path);
// this script remains for a human running it by hand in a terminal — e.g. to
// recover a session whose approval hook cannot fire.
//
// Continues an approved chore into the executing phase WITHOUT resetting state.
// Loads TaskState, runs the reset guard against a `__self__` sentinel (to catch
// invocation from a reset context), asserts the gate is `plan-approved`, then
// advances via `continueApprovedChore`. Prints a compact `{ gate, taskId }`
// JSON line. Also writes result to .devmate/state/chore-continue-result.json
// so the agent can read_file when shell integration is absent (E11-1).
// Exits 0 on success; 1 on guard block or invalid state.
//
// Output is a single JSON line — full state/ledger contents are never printed.
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";
import {
  CHORE_PLAN_APPROVED,
  continueApprovedChore,
  guardChoreReset,
} from "../lib/workflow/lanes/chore.mjs";

/** Sentinel token used to detect invocation from a reset context. */
const SELF_SENTINEL = "__self__";

/**
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  // Optional --state-path override (tests / non-default layouts).
  let statePath;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args.at(i + 1);
    if (a === "--state-path" && next) {
      statePath = next;
      i++;
    } else if (a.startsWith("--state-path=")) {
      statePath = a.slice("--state-path=".length);
    }
  }

  const read = readTaskState(statePath);
  if (!read.ok) {
    process.stderr.write(
      `error: cannot read TaskState: ${read.errors.join("; ")}\n`,
    );
    return 1;
  }
  const state = read.state;

  // Defensive: refuse to continue if a reset is implied by the dispatch context.
  const block = guardChoreReset(state, SELF_SENTINEL);
  if (block) {
    process.stderr.write(`error: ${block}\n`);
    return 1;
  }

  if (state.lane !== "chore") {
    process.stderr.write(
      `error: /devmate-chore-continue requires lane 'chore', got '${state.lane}'.\n`,
    );
    return 1;
  }
  if (state.workflowGate !== CHORE_PLAN_APPROVED) {
    process.stderr.write(
      `error: gate must be '${CHORE_PLAN_APPROVED}', got '${state.workflowGate}'.\n`,
    );
    return 1;
  }

  let next;
  try {
    next = await continueApprovedChore(state, { statePath });
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  const out = { gate: next.workflowGate, taskId: next.taskId };
  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/chore-continue-result.json", out);
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
