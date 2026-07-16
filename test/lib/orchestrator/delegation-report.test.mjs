// @ts-check

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeDelegation,
  formatDelegationReport,
  formatDelegationDashboard,
  ANALYSIS_SPECIALISTS,
  LANE_ANALYSIS,
} from '../../../lib/orchestrator/delegation-report.mjs';

/**
 * @param {string} agentName
 * @returns {Record<string, unknown>}
 */
function startEvent(agentName) {
  return {
    type: 'subagent_start',
    stepId: `subagent-${agentName}`,
    taskId: 't',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    agentName,
    persona: agentName,
    activeCount: 1,
  };
}

/**
 * @param {string} to
 * @returns {Record<string, unknown>}
 */
function gateEvent(to) {
  return {
    type: 'gate_transition',
    stepId: 'gatectl',
    taskId: 't',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    from: 'x',
    to,
    gate: to,
  };
}

describe('summarizeDelegation', () => {
  it('empty trace → yellow, no dispatches', () => {
    const s = summarizeDelegation([]);
    assert.equal(s.verdict, 'yellow');
    assert.equal(s.totalDispatches, 0);
    assert.deepEqual(s.byAgent, {});
    assert.deepEqual(s.analysisRan, []);
  });

  it('progressed to impl-started with NO dispatch → red (inline work)', () => {
    const s = summarizeDelegation([gateEvent('impl-started')]);
    assert.equal(s.verdict, 'red');
    assert.match(s.notes.join(' '), /inline/i);
  });

  it('read-heavy analysis delegated → green', () => {
    const s = summarizeDelegation([
      startEvent('discovery'),
      startEvent('rubber-duck'),
      startEvent('planner'),
      gateEvent('spec-draft'),
    ]);
    assert.equal(s.verdict, 'green');
    assert.equal(s.totalDispatches, 3);
    assert.deepEqual(s.analysisRan.sort(), ['discovery', 'planner', 'rubber-duck']);
    assert.ok(s.gatesReached.includes('spec-draft'));
  });

  it('only a fullstack persona ran, no analysis → yellow', () => {
    const s = summarizeDelegation([startEvent('backend'), gateEvent('impl-started')]);
    assert.equal(s.verdict, 'yellow');
    assert.equal(s.analysisRan.length, 0);
    assert.equal(s.byAgent['backend'], 1);
  });

  it('counts repeated dispatches per agent, most-dispatched first', () => {
    const s = summarizeDelegation([
      startEvent('rubber-duck'),
      startEvent('rubber-duck'),
      startEvent('discovery'),
    ]);
    assert.equal(s.byAgent['rubber-duck'], 2);
    assert.equal(Object.keys(s.byAgent)[0], 'rubber-duck');
  });

  it('normalizes @-prefixed and .agent-suffixed names', () => {
    const s = summarizeDelegation([startEvent('@Discovery.agent')]);
    assert.equal(s.byAgent['discovery'], 1);
  });

  it('tolerates junk events', () => {
    const s = summarizeDelegation([null, 42, {}, { type: 'subagent_start' }]);
    assert.equal(s.totalDispatches, 0);
  });

  it('exposes the analysis specialist set', () => {
    assert.ok(ANALYSIS_SPECIALISTS.includes('discovery'));
    assert.ok(ANALYSIS_SPECIALISTS.includes('diagnose'));
  });

  it('chore lane is not penalised for skipping analysis (green on an editor dispatch)', () => {
    const s = summarizeDelegation([startEvent('editor'), gateEvent('impl-started')], { lane: 'chore' });
    assert.equal(s.verdict, 'green');
    assert.deepEqual(s.analysisMissing, []);
    assert.equal(s.lane, 'chore');
    assert.deepEqual(LANE_ANALYSIS.chore, []);
  });

  it('chore reaching impl-started with zero dispatches is still red', () => {
    const s = summarizeDelegation([gateEvent('impl-started')], { lane: 'chore' });
    assert.equal(s.verdict, 'red');
  });

  it('feature lane flags a missing planner/tech-design dispatch but stays green if some analysis ran', () => {
    const s = summarizeDelegation([startEvent('discovery'), startEvent('rubber-duck')], { lane: 'feature' });
    assert.ok(s.analysisMissing.includes('planner'));
    assert.ok(s.analysisMissing.includes('tech-design'));
    assert.equal(s.verdict, 'green');
  });

  it('bug lane expects diagnose + rubber-duck', () => {
    const s = summarizeDelegation([startEvent('diagnose'), startEvent('rubber-duck')], { lane: 'bug' });
    assert.deepEqual(s.analysisMissing, []);
    assert.equal(s.verdict, 'green');
  });

  it('unknown lane falls back to the generic analysis superset', () => {
    const s = summarizeDelegation([startEvent('discovery')], { lane: 'nonsense' });
    assert.equal(s.lane, 'nonsense');
    assert.ok(s.analysisMissing.includes('diagnose'));
  });

  it('surfaces warn-mode delegation-floor violations and downgrades green to yellow', () => {
    const violation = {
      type: 'contract_violation',
      stepId: 'delegation-floor',
      taskId: 't',
      ts: '2026-07-05T00:00:00.000Z',
      schemaVersion: 1,
      contract: 'delegation-floor',
      path: 'feature/impl-started',
      errors: ['discovery|tech-design', 'planner'],
    };
    const s = summarizeDelegation([startEvent('rubber-duck'), violation, gateEvent('impl-started')], { lane: 'feature' });
    assert.deepEqual(s.floorViolations.sort(), ['discovery|tech-design', 'planner']);
    // rubber-duck ran (would be green) but a recorded floor violation downgrades it.
    assert.equal(s.verdict, 'yellow');
    assert.match(s.notes.join(' '), /floor fired/i);
  });

  it('ignores contract_violation events for other contracts', () => {
    const other = {
      type: 'contract_violation',
      stepId: 'x',
      taskId: 't',
      ts: '2026-07-05T00:00:00.000Z',
      schemaVersion: 1,
      contract: 'spec-integrity',
      path: 'p',
      errors: ['e'],
    };
    const s = summarizeDelegation(
      [startEvent('discovery'), startEvent('rubber-duck'), startEvent('planner'), other],
      { lane: 'feature' },
    );
    assert.deepEqual(s.floorViolations, []);
    assert.equal(s.verdict, 'green');
  });
});

