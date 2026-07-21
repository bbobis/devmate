// @ts-check
/**
 * RC-3 (#231): the pure analysis-dispatch sequencing evaluator.
 *
 * `evaluateDispatchSequencing` flags an analysis agent dispatched before its
 * prerequisite internal gate, and — critically — fails OPEN on every uncertainty,
 * because a false positive would block real work. The gate-index comparison is
 * what lets every legitimate case (same-gate parallel fan-out, same-agent
 * re-dispatch, backward steering) pass without an explicit allowlist: those all
 * leave the gate at-or-after the agent's minimum.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateDispatchSequencing,
  LANE_GATE_ORDER,
  ANALYSIS_MIN_GATE,
} from '../../../lib/workflow/dispatch-sequencing.mjs';
import { TRANSITIONS } from '../../../lib/gate-transitions.mjs';

/** @param {{agentName: unknown, lane: unknown, workflowGate: unknown}} i */
const evalSeq = (i) => evaluateDispatchSequencing(i);

// ── out-of-order dispatches are flagged ──────────────────────────────────────

test('sequencing › @spec-writer before plan-done (feature) is out of order', () => {
  const r = evalSeq({ agentName: 'spec-writer', lane: 'feature', workflowGate: 'grill-done' });
  assert.equal(r.inOrder, false);
  assert.equal(r.requiredGate, 'plan-done');
  assert.match(String(r.reason), /spec-writer/);
  assert.match(String(r.reason), /plan-done/);
  assert.match(String(r.reason), /critique-result\.json/);
});

test('sequencing › @planner before grill-done (feature) is out of order', () => {
  const r = evalSeq({ agentName: 'planner', lane: 'feature', workflowGate: 'lane-set' });
  assert.equal(r.inOrder, false);
  assert.equal(r.requiredGate, 'grill-done');
  assert.match(String(r.reason), /grill-result\.json|mode=grill/);
});

test('sequencing › @rubber-duck before discovery-done (feature) is out of order', () => {
  const r = evalSeq({ agentName: 'rubber-duck', lane: 'feature', workflowGate: 'lane-set' });
  assert.equal(r.inOrder, false);
  assert.equal(r.requiredGate, 'discovery-done');
});

test('sequencing › a leading @ on the agent name is normalized', () => {
  const r = evalSeq({ agentName: '@spec-writer', lane: 'feature', workflowGate: 'grill-done' });
  assert.equal(r.inOrder, false);
  assert.equal(r.requiredGate, 'plan-done');
});

// ── in-order dispatches pass ─────────────────────────────────────────────────

test('sequencing › @spec-writer at plan-done (its minimum) is in order', () => {
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'feature', workflowGate: 'plan-done' }).inOrder, true);
});

test('sequencing › @rubber-duck at grill-done (the critique case) is in order', () => {
  // Critique is dispatched at grill-done, already past discovery-done — so the
  // single discovery-done minimum covers both grill and critique with no need to
  // read a `mode` the payload does not carry.
  assert.equal(evalSeq({ agentName: 'rubber-duck', lane: 'feature', workflowGate: 'grill-done' }).inOrder, true);
});

test('sequencing › @planner at grill-done, in parallel with @ui-ux, is in order', () => {
  assert.equal(evalSeq({ agentName: 'planner', lane: 'feature', workflowGate: 'grill-done' }).inOrder, true);
});

test('sequencing › backward steering (spec-writer re-dispatched at impl-started) is in order', () => {
  // A revise-scope / re-plan loop leaves the gate at impl-started, which is past
  // plan-done — a legitimate re-dispatch must not be flagged.
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'feature', workflowGate: 'impl-started' }).inOrder, true);
});

// ── fail-open on every uncertainty ───────────────────────────────────────────

test('sequencing › an implementation dispatch is not judged here (fails open)', () => {
  // Hard-gated by evaluateImplementationDispatch — must never be softened to a warning.
  assert.equal(evalSeq({ agentName: 'fullstack', lane: 'feature', workflowGate: 'lane-set' }).inOrder, true);
  assert.equal(evalSeq({ agentName: 'backend', lane: 'feature', workflowGate: 'lane-set' }).inOrder, true);
});

test('sequencing › an unmapped analysis agent fails open', () => {
  assert.equal(evalSeq({ agentName: 'tech-design', lane: 'feature', workflowGate: 'no-lane' }).inOrder, true);
  assert.equal(evalSeq({ agentName: 'discovery', lane: 'feature', workflowGate: 'no-lane' }).inOrder, true);
});

test('sequencing › the bug lane has no fixed-min-gate analysis mapping (fails open)', () => {
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'bug', workflowGate: 'lane-set' }).inOrder, true);
  assert.equal(evalSeq({ agentName: 'rubber-duck', lane: 'bug', workflowGate: 'lane-set' }).inOrder, true);
});

test('sequencing › an unknown lane fails open', () => {
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'nonsense', workflowGate: 'grill-done' }).inOrder, true);
});

test('sequencing › an off-spine / unknown current gate fails open', () => {
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'feature', workflowGate: 'parked' }).inOrder, true);
  assert.equal(evalSeq({ agentName: 'spec-writer', lane: 'feature', workflowGate: 'not-a-gate' }).inOrder, true);
});

test('sequencing › an empty / missing agent name fails open', () => {
  assert.equal(evalSeq({ agentName: '', lane: 'feature', workflowGate: 'lane-set' }).inOrder, true);
  assert.equal(evalSeq({ agentName: undefined, lane: 'feature', workflowGate: 'lane-set' }).inOrder, true);
});

// ── drift guard: the spine is consistent with the transition table ───────────

test('sequencing › LANE_GATE_ORDER respects every forward edge in TRANSITIONS', () => {
  // Pins the spine to the runtime gate graph: any forward auto-advance edge whose
  // BOTH endpoints appear in the ordered spine must go strictly forward in it.
  // (Human-gate edges like spec-draft → spec-approved live outside TRANSITIONS and
  // are not pinned here; they never precede a mapped minimum gate.)
  for (const [lane, order] of Object.entries(LANE_GATE_ORDER)) {
    const laneTransitions = TRANSITIONS[/** @type {'feature'|'bug'|'chore'} */ (lane)];
    for (const [from, events] of Object.entries(laneTransitions)) {
      const fromIdx = order.indexOf(/** @type {any} */ (from));
      if (fromIdx === -1) continue;
      for (const to of Object.values(events)) {
        const toIdx = order.indexOf(/** @type {any} */ (to));
        if (toIdx === -1) continue;
        assert.ok(
          fromIdx < toIdx,
          `${lane}: forward edge ${from} → ${to} contradicts LANE_GATE_ORDER (${fromIdx} !< ${toIdx})`,
        );
      }
    }
  }
});

test('sequencing › every mapped minimum gate exists in its lane spine', () => {
  // If a minimum gate were absent from the spine, gateAtLeast would fail open and
  // silently stop guarding that agent.
  for (const [lane, agents] of Object.entries(ANALYSIS_MIN_GATE)) {
    const order = LANE_GATE_ORDER[/** @type {'feature'|'bug'|'chore'} */ (lane)];
    for (const [agent, minGate] of Object.entries(agents)) {
      assert.ok(
        order.includes(/** @type {any} */ (minGate)),
        `${lane}: minimum gate ${minGate} for @${agent} is not in LANE_GATE_ORDER`,
      );
    }
  }
});
