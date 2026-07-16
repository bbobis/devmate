// @ts-check

/**
 * Delegation advisory for session end.
 *
 * A session sitting at a post-analysis gate (spec/implementation) with zero
 * subagent dispatches almost certainly did its analysis inline — the exact
 * failure the delegation work guards against. This helper detects that from the
 * persisted task state + trace so the Stop hook can surface it. Best-effort and
 * never throws; a missing task or trace simply yields "not applicable".
 */

import { join } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';
import { parseJsonl } from '../json-io.mjs';
import { readTaskState } from '../task-state.mjs';
import { summarizeDelegation } from './delegation-report.mjs';

/**
 * Non-terminal, post-analysis gates where a task with zero subagent dispatches
 * almost certainly did the work inline. Terminal gates (`done`, `parked`,
 * `abandoned`) and pre-analysis gates are excluded so a finished or not-yet-
 * started task is never re-flagged.
 * @type {string[]}
 */
export const INLINE_RISK_GATES = [
  'spec-draft',
  'spec-approved',
  'impl-started',
  'verification-passed',
  'pr-ready',
];

/**
 * @typedef {Object} DelegationAdvisory
 * @property {string} taskId
 * @property {string} workflowGate
 * @property {number} totalDispatches
 * @property {boolean} inlineLikely   True when this session likely worked inline.
 */

/**
 * Best-effort delegation advisory for the current task under `repoRoot`. Reads
 * task.json + the task's trace; returns null when there is no readable task
 * state (no active task). Never throws.
 * @param {string} repoRoot
 * @returns {Promise<DelegationAdvisory|null>}
 */
export async function loadDelegationAdvisory(repoRoot) {
  try {
    const stateResult = readTaskState(join(repoRoot, '.devmate/state/task.json'));
    if (!stateResult.ok) return null;
    const { taskId, lane, workflowGate } = stateResult.state;

    /** @type {unknown[]} */
    let events = [];
    try {
      events = parseJsonl(await readTextFile(join(repoRoot, '.devmate/state/trace', `${taskId}.jsonl`)));
    } catch {
      events = [];
    }

    const summary = summarizeDelegation(events, { lane });
    const inlineLikely =
      summary.totalDispatches === 0 && INLINE_RISK_GATES.includes(workflowGate);
    return {
      taskId,
      workflowGate,
      totalDispatches: summary.totalDispatches,
      inlineLikely,
    };
  } catch {
    return null;
  }
}
