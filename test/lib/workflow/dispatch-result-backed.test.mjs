// @ts-check

/**
 * Dispatch-result backing guard tests.
 *
 * `assertDispatchResultBacked` is the proof-of-dispatch companion to the
 * shape-only `assertDispatchResult`: for a trace-backed agent (`fullstack` and
 * its frontend/backend/editor personas) an `ok` result validates only when a
 * `subagent_start` trace event proves a real subagent produced it. This closes
 * the hole where the orchestrator hand-authors the very result artifact it then
 * validates — reshaping a malformed reply into the shape the validator expects
 * instead of halting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDispatchResultBacked,
  isTraceBackedResultAgent,
} from '../../../lib/workflow/orchestrator.mjs';

/**
 * A minimal `subagent_start` trace event fixture.
 * @param {string} agentName
 * @returns {Record<string, unknown>}
 */
function startEvent(agentName) {
  return {
    type: 'subagent_start',
    stepId: `s-${agentName}`,
    agentName,
    persona: agentName,
    activeCount: 1,
  };
}

/** A valid-shape fullstack `ok` result. */
const OK_FULLSTACK = { agentName: 'fullstack', status: 'ok', payload: { summary: 'done' } };

describe('isTraceBackedResultAgent', () => {
  it('is true for fullstack and its personas', () => {
    for (const name of ['fullstack', 'frontend', 'backend', 'editor']) {
      assert.equal(isTraceBackedResultAgent(name), true, name);
    }
  });

  it('is false for analysis agents and junk input', () => {
    for (const name of ['discovery', 'planner', 'rubber-duck', 'diagnose', '', '  ']) {
      assert.equal(isTraceBackedResultAgent(name), false, JSON.stringify(name));
    }
    assert.equal(isTraceBackedResultAgent(/** @type {any} */ (null)), false);
  });
});

describe('assertDispatchResultBacked', () => {
  it('passes a shape failure straight through (fails closed before the trace check)', () => {
    const r = assertDispatchResultBacked('fullstack', null, [startEvent('fullstack')]);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /empty or missing/i);
  });

  it('clears an ok fullstack result backed by a fullstack subagent_start', () => {
    assert.deepEqual(
      assertDispatchResultBacked('fullstack', OK_FULLSTACK, [startEvent('fullstack')]),
      { ok: true },
    );
  });

  it('rejects an ok fullstack result with no backing dispatch', () => {
    const r = assertDispatchResultBacked('fullstack', OK_FULLSTACK, []);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /not backed by a dispatch/i);
    assert.match(String(r.error), /do not rewrite the result artifact/i);
  });

  it('rejects when the trace holds only other agents (no fullstack start)', () => {
    const r = assertDispatchResultBacked('fullstack', OK_FULLSTACK, [
      startEvent('discovery'),
      startEvent('planner'),
    ]);
    assert.equal(r.ok, false);
  });

  it('normalizes personas: a backend start backs a fullstack result and vice versa', () => {
    assert.deepEqual(
      assertDispatchResultBacked('fullstack', OK_FULLSTACK, [startEvent('backend')]),
      { ok: true },
    );
    assert.deepEqual(
      assertDispatchResultBacked('backend', OK_FULLSTACK, [startEvent('fullstack')]),
      { ok: true },
    );
  });

  it('does not require backing for a non-ok result (it carries a reason and advances nothing)', () => {
    const blocked = { agentName: 'fullstack', status: 'blocked', reason: 'scope conflict' };
    assert.deepEqual(assertDispatchResultBacked('fullstack', blocked, []), { ok: true });
  });

  it('does not require backing for a non-trace-backed agent (shape check alone)', () => {
    const discovery = { status: 'ok', payload: { claims: [{ fact: 'f' }] } };
    assert.deepEqual(assertDispatchResultBacked('discovery', discovery, []), { ok: true });
  });
});
