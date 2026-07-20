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
 *     in-flight task must keep its gate, taskId, and progress. So an existing
 *     `task.json` is left untouched — unless it sits at a TERMINAL gate
 *     (`done` / `abandoned`). A terminal task is finished, not live: nothing
 *     can ever transition out of it (the chain walker and `transitionGate`
 *     both refuse), so leaving it in place wedges the workspace forever — no
 *     new task can start after an abandon. A genuinely NEW session over a
 *     terminal task bootstraps a NEW task at `no-lane`; the old task's
 *     artifacts are left in place but ignored (their `taskId` no longer
 *     matches, so every ownership-checking precondition refuses them as
 *     stale evidence). A resumed SAME session keeps its finished task: the
 *     deterministic id it would derive is the terminal task's own, and a
 *     replacement under a reused id would inherit — not refuse — the old
 *     evidence. An UNREADABLE task.json is still left untouched — a state
 *     we cannot classify might be live, and clobbering it would destroy
 *     progress.
 */
import { join } from "node:path";
import { pathExists, renamePathSync } from "../fs-safe.mjs";
import { TASK_ID_RE, TASK_LEDGER_DIR } from "../memory/paths.mjs";
import { isStateCorrupt, isStateFileMissing, readTaskState, STATE_PATH, writeTaskState } from "../task-state.mjs";
import { traceFilePath } from "../trace/append.mjs";
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
 * Gates from which no transition is legal (E10-05). A task.json at one of
 * these is finished — never live — so a fresh session may bootstrap a new
 * task over it. Mirrors the terminal gates of `lib/gate-transitions.mjs`
 * (`done` accepts no event; `abandoned` has an empty steering row).
 * @type {ReadonlySet<string>}
 */
const TERMINAL_GATES = new Set(["done", "abandoned"]);

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

  const taskId = deriveTaskId(opts.sessionId ?? "");

  // A live task keeps its gate and its progress. Only a TERMINAL task
  // (done/abandoned — nothing can transition out of it) is replaced, so a new
  // task can start after an abandon instead of inheriting a wedged terminal
  // state. An unreadable file might be live: never clobber what we cannot
  // classify.
  //
  // The replacement additionally requires a DIFFERENT derived task id.
  // deriveTaskId is deterministic per session, so a same-session resume over
  // a terminal task would mint the terminal task's own id — a "fresh" task
  // that shares the old trace file and every same-taskId state artifact,
  // which the ownership preconditions would then accept as its own evidence.
  // It would also silently reset a legitimately completed task mid-session.
  // Same session ⇒ keep the finished task; only a genuinely new session
  // bootstraps over it.
  if (pathExists(statePath)) {
    const existing = readTaskState(statePath);
    const terminal = existing.ok && TERMINAL_GATES.has(existing.state.workflowGate);
    if (!terminal || taskId === null || taskId === existing.state.taskId) {
      return { created: false, reason: "exists" };
    }
  }

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

/**
 * #191: explicit, human-triggered recovery from a CORRUPT `task.json` — the
 * `reset task` phrase routes here. Unlike {@link bootstrapTaskState} (which never
 * touches an existing file), this MOVES the corrupt state aside to a
 * `task.json.corrupt-<ts>` sidecar (preserved for diagnosis, never deleted) and
 * then bootstraps a fresh task in its place. It fires ONLY on genuine corruption
 * (malformed JSON / shape-invalid, per {@link isStateCorrupt}); a valid, absent,
 * or merely-unreadable (EACCES/EISDIR — might be live) state is refused untouched.
 *
 * Never automatic — this preserves #171's default of SURFACING corrupt state
 * (a hand-edit may be recoverable); the human opts into the reset explicitly.
 * @param {string} repoRoot  Absolute workspace root (already resolved).
 * @param {{ sessionId?: string, now?: () => number }} opts  `now` is an injectable clock (ms) for the quarantine filename — deterministic tests.
 * @returns {Promise<{ quarantined: boolean, reason: 'no_state'|'valid'|'unreadable'|'quarantine_failed'|'recovered', quarantinePath?: string, taskId?: string, created?: boolean, error?: string, gate?: import('../types.mjs').WorkflowGate }>}
 */