describe('formatDelegationReport', () => {
  it('renders a compact report with the verdict badge', () => {
    const out = formatDelegationReport(
      summarizeDelegation([startEvent('discovery'), gateEvent('spec-draft')]),
    );
    assert.match(out, /Delegation report — (GREEN|YELLOW|RED)/);
    assert.match(out, /dispatches: 1/);
    assert.match(out, /discovery/);
  });

  it('shows floor violations when present', () => {
    const violation = {
      type: 'contract_violation',
      stepId: 'delegation-floor',
      taskId: 't',
      ts: '2026-07-05T00:00:00.000Z',
      schemaVersion: 1,
      contract: 'delegation-floor',
      path: 'feature/impl-started',
      errors: ['planner'],
    };
    const out = formatDelegationReport(summarizeDelegation([violation, gateEvent('impl-started')], { lane: 'feature' }));
    assert.match(out, /floor violations \(warn\): planner/);
  });
});

describe('formatDelegationDashboard', () => {
  it('tallies verdicts and lists each task', () => {
    const entries = [
      { taskId: 'feat-a', summary: summarizeDelegation([startEvent('discovery'), gateEvent('spec-draft')]) },
      { taskId: 'bug-b', summary: summarizeDelegation([gateEvent('impl-started')]) },
    ];
    const out = formatDelegationDashboard(entries);
    assert.match(out, /2 task\(s\)/);
    assert.match(out, /1 green/);
    assert.match(out, /1 red/);
    assert.match(out, /feat-a/);
    assert.match(out, /bug-b/);
  });

  it('handles an empty fleet', () => {
    const out = formatDelegationDashboard([]);
    assert.match(out, /0 task\(s\)/);
    assert.match(out, /no task traces/);
  });
});
