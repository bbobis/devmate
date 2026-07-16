// @ts-check
/**
 * E9-23: pure scorer unit tests, including the regression cases — a broken
 * process guard (an edit slipping in before impl-started, an illegal gate
 * jump, a silent budget breach, tool-call sprawl) must fail the eval, never
 * silently pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrajectory, TOOL_CALL_CAP } from '../../evals/trajectory/scorer.mjs';

const TS = '2026-07-01T00:00:00.000Z';

/**
 * @param {string} from
 * @param {string} to
 * @returns {Record<string, unknown>}
 */
function gate(from, to) {
  return { type: 'gate_transition', taskId: 't-traj', stepId: 'gatectl', ts: TS, schemaVersion: 1, from, to, gate: to };
}

/**
 * @param {string} actionType
 * @returns {Record<string, unknown>}
 */
function action(actionType) {
  return { type: 'action', taskId: 't-traj', stepId: 's1', ts: TS, schemaVersion: 1, actionType, path: 'src/x.mjs', digest: 'aaaaaaaaaaaaaaaa' };
}

/** @returns {Record<string, unknown>} */
function budget() {
  return { type: 'budget_warning', taskId: 't-traj', stepId: 'session-budget', ts: TS, schemaVersion: 1, field: 'session-total', current: 2400, limit: 2000 };
}

/** @returns {Array<Record<string, unknown>>} */
function healthyEvents() {
  return [
    gate('no-lane', 'lane-set'),
    action('read_file'),
    gate('lane-set', 'discovery-done'),
    gate('discovery-done', 'grill-done'),
    gate('grill-done', 'plan-done'),
    gate('plan-done', 'spec-draft'),
    gate('spec-draft', 'spec-approved'),
    gate('spec-approved', 'impl-started'),
    action('write_file'),
    budget(),
    gate('impl-started', 'verification-passed'),
  ];
}

test('healthy synthetic trajectory scores 4/4', () => {
  const result = scoreTrajectory({ events: healthyEvents(), thresholdCrossed: true });
  assert.deepEqual(result, {
    noEditBeforeImpl: true,
    legalTransitionSeq: true,
    budgetEventsPresent: true,
    boundedToolCalls: true,
    score: 4,
  });
});

test('regression: a source edit with no impl-started transition at all fails noEditBeforeImpl', () => {
  const result = scoreTrajectory({
    events: [gate('no-lane', 'lane-set'), action('write_file')],
    thresholdCrossed: false,
  });
  assert.equal(result.noEditBeforeImpl, false);
  assert.equal(result.score, 3);
});

test('read-only tools before impl-started are not source edits', () => {
  const result = scoreTrajectory({
    events: [action('read_file'), gate('spec-approved', 'impl-started'), action('write_file')],
    thresholdCrossed: false,
  });
  assert.equal(result.noEditBeforeImpl, true);
});

test('every source-edit tool name is caught pre-impl', () => {
  for (const tool of ['str_replace_editor', 'write_file', 'insert_content_into_file', 'replace_in_file']) {
    const result = scoreTrajectory({
      events: [action(tool), gate('spec-approved', 'impl-started')],
      thresholdCrossed: false,
    });
    assert.equal(result.noEditBeforeImpl, false, `${tool} is a source edit`);
  }
});

test('illegal gate pair fails legalTransitionSeq', () => {
  const events = healthyEvents().map((e) =>
    e.to === 'impl-started' ? { ...e, from: 'grill-done' } : e
  );
  const result = scoreTrajectory({ events, thresholdCrossed: true });
  assert.equal(result.legalTransitionSeq, false);
  assert.equal(result.score, 3);
});

test('unknown or prototype-key gate names fail legalTransitionSeq without throwing', () => {
  for (const from of ['nonsense', 'constructor', '__proto__']) {
    const result = scoreTrajectory({
      events: [gate(from, 'done')],
      thresholdCrossed: false,
    });
    assert.equal(result.legalTransitionSeq, false, `from "${from}" is illegal`);
  }
});

test('threshold crossed without a budget_warning fails budgetEventsPresent', () => {
  const events = healthyEvents().filter((e) => e.type !== 'budget_warning');
  const result = scoreTrajectory({ events, thresholdCrossed: true });
  assert.equal(result.budgetEventsPresent, false);
  assert.equal(result.score, 3);
});

test('no threshold crossing passes budgetEventsPresent vacuously', () => {
  const events = healthyEvents().filter((e) => e.type !== 'budget_warning');
  const result = scoreTrajectory({ events, thresholdCrossed: false });
  assert.equal(result.budgetEventsPresent, true);
});

test('tool-call count at the cap is bounded; one over is not', () => {
  const prefix = [gate('spec-approved', 'impl-started')];
  const atCap = Array.from({ length: TOOL_CALL_CAP }, () => action('write_file'));
  assert.equal(
    scoreTrajectory({ events: [...prefix, ...atCap], thresholdCrossed: false }).boundedToolCalls,
    true
  );
  assert.equal(
    scoreTrajectory({
      events: [...prefix, ...atCap, action('write_file')],
      thresholdCrossed: false,
    }).boundedToolCalls,
    false
  );
});

test('non-action events do not count toward the tool-call cap', () => {
  const stepDone = { type: 'step_complete', taskId: 't-traj', stepId: 's1', ts: TS, schemaVersion: 1, label: 'x', artifactPaths: [] };
  const events = [
    gate('spec-approved', 'impl-started'),
    ...Array.from({ length: TOOL_CALL_CAP + 10 }, () => ({ ...stepDone })),
    action('write_file'),
  ];
  const result = scoreTrajectory({ events, thresholdCrossed: false });
  assert.equal(result.boundedToolCalls, true);
});

test('an empty trace scores 4/4 vacuously', () => {
  const result = scoreTrajectory({ events: [], thresholdCrossed: false });
  assert.equal(result.score, 4);
});
