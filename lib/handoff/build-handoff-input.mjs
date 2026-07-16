// @ts-check
import { readTrace } from '../trace/read-trace.mjs';

/** @typedef {import('../types.mjs').HandoffInput} HandoffInput */
/** @typedef {import('../types.mjs').HandoffEvidencePointer} HandoffEvidencePointer */

/**
 * Map a trigger reason to the handoff's `currentState`. Any reason other than
 * `halt` / `compaction` (e.g. `manual`, `session_end`) is an in-progress task.
 * @param {string} reason
 * @returns {string}
 */
export function reasonToState(reason) {
  if (reason === 'halt') return 'halted';
  if (reason === 'compaction') return 'compacted';
  return 'in_progress';
}

/**
 * Build a `HandoffInput` from a task's current trace summary — pointer-only,
 * never raw content (TCM-3). Shared by `scripts/create-handoff.mjs` (the
 * manual/agent path) and the Stop hook's automatic session-end handoff, so both
 * produce identical briefs.
 * @param {string} taskId
 * @param {{ reason?: string, traceDir?: string, purpose?: string }} [opts]
 * @returns {Promise<HandoffInput>}
 */
export async function buildHandoffInput(taskId, opts = {}) {
  const reason = opts.reason ?? 'manual';
  const { summary } = await readTrace(taskId, { traceDir: opts.traceDir });

  /** @type {HandoffEvidencePointer[]} */
  const evidencePointers = [
    {
      kind: 'trace',
      path_or_url: `.devmate/state/trace/${taskId}.jsonl`,
      why_relevant: 'Full event trace for this task.',
      confidence: 'high',
    },
  ];

  /** @type {string[]} */
  const blockers = [];
  if (summary.currentBlocked) {
    blockers.push(
      `Blocked at stepId ${summary.currentBlocked.stepId} (label: ${summary.currentBlocked.label}).`,
    );
  }
  if (summary.malformedCount > 0) {
    blockers.push(
      `Trace has ${summary.malformedCount} malformed line(s): ${summary.malformedLines.join(', ')}.`,
    );
  }

  /** @type {string[]} */
  const openQuestions = [];
  if (summary.nextLegalAction) {
    openQuestions.push(`Next legal action: ${summary.nextLegalAction}`);
  }

  return {
    taskId,
    purpose: opts.purpose ?? `Resume task ${taskId} after ${reason}.`,
    currentState: reasonToState(reason),
    decisions: [],
    openQuestions,
    evidencePointers,
    suggestedNextSkill: null,
    blockers,
  };
}
