// @ts-check
// A pure decision module — no disk I/O; every fact is injected. It is the
// analysis-agent counterpart to lib/workflow/dispatch-gate.mjs: that module
// hard-gates the IMPLEMENTATION dispatch on `workflowGate === 'impl-started'`;
// this one flags an ANALYSIS dispatch (rubber-duck / planner / spec-writer) that
// arrives before the internal gate its work depends on has been reached.
//
// Why this is a distinct, softer guard (RC-3):
//   The implementation dispatch is structurally impossible out of order — it
//   needs impl-started, which is unreachable until every upstream gate advanced.
//   An analysis dispatch has no such backstop: dispatching @spec-writer while the
//   gate is still grill-done runs the agent, writes spec.md, and then the gate
//   CANNOT advance (plan-done's critique-result.json is absent), so the work is
//   wasted with no actionable signal. The caller turns an out-of-order verdict
//   into a model-visible advisory (`warn`, default) or a deny (`block`).
//
// The comparison is `currentGate >= agent's minimum gate` along the lane's
// forward spine, NOT step monotonicity. Keying on the gate — not on relative
// dispatch order — is what makes every legitimate case pass without an explicit
// allowlist: same-gate parallel fan-out (discovery+tech-design, planner+ui-ux,
// fullstack×N), same-agent re-dispatch during a human-gate revision loop, and
// the deliberate BACKWARD steering edges (re-plan, revise-scope, new-requirements)
// all leave the gate at-or-after the agent's minimum, so all are allowed. Only a
// dispatch that genuinely precedes its prerequisite gate is flagged.

import { normalizeDispatchedAgent, normalizeLane } from './orchestrator.mjs';
import { isImplementationDispatch } from './dispatch-gate.mjs';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').Lane} Lane */
/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */

/**
 * The ordered forward gate spine per lane — the monotone progression a lane
 * walks under `lib/gate-transitions.mjs` `TRANSITIONS`, flattened for index
 * comparison. Steering edges (park/abandon/re-plan/revise-scope/new-requirements)
 * are deliberately NOT here: they move the gate, and the guard compares against
 * wherever the gate landed. A drift test (test/lib/workflow/dispatch-sequencing.test.mjs)
 * pins this list to `TRANSITIONS`: every forward edge whose endpoints both appear
 * in the spine must move strictly forward in it (human-gate edges outside
 * `TRANSITIONS`, e.g. spec-draft → spec-approved, are not pinned).
 * @type {Readonly<Record<Lane, readonly WorkflowGate[]>>}
 */
export const LANE_GATE_ORDER = Object.freeze({
  feature: Object.freeze(
    /** @type {readonly WorkflowGate[]} */ ([
      'no-lane',
      'lane-set',
      'discovery-done',
      'grill-done',
      'plan-done',
      'spec-draft',
      'spec-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
      'done',
    ]),
  ),
  bug: Object.freeze(
    /** @type {readonly WorkflowGate[]} */ ([
      'no-lane',
      'lane-set',
      'grill-done',
      'plan-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
      'done',
    ]),
  ),
  chore: Object.freeze(
    /** @type {readonly WorkflowGate[]} */ ([
      'no-lane',
      'lane-set',
      'plan-approved',
      'impl-started',
      'verification-passed',
      'done',
    ]),
  ),
});

/**
 * Per-lane `analysis agent -> minimum workflowGate` it may legitimately be
 * dispatched at. Only agents with an UNAMBIGUOUS gate minimum appear here.
 *
 * Keyed by the normalized agent name (persona wrappers already collapse to
 * `fullstack`, which is excluded — implementation dispatch is gated separately).
 * `rubber-duck` maps to the grill's prerequisite (discovery-done) and needs no
 * `mode` discrimination: its later `mode=critique` dispatch happens at grill-done,
 * which is already past discovery-done, so both modes pass the same test — and the
 * dispatch payload does not reliably carry `mode` at PreToolUse anyway.
 *
 * The bug and chore lanes have no entry: their analysis dispatches (`@diagnose`,
 * the bug grill, the chore scoping `@planner`) sit at `lane-set` with no
 * intermediate workflowGate to key on — their ordering is enforced instead by the
 * diagnosis milestone and the scope precondition. Left extensible for a future
 * gate-expressible case.
 * @type {Readonly<Record<Lane, Readonly<Record<string, WorkflowGate>>>>}
 */
