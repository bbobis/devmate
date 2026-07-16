// @ts-check

/**
 * E10-02: model-visible workflow-state anchor.
 *
 * Builds the compact `<devmate-state>` context block that the UserPromptSubmit
 * hook (hooks/approval-listener.mjs) and the SessionStart hook
 * (scripts/session-start.mjs) print to stdout on every turn, so the
 * orchestrator is re-anchored to the durable gate/lane/step persisted in
 * `.devmate/state/task.json` instead of relying on a lane script that has
 * scrolled out of context. Grounded in docs/research/orchestrator-redesign.md
 * (R2): stdout from those two hook events is added to context the model can
 * see and act on, so the block steers interpretation without rewriting the
 * user's message.
 *
 * Pure module: no I/O, no clock, no process state. Legal next gates come from
 * the unified transition table in lib/gate-transitions.mjs — never a
 * duplicated list.
 */

import { flattenTransitions } from '../gate-transitions.mjs';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */

/** Opening tag of the anchor block. */
export const ANCHOR_OPEN_TAG = '<devmate-state>';

/** Closing tag of the anchor block. */
export const ANCHOR_CLOSE_TAG = '</devmate-state>';

// TODO: calibrate anchor throttle after usage telemetry — provisional
/**
 * Turn cadence for re-emitting the full anchor block between human gates:
 * once a turn counter is wired, the full block is emitted at human-decision
 * gates and every N turns, with the compact one-liner otherwise.
 * @type {number}
 */
export const FULL_ANCHOR_TURN_CADENCE = 5;

/**
 * Gates at which a human decision is pending. The full anchor block is always
 * emitted at these gates regardless of the turn cadence, because that is where
 * off-script input is most likely to derail the workflow.
 * @type {readonly WorkflowGate[]}
 */
export const HUMAN_DECISION_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (['spec-draft', 'pr-ready']),
);

/**
 * Standing reminder rendered as the last field of the full block. Complements
 * the E10-01 gate conversation protocol: the anchor tells the model to apply
 * it to the raw user message instead of expecting magic phrases.
 * @type {string}
 */
const REMINDER =
  'reminder: interpret this user message against the workflow state above before acting. ' +
  'Approval must be explicit; treat free-form change requests as revision feedback, ' +
  'and answer questions without advancing the gate.';

/**
 * Resolve the legal next gates for the anchor: an explicit override wins,
 * otherwise the flattened canonical transition table is projected for the
 * state's current gate.
 * @param {TaskState} state
 * @param {{ pendingArtifact?: string, legalNext?: string[] }} opts
 * @returns {string[]}
 */
function resolveLegalNext(state, opts) {
  if (Array.isArray(opts.legalNext)) return opts.legalNext;
  const table = flattenTransitions();
  return getOwn(table, state.workflowGate) ?? [];
}

/**
 * Render the legal-next field line.
 * @param {string[]} legalNext
 * @returns {string}
 */
function renderLegalNext(legalNext) {
  return legalNext.length > 0
    ? `legal next gates: ${legalNext.join(', ')}`
    : 'legal next gates: (none — terminal gate)';
}

/** @typedef {import('../types.mjs').ImplProgress} ImplProgress */

/**
 * Render the implementation-progress field line from an ImplProgress summary.
 * @param {ImplProgress} progress
 * @returns {string}
 */
function renderImplProgress(progress) {
  const head = `implementation: ${progress.done}/${progress.total} ACs complete`;
  return progress.nextId !== null
    ? `${head} (next AC${progress.nextId}: ${progress.nextLabel})`
    : `${head} (all ACs complete)`;
}

/** @typedef {import('../task-staleness.mjs').Staleness} Staleness */

/**
 * Render the staleness field line. Surfaces the fact + the auto-park steer so
 * an unrelated new task is not blocked on an interrogation about a
 * likely-abandoned workflow.
 * @param {Staleness} staleness
 * @returns {string}
 */
function renderStaleness(staleness) {
  return (
    `staleness: STALE — this workflow has been idle ~${Math.round(staleness.idleHours)}h and is likely abandoned. ` +
    'On a new, unrelated request, auto-park it (record a resume-pointer) and start the new task; ' +
    'do not interrogate park/abandon/continue.'
  );
}

/** Build the model-visible workflow-state anchor block.
 * @param {import('../types.mjs').TaskState} state  Current task state.
 * @param {{ pendingArtifact?: string, legalNext?: string[], implProgress?: ImplProgress, staleness?: Staleness }} [opts]
 * @returns {string}  A `<devmate-state>…</devmate-state>` block, one field per line.
 */
export function buildStateAnchor(state, opts = {}) {
  const lines = [
    ANCHOR_OPEN_TAG,
    `taskId: ${state.taskId}`,
    `lane: ${state.lane}`,
    `gate: ${state.workflowGate}`,
    `step: ${state.currentStep}`,
  ];
  // Surface per-AC implementation progress so a resumed/compacted session
  // re-anchors to which acceptance criteria remain, not just the coarse gate.
  if (opts.implProgress && opts.implProgress.total > 0) {
    lines.push(renderImplProgress(opts.implProgress));
  }
  // Surface staleness so a days-old in-flight task auto-parks for a new task
  // instead of forcing a park/abandon interrogation.
  if (opts.staleness && opts.staleness.stale) {
    lines.push(renderStaleness(opts.staleness));
  }
  if (typeof opts.pendingArtifact === 'string' && opts.pendingArtifact.trim() !== '') {
    lines.push(`pending: ${opts.pendingArtifact.trim()}`);
  }
  lines.push(renderLegalNext(resolveLegalNext(state, opts)));
  lines.push(REMINDER);
  lines.push(ANCHOR_CLOSE_TAG);
  return lines.join('\n');
}

/**
 * Compact one-line variant of the anchor, used between full blocks once the
 * provisional turn cadence is wired to a real turn counter (see
 * {@link FULL_ANCHOR_TURN_CADENCE}). Carries the same identifying fields but
 * drops pending/legal-next/reminder detail.
 * @param {TaskState} state
 * @returns {string}
 */
export function buildStateAnchorLine(state) {
  return `devmate-state: taskId ${state.taskId} | lane ${state.lane} | gate ${state.workflowGate} | step ${state.currentStep}`;
}

/**
 * Throttle policy for anchor verbosity: emit the full block at human-decision
 * gates and every {@link FULL_ANCHOR_TURN_CADENCE} turns, the one-liner
 * otherwise. Pure decision helper — callers supply the turn distance since the
 * last full block (no turn counter is persisted yet; until one exists, callers
 * emit the full block on every turn).
 * @param {TaskState} state  Current task state.
 * @param {number} turnsSinceFullAnchor  Turns elapsed since the last full block.
 * @returns {boolean}  True when the full block should be emitted this turn.
 */
export function shouldEmitFullAnchor(state, turnsSinceFullAnchor) {
  if (HUMAN_DECISION_GATES.includes(state.workflowGate)) return true;
  return turnsSinceFullAnchor >= FULL_ANCHOR_TURN_CADENCE;
}
