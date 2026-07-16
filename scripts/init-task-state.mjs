// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { writeTaskState, STATE_PATH } from '../lib/task-state.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { join } from 'node:path';
import { TASK_ID_RE, validateTaskId } from '../lib/memory/paths.mjs';
import { HANDOFF_DIR } from '../lib/handoff/write-handoff.mjs';
import { classifyBudget, persistBudget } from '../lib/context/output-contract.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../lib/types.mjs').Lane} Lane */

/**
 * Parse a named flag value from args array, e.g. --taskId foo -> 'foo'.
 * @param {string[]} args
 * @param {string} flag  e.g. '--taskId'
 * @returns {string|undefined}
 */
function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args.at(idx + 1);
}

/** @type {Lane[]} */
const VALID_LANES = ['feature', 'bug', 'chore'];

/**
 * Contract-only lanes classifyBudget understands beyond the persistable
 * TaskState lanes (see OutputContract.lane in lib/types.mjs).
 * @type {string[]}
 */
const CONTRACT_ONLY_LANES = ['help', 'learn'];

/**
 * Main entrypoint for init-task-state.
 * @param {string[]} args  CLI args (without node/script).
 * @param {string} [statePathOverride]  Override state path (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(args, statePathOverride) {
  const taskId = getFlag(args, '--taskId');
  const laneArg = getFlag(args, '--lane');
  const budgetArg = getFlag(args, '--budget');
  const description = getFlag(args, '--description');
  // TODO: calibrate after E7-2 routing evals — subagents/explicitLarge inference is provisional
  const subagents = args.includes('--subagents');
  const explicitLarge = args.includes('--explicit-large');

  if (!taskId) {
    process.stderr.write('Error: --taskId is required\n');
    return 1;
  }

  // Validate the taskId shape at CREATION, fail-closed. The taskId becomes a
  // ledger filename (.devmate/memory/tasks/<taskId>.jsonl), so an id that is
  // accepted here but fails TASK_ID_RE would be rejected by every downstream
  // memory write and silently disable the whole memory subsystem for the task.
  // Catching it here turns a silent runtime memory-death into a loud, early,
  // actionable error (P3 fail-closed).
  try {
    validateTaskId(taskId);
  } catch (/** @type {unknown} */ err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Error: invalid --taskId ${JSON.stringify(taskId)}. It must match ` +
        `${String(TASK_ID_RE)} — start with a lowercase letter or digit, then ` +
        `only lowercase letters, digits, '.', '_' or '-' (no uppercase, spaces, ` +
        `or slashes) so it is safe as a ledger filename. (${detail})\n`,
    );
    return 2;
  }

  const contractLane = laneArg ?? 'feature';
  if (!VALID_LANES.includes(/** @type {Lane} */ (contractLane)) && !CONTRACT_ONLY_LANES.includes(contractLane)) {
    process.stderr.write(
      `Error: --lane must be one of: ${[...VALID_LANES, ...CONTRACT_ONLY_LANES].join(', ')} (got: ${laneArg})\n`
    );
    return 1;
  }

  // TaskState.lane only persists the gated pipeline lanes; help/learn
  // interactions carry their real lane on the OutputContract instead and
  // persist the lightest-weight pipeline lane.
  const lane = /** @type {Lane} */ (
    VALID_LANES.includes(/** @type {Lane} */ (contractLane)) ? contractLane : 'chore'
  );

  const budget = budgetArg !== undefined ? parseInt(budgetArg, 10) : 10;
  if (!Number.isInteger(budget) || budget < 0) {
    process.stderr.write(`Error: --budget must be a non-negative integer (got: ${budgetArg})\n`);
    return 1;
  }

  // #91: this seeded `plan-approved` — an ALREADY-OPEN implementation gate — on
  // a task no human had ever seen. It was the only thing in the entire repo that
  // could produce that gate value (nothing transitioned INTO plan-approved), so
  // it was load-bearing by accident: the bug and chore lanes could not reach
  // impl-started any other way, and `lib/workflow/bootstrap-task-state.mjs`
  // documents this very script as the hazard it exists to avoid.
  //
  // The gates now advance on evidence (hooks/gate-advance.mjs), so nothing needs
  // a pre-opened gate. This seeds the same PRE-ROUTER gate SessionStart does, and
  // the lane walks itself forward as each artifact lands.
  /** @type {TaskState} */
  const state = {
    taskId,
    lane,
    workflowGate: 'no-lane',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget,
    schemaVersion: 1,
  };

  // Anchor on the resolved workspace root, never the cwd. This CLI runs in the
  // integrated terminal (opens at workspaceFolders[0] — the workspace's own
  // .devmate/ folder in the monoroot layout), and STATE_PATH is cwd-relative:
  // task.json landed at .devmate/.devmate/state/task.json, where the climbed
  // readers (post-tool-use, approval-listener) never look while the cwd-relative
  // readers did — a split-brain where gates advanced on state the memory
  // subsystem could not see (#76). scripts/init.mjs already resolves; this now
  // matches it.
  const statePath = statePathOverride ?? join(resolveHookRoot(), STATE_PATH);

  try {
    await writeTaskState(state, statePath);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  // E9-06: persist the OutputContract so the budget spine has a real
  // token_budget_class instead of the hardcoded 'standard' fallback.
  try {
    const contract = classifyBudget({
      lane: contractLane,
      ...(description !== undefined ? { description } : {}),
      subagents,
      explicitLarge,
    });
    await persistBudget(statePath, contract);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to persist OutputContract: ${msg}\n`);
    return 1;
  }

  // Emit a machine-readable JSON object so the orchestrator can include
  // plan_stored_at and handoff_dir in its output contract.
  process.stdout.write(
    JSON.stringify({ ok: true, plan_stored_at: statePath, handoff_dir: HANDOFF_DIR }) + '\n'
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
