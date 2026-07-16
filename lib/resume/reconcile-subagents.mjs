// @ts-check

/**
 * DN-6: Reconcile a stale `activeSubagents` counter at SessionStart.
 *
 * `hooks/subagent-budget-guard.mjs` increments `activeSubagents` in
 * task.json on `SubagentStart` and decrements it on `SubagentStop` to
 * enforce `maxConcurrentAgents` (devmate.config.json). If a sub-agent is
 * hard-interrupted — host crash, session killed mid-dispatch, hook process
 * OOM — `SubagentStop` never fires and the counter stays incremented
 * forever, eventually denying all future dispatch on that task once it
 * reaches the concurrency ceiling.
 *
 * A fresh session is the safe reconciliation point: sub-agents never
 * outlive their host session, so any sub-agent from a previous session is
 * by definition no longer running, and any nonzero `activeSubagents` seen
 * at SessionStart is stale.
 *
 * This module is the pure decision half. The apply (persist under the
 * task-state lock + trace event) is injected IO owned by the caller
 * (`scripts/session-start.mjs`), so this function stays trivially testable.
 */

/** @typedef {import('../types.mjs').TaskState} TaskState */

/**
 * Decide whether the activeSubagents counter — or the `activeAgents` roster that
 * shares its lifecycle (#93) — is stale at session start. Pure: a fresh session
 * implies no prior sub-agent survives, so a nonzero count or a non-empty roster
 * is stale.
 *
 * The roster matters more than the count. It is the identity the gate-guard
 * gates session-artifact writes on, so a leaked entry would hand a dead agent's
 * name to whatever runs next — and if that name is `spec-writer`, the right to
 * rewrite the approved spec. Both are cleared together, under the same lock.
 *
 * @param {Object} input
 * @param {TaskState|null} input.taskState  Parsed task.json or null.
 * @returns {{ needed: boolean, previous: number, previousAgents: number }}
 */
export function reconcileActiveSubagents({ taskState }) {
  const previous =
    taskState !== null && typeof taskState.activeSubagents === 'number'
      ? taskState.activeSubagents
      : 0;
  const previousAgents = Array.isArray(taskState?.activeAgents)
    ? taskState.activeAgents.length
    : 0;
  return { needed: previous > 0 || previousAgents > 0, previous, previousAgents };
}