export const ANALYSIS_MIN_GATE = Object.freeze({
  feature: Object.freeze({
    'rubber-duck': /** @type {WorkflowGate} */ ('discovery-done'),
    planner: /** @type {WorkflowGate} */ ('grill-done'),
    'spec-writer': /** @type {WorkflowGate} */ ('plan-done'),
  }),
  bug: Object.freeze({}),
  chore: Object.freeze({}),
});

/**
 * A one-line "how to unblock" hint per minimum gate — the missing upstream
 * dispatch/artifact, so the advisory is actionable rather than just naming a gate.
 * @type {Readonly<Record<string, string>>}
 */
const GATE_UNBLOCK_HINT = Object.freeze({
  'discovery-done': 'run discovery first (@discovery / @tech-design) so discovery-merged.json lands',
  'grill-done': 'dispatch @rubber-duck mode=grill first so grill-result.json lands',
  'plan-done': 'dispatch @rubber-duck mode=critique first so critique-result.json lands',
});

/**
 * Result of a sequencing check.
 * @typedef {Object} SequencingResult
 * @property {boolean} inOrder  True when the dispatch is at-or-after its minimum
 *   gate, or when the guard has no basis to judge (fails OPEN — see below).
 * @property {WorkflowGate} [requiredGate]  The minimum gate, when out of order.
 * @property {string} [reason]  A model-facing, actionable explanation, when out of order.
 */

/**
 * Is `current` at-or-after `required` along the lane's forward spine?
 * Returns null (undecidable → caller fails open) when either gate is off-spine.
 * @param {Lane} lane
 * @param {WorkflowGate} current
 * @param {WorkflowGate} required
 * @returns {boolean|null}
 */
function gateAtLeast(lane, current, required) {
  const order = getOwn(LANE_GATE_ORDER, lane);
  if (order === undefined) return null;
  const ci = order.indexOf(current);
  const ri = order.indexOf(required);
  if (ci === -1 || ri === -1) return null;
  return ci >= ri;
}

/**
 * Evaluate whether an analysis dispatch is in sequence for the lane's gate.
 *
 * Fails OPEN (`{ inOrder: true }`) on every uncertainty: an implementation
 * dispatch (gated elsewhere), an unknown/unmapped agent, an unknown lane, or a
 * gate that is off the forward spine (e.g. a steering-only state). The guard only
 * ever flags a dispatch it is CONFIDENT is premature — a false deny would block
 * real work, which is the failure this module must never cause.
 *
 * @param {{ agentName: unknown, lane: unknown, workflowGate: unknown }} input
 * @returns {SequencingResult}
 */
export function evaluateDispatchSequencing(input) {
  const agent = normalizeDispatchedAgent(input.agentName);
  if (agent === '') return { inOrder: true };
  // Implementation dispatch is hard-gated by evaluateImplementationDispatch; do
  // not double-judge it here (and never soften that hard gate to a warning).
  if (isImplementationDispatch(agent)) return { inOrder: true };

  const lane = normalizeLane(input.lane);
  const laneMap = getOwn(ANALYSIS_MIN_GATE, /** @type {Lane} */ (lane));
  if (laneMap === undefined) return { inOrder: true };

  const required = getOwn(laneMap, agent);
  if (required === undefined) return { inOrder: true };

  const current = /** @type {WorkflowGate} */ (input.workflowGate);
  const ok = gateAtLeast(/** @type {Lane} */ (lane), current, required);
  if (ok === null || ok === true) return { inOrder: true };

  const unblock = getOwn(GATE_UNBLOCK_HINT, required) ?? `reach "${required}" first`;
  const reason =
    `@${agent} is being dispatched at gate "${String(current)}", before "${required}" — ` +
    `the internal gate its output depends on. Its artifact will not advance the gate until "${required}" ` +
    `is reached, so this dispatch is wasted work. To unblock: ${unblock}.`;
  return { inOrder: false, requiredGate: required, reason };
}
