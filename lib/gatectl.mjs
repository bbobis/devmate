// @ts-check
import path from 'node:path';
import { flattenTransitions } from './gate-transitions.mjs';
import { getOwn } from './object-utils.mjs';
import { checkGatePrecondition } from './gate-preconditions.mjs';
import { readTaskState, writeTaskState, STATE_PATH } from './task-state.mjs';
import { appendTraceEvent } from './trace/append.mjs';

/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('./types.mjs').TaskState} TaskState */
/** @typedef {import('./types.mjs').TraceGateTransitionEvent} TraceGateTransitionEvent */

/** Trace schema version stamped on gate_transition events written here. */
const SCHEMA_VERSION = 1;

/** Step id stamped on trace events written by the gatectl advance path. */
const STEP_ID = 'gatectl';

/**
 * Legal gate transitions for the linear (non-lane) workflow pipeline.
 * Advancing to a gate not listed as a successor throws GateTransitionError.
 *
 * Derived from the canonical table in `gate-transitions.mjs` (the linear
 * spine unioned with every lane/event pair), so this projection and
 * `transitionGate` can never disagree. Do not hand-edit pairs here — edit
 * the canonical table.
 *
 * @type {Readonly<Record<WorkflowGate, readonly WorkflowGate[]>>}
 */
export const LEGAL_TRANSITIONS = Object.freeze(/** @type {Record<WorkflowGate, readonly WorkflowGate[]>} */ (
  Object.fromEntries(
    Object.entries(flattenTransitions()).map(([gate, successors]) => [gate, Object.freeze(successors)])
  )
));

/**
 * Error thrown when an illegal gate transition is attempted.
 */
export class GateTransitionError extends Error {
  /**
   * @param {WorkflowGate} from  Current gate.
   * @param {WorkflowGate} to    Attempted next gate.
   * @param {readonly WorkflowGate[]} legal  Legal successors.
   */
  constructor(from, to, legal) {
    const legalStr = legal.length ? legal.join(', ') : '(none — terminal gate)';
    super(`Illegal gate transition: "${from}" -> "${to}". Legal next gates: ${legalStr}.`);
    this.name = 'GateTransitionError';
    this.from = from;
    this.to = to;
    this.legal = legal;
  }
}

/**
 * Advance a workflow gate. Returns the next gate string on success.
 * Throws {@link GateTransitionError} if the transition is not in LEGAL_TRANSITIONS.
 *
 * @param {WorkflowGate} current  Current gate.
 * @param {WorkflowGate} next     Desired next gate.
 * @returns {WorkflowGate}
 */
export function advanceGate(current, next) {
  const successors = getOwn(LEGAL_TRANSITIONS, current);
  if (!successors) {
    throw new GateTransitionError(current, next, []);
  }
  if (!successors.includes(next)) {
    throw new GateTransitionError(current, next, successors);
  }
  return next;
}

/**
 * Check whether a gate transition is legal without throwing.
 *
 * @param {WorkflowGate} current
 * @param {WorkflowGate} next
 * @returns {boolean}
 */
export function isLegalTransition(current, next) {
  const successors = getOwn(LEGAL_TRANSITIONS, current);
  if (!successors) return false;
  return successors.includes(next);
}

/**
 * E10-03: the two workflow gates that require explicit human approval.
 * Advancing INTO one of these gates requires an `actor` + `evidence` audit
 * pair; every other (internal/auto) gate advance is unchanged.
 * @type {readonly WorkflowGate[]}
 */
export const HUMAN_APPROVAL_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (['spec-approved', 'pr-ready'])
);

/**
 * True when advancing into `gate` requires human approval (and therefore an
 * actor/evidence audit pair).
 * @param {string} gate
 * @returns {boolean}
 */
export function isHumanApprovalGate(gate) {
  return HUMAN_APPROVAL_GATES.includes(/** @type {WorkflowGate} */ (gate));
}

/**
 * Error thrown when a human-gate advance is attempted without the required
 * actor/evidence audit pair.
 */
export class HumanGateAuditError extends Error {
  /**
   * @param {WorkflowGate} target  The human gate the advance targeted.
   */
  constructor(target) {
    super(
      `Human-gate transition to "${target}" requires an audit trail — pass both ` +
      'a non-empty actor (who issued the transition) and non-empty evidence ' +
      '(the verbatim human message that approved it).'
    );
    this.name = 'HumanGateAuditError';
    this.target = target;
  }
}

