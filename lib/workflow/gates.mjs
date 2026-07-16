// @ts-check
// E5-2: Workflow gate constants + guard helpers (no transition-table duplication).
//
// This module re-exports gate-related constants and a thin guard helper so
// callers have one import surface for "is this command safe at this gate?"
// The authoritative transition table lives in `lib/gate-transitions.mjs`
// (E1-2 #12) and is NOT duplicated here.
//
// P06: Also re-exports the unified scope.md enforcement helpers from
// `lib/workflow/scope.mjs` so callers have one public surface for both
// gate-state guards and scope contract enforcement.

import { guardChoreReset, CHORE_PLAN_APPROVED, RESET_COMMANDS } from './lanes/chore.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */

export { CHORE_PLAN_APPROVED, RESET_COMMANDS };
export { parseScope, validateScope, enforceScope, readScopeForTask } from './scope.mjs';

/**
 * Guard helper: returns a block reason if the command would unsafely reset an
 * approved chore, else `null`. Delegates to the chore lane's single source of
 * truth so there is no divergent reset-command list.
 *
 * @param {TaskState} state
 * @param {string} commandName
 * @returns {string|null}  Null = proceed; string = block reason.
 */
export function guardGate(state, commandName) {
  return guardChoreReset(state, commandName);
}
