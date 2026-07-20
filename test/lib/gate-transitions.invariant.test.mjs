// @ts-check
/**
 * #132: the gate-graph invariant — every gate a lane can reach at runtime has a
 * runtime-fireable exit (or is a legitimate rest).
 *
 * A one-off test catches ONE dead end; this property test over the whole graph
 * catches the CLASS, including any future edge added to the table without a
 * matching runtime firer. It uses the SAME per-lane caller allowlist
 * `isUserStuck` (#131) is built on, so the two can never disagree.
 *
 * It would have failed on the pre-fix code twice over: before #127 wired the
 * feature steering, `(feature, impl-started)` had no fireable exit; before #132
 * wired `pass-verification` into every LANE_CHAIN, `(bug, impl-started)` had
 * none either. Both are green now — the dead-ends this epic set out to close.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STEERING, TRANSITIONS, reachableGates } from '../../lib/gate-transitions.mjs';
import { isUserStuck } from '../e2e/session-harness.mjs';
import { getOwn } from '../../lib/object-utils.mjs';

/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */
/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

const LANES = /** @type {Lane[]} */ (['feature', 'bug', 'chore']);

/** Terminal gates are a legitimate end, not a dead end — excluded from the check. */
const TERMINAL_GATES = new Set(['done', 'abandoned']);

/**
 * The gate EVENTS legal from (lane, gate) — for the failure message, so a
 * regression names the exact stranded gate and its unfireable exits.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {string[]}
 */
function legalEventsFrom(lane, gate) {
  const laneTable = getOwn(TRANSITIONS, lane);
  const gateTable = laneTable ? getOwn(laneTable, gate) : undefined;
  const steerTable = getOwn(STEERING, gate);
  return [...Object.keys(gateTable ?? {}), ...Object.keys(steerTable ?? {})];
}

for (const lane of LANES) {
  for (const gate of reachableGates(lane)) {
    if (TERMINAL_GATES.has(gate)) continue;
    test(`#132 invariant › (${lane}, ${gate}) has a runtime path forward`, () => {
      const state = /** @type {TaskState} */ ({ lane, workflowGate: gate });
      assert.ok(
        !isUserStuck(state),
        `(${lane}, ${gate}) is a dead end: no runtime caller on this lane fires any legal exit ` +
          `[${legalEventsFrom(lane, gate).join(', ')}], and it is not a resting gate.`,
      );
    });
  }
}

// A check on the checker: BFS reachability for the smallest lane, hand-verified.
test('#132 › reachableGates(bug) matches the hand-verified set', () => {
  assert.deepEqual(
    [...reachableGates('bug')].sort(),
    [
      'abandoned', 'done', 'grill-done', 'impl-started', 'lane-set',
      'no-lane', 'parked', 'plan-approved', 'pr-ready', 'verification-passed',
    ],
  );
});

test('#132 › reachableGates is lane-precise — no cross-lane gates leak in', () => {
  // The bug lane has no discovery, no spec, and no separate plan-done gate; a
  // reachability built on the lane-agnostic spine (legalTransitions) would wrongly
  // pull these in and then flag them as dead ends.
  const bug = reachableGates('bug');
  for (const alien of /** @type {WorkflowGate[]} */ (['discovery-done', 'spec-draft', 'spec-approved', 'plan-done'])) {
    assert.ok(!bug.has(alien), `bug reachability leaked the cross-lane gate ${alien}`);
  }
  // And the chore lane skips pr-ready entirely (verification-passed → done).
  assert.ok(!reachableGates('chore').has('pr-ready'), 'chore reachability leaked pr-ready');
});
