// @ts-check
/**
 * Bootstrap the per-task state file at session start.
 *
 * Why this exists: `task.json` is the keystone of the whole runtime. The trace
 * writer keys every event on `state.taskId`; the Stop hook's handoff capture
 * returns `skipped: 'no_task'` without it; the PostToolUse memory collector
 * returns `memory.skip / pre_task`; and the budget guard reports
 * `[BUDGET:unclassified]`. So when `task.json` is missing, four subsystems go
 * quiet at once and the session looks like it simply did nothing.
 *
 * It was missing because the ONLY thing that created it was
 * `scripts/init-task-state.mjs`, invoked by a line in the orchestrator prompt —
 * and the orchestrator declares no `execute` tool, so it could never run it.
 * `docs/PATTERNS.md` already tagged that enforcement `prompt-only`; in practice
 * it was zero-enforcement. This module moves the bootstrap into the SessionStart
 * hook, where the host runs it deterministically with no model in the loop.
 *
 * Two invariants this must not break:
 *
 *  1. **It must not open a gate.** `init-task-state` writes
 *     `workflowGate: 'plan-approved'` because it is meant to run AFTER a human
 *     approves the plan. Bootstrapping that value on every session would hand
 *     `@fullstack` an open implementation gate and bypass HITL entirely. This
 *     writes `no-lane` — the pre-router gate, from which the only legal move is
 *     `lane-set`.
 *  2. **It must never clobber a live task.** A session that resumes an
 *     in-flight task must keep its gate, taskId, and progress. So this is
 *     strictly create-if-absent; an existing `task.json` is left untouched.
 */
import { join } from "node:path";
import { pathExists } from "../fs-safe.mjs";
import { TASK_ID_RE } from "../memory/paths.mjs";
import { STATE_PATH, writeTaskState } from "../task-state.mjs";
import { classifyBudget, persistBudget } from "../context/output-contract.mjs";

/** @typedef {import('../types.mjs').TaskState} TaskState */

/**
 * The gate a freshly bootstrapped task starts at: no lane chosen yet. `@router`
 * is what moves it to `lane-set`.
 * @type {import('../types.mjs').WorkflowGate}
 */
const INITIAL_GATE = "no-lane";

/**
 * Lane placeholder before `@router` has classified the request. `TaskState.lane`
 * is a required field with no "none" member, and the gate — not this value — is
 * what the dispatch guard actually enforces: at `no-lane`, an implementation
 * dispatch is denied whatever the lane says. The router overwrites it.
 * @type {import('../types.mjs').Lane}
 */
const PLACEHOLDER_LANE = "feature";

/** Default step budget, matching `init-task-state`. */
const DEFAULT_BUDGET = 10;

/**
 * Derive a filesystem-safe taskId from the host's session id.
 *
 * The session id is the only unique, host-supplied identifier available at
 * SessionStart, and using it keeps the bootstrap DETERMINISTIC — no `Date.now()`,
 * no `Math.random()`, so the same session always yields the same taskId and a
 * resumed session re-derives the id it already has.
 *
 * The result must satisfy TASK_ID_RE, because the taskId becomes a ledger
 * filename (`.devmate/memory/tasks/<taskId>.jsonl`); an id that fails the regex
 * is rejected by every downstream memory write and silently kills the subsystem.
 * So: lowercase, illegal characters collapsed to `-`, and prefixed with `s-` to
 * guarantee the leading `[a-z0-9]` even if the host ever sends an id starting
 * with punctuation.
 *
 * @param {string} sessionId  The host's `session_id`.
 * @returns {string|null}  A valid taskId, or null if nothing usable remains.
 */
export function deriveTaskId(sessionId) {
  if (typeof sessionId !== "string") return null;
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = slug.replace(/^-+/, "").replace(/-+$/, "");
  if (trimmed === "") return null;
  const taskId = `s-${trimmed}`;
  return TASK_ID_RE.test(taskId) ? taskId : null;
}

/**
 * Create `.devmate/state/task.json` if it does not exist.
 *
 * @param {string} repoRoot  Absolute workspace root (already resolved).
 * @param {{ sessionId?: string }} opts
 * @returns {Promise<{ created: boolean, taskId?: string, reason?: string }>}
 */
export async function bootstrapTaskState(repoRoot, opts = {}) {
  const statePath = join(repoRoot, STATE_PATH);

  // Create-if-absent. A live task keeps its gate and its progress.
  if (pathExists(statePath)) {
    return { created: false, reason: "exists" };
  }

  const taskId = deriveTaskId(opts.sessionId ?? "");
  if (taskId === null) {
    // No session id means no honest task identity. Writing a sentinel like
    // "unknown" is exactly what #76 did: it minted `unknown.jsonl`, a file no
    // reader ever consults. Better to leave the state absent and say why.
    return { created: false, reason: "no_session_id" };
  }

  /** @type {TaskState} */
  const state = {
    taskId,
    lane: PLACEHOLDER_LANE,
    workflowGate: INITIAL_GATE,
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: DEFAULT_BUDGET,
    schemaVersion: 1,
  };

  await writeTaskState(state, statePath);

  // Persist an OutputContract so the budget guard has a real token_budget_class
  // to measure against instead of reporting [BUDGET:unclassified] forever. The
  // request text is not available at SessionStart, so this is the lane default;
  // the orchestrator refines it once `@router` has classified the request.
  await persistBudget(statePath, classifyBudget({ lane: PLACEHOLDER_LANE }));

  return { created: true, taskId };
}
