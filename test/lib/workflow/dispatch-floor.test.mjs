// @ts-check

/**
 * Dispatch-floor guard tests.
 *
 * `assertDispatchFloor` is the mirror of `assertDispatchResult`: it refuses to
 * auto-advance an internal analysis gate unless a `subagent_start` trace event
 * proves the owning specialist was dispatched — blocking the orchestrator from
 * doing discovery/grill/planning inline (the failure that fills its own context
 * window). A gate with no registered floor always passes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDispatchFloor,
  GATE_DISPATCH_FLOOR,
  LANE_DISPATCH_REQUIREMENTS,
  missingLaneDispatches,
  dispatchedAgentsFromTrace,
} from '../../../lib/workflow/orchestrator.mjs';

/**
 * Build a subagent_start trace event fixture.
 * @param {string} agentName
 * @returns {Record<string, unknown>}
 */
function startEvent(agentName) {
  return {
    type: 'subagent_start',
    stepId: `subagent-${agentName}`,
    taskId: 't1',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    agentName,
    persona: agentName,
    activeCount: 1,
  };
}

describe('assertDispatchFloor', () => {
  it('passes a gate with no registered floor', () => {
    assert.deepEqual(assertDispatchFloor({ gate: 'impl-started', traceEvents: [] }), { ok: true });
    assert.deepEqual(assertDispatchFloor({ gate: 'pr-ready', traceEvents: [] }), { ok: true });
  });

  it('requires a gate name', () => {
    const missing = assertDispatchFloor({ gate: '', traceEvents: [] });
    assert.equal(missing.ok, false);
    assert.match(String(missing.error), /gate is required/);
    assert.equal(assertDispatchFloor({}).ok, false);
  });

  it('blocks discovery-done when no discovery/tech-design was dispatched', () => {
    const r = assertDispatchFloor({ gate: 'discovery-done', traceEvents: [] });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /discovery-done/);
    assert.match(String(r.error), /do not do this work inline/);
  });

  it('clears discovery-done when discovery was dispatched', () => {
    assert.deepEqual(
      assertDispatchFloor({ gate: 'discovery-done', traceEvents: [startEvent('discovery')] }),
      { ok: true },
    );
  });

  it('clears discovery-done on tech-design alone (any-of)', () => {
    assert.deepEqual(
      assertDispatchFloor({ gate: 'discovery-done', traceEvents: [startEvent('tech-design')] }),
      { ok: true },
    );
  });

  it('gates grill-done on a rubber-duck dispatch', () => {
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: [startEvent('discovery')] }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: [startEvent('rubber-duck')] }).ok, true);
  });

  it('gates plan-done on a planner dispatch', () => {
    assert.equal(assertDispatchFloor({ gate: 'plan-done', traceEvents: [] }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'plan-done', traceEvents: [startEvent('planner')] }).ok, true);
  });

  it('normalizes @-prefixed and .agent-suffixed names', () => {
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: [startEvent('@rubber-duck.agent')] }).ok, true);
    assert.equal(assertDispatchFloor({ gate: 'discovery-done', traceEvents: [startEvent('Discovery.agent')] }).ok, true);
  });

  it('does not let a fullstack-persona dispatch satisfy an analysis floor', () => {
    // backend/frontend/editor canonicalize to fullstack, which owns no analysis gate.
    assert.equal(assertDispatchFloor({ gate: 'plan-done', traceEvents: [startEvent('backend')] }).ok, false);
  });

  it('ignores non-subagent_start events', () => {
    const gateEvent = {
      type: 'gate_transition',
      stepId: 's',
      taskId: 't1',
      ts: '2026-07-05T00:00:00.000Z',
      schemaVersion: 1,
      from: 'a',
      to: 'b',
      gate: 'grill-done',
    };
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: [gateEvent] }).ok, false);
  });

  it('tolerates non-array / junk traceEvents (fails the floored gate closed)', () => {
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: null }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: 'nope' }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'grill-done', traceEvents: [null, 42, {}] }).ok, false);
  });

  it('gates the bug-lane diagnosis-done milestone on a @diagnose dispatch', () => {
    assert.equal(assertDispatchFloor({ gate: 'diagnosis-done', traceEvents: [] }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'diagnosis-done', traceEvents: [startEvent('rubber-duck')] }).ok, false);
    assert.equal(assertDispatchFloor({ gate: 'diagnosis-done', traceEvents: [startEvent('diagnose')] }).ok, true);
  });

  it('registers every internal analysis gate/milestone across lanes', () => {
    assert.deepEqual(
      Object.keys(GATE_DISPATCH_FLOOR).sort(),
      ['diagnosis-done', 'discovery-done', 'grill-done', 'plan-done'],
    );
  });
});

describe('missingLaneDispatches', () => {
  it('feature requires discovery/tech-design, rubber-duck, and planner', () => {
    assert.deepEqual(
      missingLaneDispatches('feature', []).sort(),
      ['discovery|tech-design', 'planner', 'rubber-duck'],
    );
    assert.deepEqual(
      missingLaneDispatches('feature', [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner')]),
      [],
    );
    // tech-design satisfies the discovery/tech-design any-of group.
    assert.deepEqual(
      missingLaneDispatches('feature', [startEvent('tech-design'), startEvent('rubber-duck'), startEvent('planner')]),
      [],
    );
  });

  it('bug requires diagnose + rubber-duck', () => {
    assert.deepEqual(missingLaneDispatches('bug', [startEvent('diagnose')]), ['rubber-duck']);
    assert.deepEqual(missingLaneDispatches('bug', [startEvent('diagnose'), startEvent('rubber-duck')]), []);
  });

  it('chore and unknown lanes have no floor', () => {
    assert.deepEqual(missingLaneDispatches('chore', []), []);
    assert.deepEqual(missingLaneDispatches('nonsense', []), []);
  });

  it('exposes the lane requirement map', () => {
    assert.deepEqual(Object.keys(LANE_DISPATCH_REQUIREMENTS).sort(), ['bug', 'chore', 'feature']);
    assert.deepEqual(LANE_DISPATCH_REQUIREMENTS.chore, []);
  });

  it('honors a per-lane requirements override', () => {
    const override = { feature: [['discovery']] }; // only require discovery
    assert.deepEqual(missingLaneDispatches('feature', [startEvent('discovery')], override), []);
    assert.deepEqual(missingLaneDispatches('feature', [], override), ['discovery']);
    // lanes not named in the override keep their defaults.
    assert.deepEqual(missingLaneDispatches('bug', [startEvent('diagnose')], override), ['rubber-duck']);
  });

  it('an override to an empty group list removes a lane floor', () => {
    assert.deepEqual(missingLaneDispatches('feature', [], { feature: [] }), []);
  });
});

describe('dispatchedAgentsFromTrace', () => {
  it('collects normalized subagent_start agent names, ignoring other events', () => {
    const set = dispatchedAgentsFromTrace([
      startEvent('@Discovery.agent'),
      startEvent('planner'),
      { type: 'gate_transition', to: 'impl-started' },
    ]);
    assert.ok(set.has('discovery'));
    assert.ok(set.has('planner'));
    assert.equal(set.size, 2);
  });

  it('tolerates non-array input', () => {
    assert.equal(dispatchedAgentsFromTrace(null).size, 0);
  });
});