export async function recoverCorruptState(repoRoot, opts = {}) {
  const statePath = join(repoRoot, STATE_PATH);
  const now = opts.now ?? Date.now;

  // Classify off readTaskState ALONE — never pathExists/existsSync, which returns
  // false on an access error (EACCES) and would misclassify an unreadable file as
  // "no_state", and whose exists→read gap is a TOCTOU. readTaskState's own error
  // discriminates absent (ENOENT) / unreadable (EACCES/EISDIR) / corrupt in one
  // syscall.
  const existing = readTaskState(statePath);
  if (existing.ok) {
    // A valid state is not a recovery target — refuse, and tell the caller the
    // gate so it can point the human at the right end-a-task move instead.
    return { quarantined: false, reason: "valid", gate: existing.state.workflowGate };
  }
  if (isStateFileMissing(existing)) {
    return { quarantined: false, reason: "no_state" };
  }
  if (!isStateCorrupt(existing)) {
    // Present-but-unreadable (EACCES/EISDIR): might be live, and a rename could
    // fail — never touch it; the human fixes it at the filesystem level.
    return { quarantined: false, reason: "unreadable" };
  }

  // Corrupt: move the original aside (preserved), then bootstrap fresh. One
  // timestamp stamps the task.json sidecar AND the per-task namespace sidecars.
  const stamp = now();
  const quarantinePath = `${statePath}.corrupt-${stamp}`;
  try {
    renamePathSync(statePath, quarantinePath);
  } catch (/** @type {unknown} */ err) {
    return {
      quarantined: false,
      reason: "quarantine_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // The fresh task reuses the SAME session-derived id, so it would otherwise
  // inherit the corrupt task's per-task namespace — its session artifacts
  // (spec.md/plan.json/scope.md, ownership-gated on taskId), append to its
  // trace.jsonl (mixing two tasks' events), and promote its stale memory ledger.
  // Move each aside to a `.corrupt-<stamp>` sidecar (preserved) so the fresh task
  // starts genuinely clean — the exact stale-evidence inheritance bootstrapTaskState's
  // terminal-reuse guard prevents, which this would otherwise route around.
  const reusedId = typeof opts.sessionId === "string" ? deriveTaskId(opts.sessionId) : null;
  if (reusedId !== null) {
    moveAsideIfExists(join(repoRoot, ".devmate", "session", reusedId), stamp);
    moveAsideIfExists(traceFilePath(reusedId, repoRoot), stamp);
    moveAsideIfExists(join(repoRoot, TASK_LEDGER_DIR, `${reusedId}.jsonl`), stamp);
  }

  // task.json is now absent, so bootstrapTaskState creates a fresh no-lane task
  // (when a sessionId is available; otherwise the next SessionStart will). Wrap
  // it: a bootstrap failure AFTER the rename must not escape as a raw hook crash —
  // the original is already preserved, so report a deferred-fresh recovery.
  /** @type {{ created: boolean, taskId?: string }} */
  let boot;
  try {
    boot = await bootstrapTaskState(repoRoot, {
      ...(typeof opts.sessionId === "string" ? { sessionId: opts.sessionId } : {}),
    });
  } catch (/** @type {unknown} */ err) {
    return {
      quarantined: true,
      reason: "recovered",
      quarantinePath,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    quarantined: true,
    reason: "recovered",
    quarantinePath,
    created: boot.created,
    ...(boot.taskId !== undefined ? { taskId: boot.taskId } : {}),
  };
}

/**
 * #191 (review): move a per-task artifact path aside to a `.corrupt-<stamp>`
 * sidecar if it exists — best-effort, so a missing path or a rename failure is a
 * silent skip (the recovery must not fail on housekeeping).
 * @param {string} target
 * @param {number} stamp
 * @returns {void}
 */
function moveAsideIfExists(target, stamp) {
  if (!pathExists(target)) return;
  try {
    renamePathSync(target, `${target}.corrupt-${stamp}`);
  } catch {
    // best-effort — the fresh bootstrap still proceeds
  }
}
