// @ts-check
/**
 * E10-02: the workflow-state anchor block is rendered from TaskState + the
 * unified transition table (never a duplicated list), one field per line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_CLOSE_TAG,
  ANCHOR_OPEN_TAG,
  FULL_ANCHOR_TURN_CADENCE,
  buildStateAnchor,
  buildStateAnchorLine,
  shouldEmitFullAnchor,
} from '../../../lib/orchestrator/state-anchor.mjs';
import { flattenTransitions } from '../../../lib/gate-transitions.mjs';

/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: 'feat-142',
    lane: 'feature',
    workflowGate: 'spec-draft',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 3,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

test('buildStateAnchor renders gate/lane/step/legal-next for a representative TaskState', () => {
  const block = buildStateAnchor(makeState());
  const lines = block.split('\n');

  assert.equal(lines[0], ANCHOR_OPEN_TAG, 'block opens with the anchor tag');
  assert.equal(lines[lines.length - 1], ANCHOR_CLOSE_TAG, 'block closes with the anchor tag');
  assert.ok(lines.includes('taskId: feat-142'), 'taskId field rendered on its own line');
  assert.ok(lines.includes('lane: feature'), 'lane field rendered on its own line');
  assert.ok(lines.includes('gate: spec-draft'), 'gate field rendered on its own line');
  assert.ok(lines.includes('step: 3'), 'step field rendered on its own line');

  const expectedLegal = flattenTransitions()['spec-draft'];
  assert.ok(expectedLegal.length > 0, 'fixture gate has legal successors');
  assert.ok(
    lines.includes(`legal next gates: ${expectedLegal.join(', ')}`),
    'legal-next line lists exactly the flattened-table successors',
  );
});

test('buildStateAnchor renders a staleness line only when stale', () => {
  const state = makeState({ workflowGate: 'impl-started' });

  const stale = buildStateAnchor(state, { staleness: { stale: true, idleHours: 72 } });
  assert.match(stale, /staleness: STALE/, 'stale task renders the staleness line');
  assert.match(stale, /idle ~72h/, 'staleness line reports the idle age');
  assert.match(stale, /auto-park/, 'staleness line steers toward auto-park');

  const fresh = buildStateAnchor(state, { staleness: { stale: false, idleHours: 2 } });
  assert.doesNotMatch(fresh, /staleness:/, 'a non-stale task renders no staleness line');

  const none = buildStateAnchor(state);
  assert.doesNotMatch(none, /staleness:/, 'omitted staleness renders no line');
});

test('legal transitions come from flattenTransitions for every gate (no duplicated list)', () => {
  const table = flattenTransitions();
  for (const [gate, successors] of Object.entries(table)) {
    const state = makeState({
      workflowGate: /** @type {TaskState['workflowGate']} */ (gate),
    });
    const block = buildStateAnchor(state);
    const expected =
      successors.length > 0
        ? `legal next gates: ${successors.join(', ')}`
        : 'legal next gates: (none — terminal gate)';
    assert.ok(
      block.split('\n').includes(expected),
      `gate ${gate} renders the flattened-table successors verbatim`,
    );
  }
});

test('terminal gate renders an explicit none marker', () => {
  const block = buildStateAnchor(makeState({ workflowGate: 'done' }));
  assert.ok(
    block.includes('legal next gates: (none — terminal gate)'),
    'terminal gate names no successors instead of an empty list',
  );
});

test('opts.legalNext overrides the flattened table', () => {
  const block = buildStateAnchor(makeState(), { legalNext: ['spec-approved'] });
  assert.ok(block.includes('legal next gates: spec-approved'));
  assert.ok(!block.includes('spec-approved, spec-draft'), 'default projection is not used');
});

test('opts.pendingArtifact adds a pending line; absent by default', () => {
  const withPending = buildStateAnchor(makeState(), {
    pendingArtifact: 'human review of .devmate/session/spec.md',
  });
  assert.ok(
    withPending
      .split('\n')
      .includes('pending: human review of .devmate/session/spec.md'),
    'pending line rendered when the artifact is supplied',
  );

  const withoutPending = buildStateAnchor(makeState());
  assert.ok(!withoutPending.includes('pending:'), 'no pending line without opts');

  const blankPending = buildStateAnchor(makeState(), { pendingArtifact: '   ' });
  assert.ok(!blankPending.includes('pending:'), 'blank pending artifact is ignored');
});

test('block is one field per line between the tags', () => {
  const lines = buildStateAnchor(makeState()).split('\n');
  const body = lines.slice(1, -1);
  const prefixes = ['taskId: ', 'lane: ', 'gate: ', 'step: ', 'legal next gates: ', 'reminder: '];
  assert.equal(body.length, prefixes.length, 'exactly one line per field');
  body.forEach((line, i) => {
    assert.ok(
      line.startsWith(prefixes[i] ?? ''),
      `line ${i} starts with "${prefixes[i]}" (got "${line}")`,
    );
  });
});

test('buildStateAnchorLine renders the compact one-line variant', () => {
  const line = buildStateAnchorLine(makeState());
  assert.ok(!line.includes('\n'), 'single line');
  assert.ok(line.includes('taskId feat-142'));
  assert.ok(line.includes('lane feature'));
  assert.ok(line.includes('gate spec-draft'));
  assert.ok(line.includes('step 3'));
});

test('shouldEmitFullAnchor: always full at human-decision gates, cadence elsewhere', () => {
  assert.equal(shouldEmitFullAnchor(makeState({ workflowGate: 'spec-draft' }), 0), true);
  assert.equal(shouldEmitFullAnchor(makeState({ workflowGate: 'pr-ready' }), 0), true);
  assert.equal(
    shouldEmitFullAnchor(makeState({ workflowGate: 'impl-started' }), 0),
    false,
    'below cadence at a non-human gate the one-liner suffices',
  );
  assert.equal(
    shouldEmitFullAnchor(
      makeState({ workflowGate: 'impl-started' }),
      FULL_ANCHOR_TURN_CADENCE,
    ),
    true,
    'cadence reached re-emits the full block',
  );
});

test('buildStateAnchor renders an implementation line when implProgress is supplied', () => {
  const block = buildStateAnchor(makeState({ workflowGate: 'impl-started' }), {
    implProgress: { done: 2, total: 5, completedIds: [1, 2], nextId: 3, nextLabel: 'wire the endpoint' },
  });
  const lines = block.split('\n');
  assert.ok(
    lines.includes('implementation: 2/5 ACs complete (next AC3: wire the endpoint)'),
    'implementation progress line rendered with next AC',
  );
});

test('buildStateAnchor: all ACs complete renders a terminal implementation line', () => {
  const block = buildStateAnchor(makeState({ workflowGate: 'impl-started' }), {
    implProgress: { done: 3, total: 3, completedIds: [1, 2, 3], nextId: null, nextLabel: null },
  });
  assert.match(block, /implementation: 3\/3 ACs complete \(all ACs complete\)/);
});

test('buildStateAnchor omits the implementation line when implProgress is absent or empty', () => {
  const noOpts = buildStateAnchor(makeState());
  assert.ok(!noOpts.includes('implementation:'), 'no implementation line without implProgress');
  const emptyTotal = buildStateAnchor(makeState(), {
    implProgress: { done: 0, total: 0, completedIds: [], nextId: null, nextLabel: null },
  });
  assert.ok(!emptyTotal.includes('implementation:'), 'no implementation line when total is 0');
});