/**
 * Append the `gate_transition` trace event for a human-gate advance, carrying
 * the actor/evidence audit pair. Shared by `advanceHumanGate` and the
 * `gatectl workflow set` CLI path so both write the same audit shape.
 * @param {{ taskId: string, from: WorkflowGate, to: WorkflowGate, actor: string, evidence: string, root: string }} entry
 *        root is REQUIRED — the cwd default it used to carry is how gate audits
 *        landed in .devmate/.devmate when the terminal opened in the workspace's
 *        .devmate folder (#76).
 * @returns {Promise<void>}
 * @throws when the event fails trace-schema validation.
 */
export async function appendGateTransitionEvent(entry) {
  const { taskId, from, to, actor, evidence, root } = entry;
  /** @type {TraceGateTransitionEvent} */
  const event = {
    type: 'gate_transition',
    taskId,
    stepId: STEP_ID,
    ts: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    from,
    to,
    gate: to,
    actor,
    evidence,
  };
  const result = await appendTraceEvent(event, { root });
  if (!result.ok) {
    throw new Error(
      `gate_transition trace append failed: ${(result.errors ?? []).join('; ')}`
    );
  }
}

/** Advance a human gate with an audit trail.
 * Validates edge legality via {@link advanceGate}, enforces the target gate's
 * artifact precondition via `checkGatePrecondition`, persists the new gate to
 * task.json, and appends a `gate_transition` trace event carrying the audit
 * pair. Internal/auto gate advances do not go through this function.
 * @param {import('./types.mjs').WorkflowGate} current
 * @param {import('./types.mjs').WorkflowGate} target
 * @param {{ actor: string, evidence: string, root: string }} audit
 *        actor + evidence are REQUIRED for spec-approved and pr-ready.
 * @returns {Promise<{ from: WorkflowGate, to: WorkflowGate, state: TaskState }>}
 * @throws if a human-gate advance is missing actor/evidence, or the edge is illegal.
 */
export async function advanceHumanGate(current, target, audit) {
  const { actor, evidence, root } = audit ?? {};
  if (isHumanApprovalGate(target)) {
    const hasActor = typeof actor === 'string' && actor.trim() !== '';
    const hasEvidence = typeof evidence === 'string' && evidence.trim() !== '';
    if (!hasActor || !hasEvidence) {
      throw new HumanGateAuditError(target);
    }
  }

  // A parked task accepts exactly two moves: resume (back to its recorded
  // gate, precondition re-checked) and abandon. The flattened table that
  // advanceGate consults lists every parkable gate as a successor of parked —
  // that fan-out exists so `resume`'s DYNAMIC target is representable, and it
  // must never double as an approval edge: `approve pr` at parked would jump
  // straight to pr-ready, bypassing resume and the recorded gate's own
  // precondition (#20, surfaced by the transition matrix).
  if (current === 'parked') {
    throw new Error(
      `Human-gate transition refused: the task is parked. Resume it first ` +
        `(gatectl workflow set resume), then approve from the resumed gate.`,
    );
  }

  // Edge legality — throws GateTransitionError on an illegal edge.
  advanceGate(current, target);

  const statePath = path.join(root, STATE_PATH);
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    throw new Error(
      `advanceHumanGate: cannot read task state: ${stateResult.errors.join('; ')}`
    );
  }
  const state = stateResult.state;
  if (state.workflowGate !== current) {
    throw new Error(
      `advanceHumanGate: stale gate — task.json is at "${state.workflowGate}" ` +
      `but the caller believes "${current}". Re-read the state before advancing.`
    );
  }

  // Artifact precondition for the target gate (E9-15) — unproven transitions
  // are refused with the unmet requirements listed.
  const precondition = await checkGatePrecondition(target, {
    stateDir: path.join(root, '.devmate/state'),
    lane: state.lane,
  });
  if (!precondition.ok) {
    throw new Error(
      `Gate precondition failed for "${target}": ${precondition.missing.join('; ')}`
    );
  }

  const nextState = { ...state, workflowGate: target, currentStep: 0 };
  await writeTaskState(nextState, statePath);
  await appendGateTransitionEvent({
    taskId: state.taskId,
    from: current,
    to: target,
    actor,
    evidence,
    root,
  });
  return { from: current, to: target, state: nextState };
}
