// @ts-check
/**
 * E9-23: trajectory eval — over recorded (synthetic) trace fixtures, assert
 * the four trajectory invariants: no source-edit before impl-started, every
 * gate_transition legal per the unified table, budget_warning present when a
 * threshold was crossed, and a bounded tool-call count. Each bad fixture must
 * fail exactly its targeted invariant. Auto-runs under `node --test` as part
 * of `npm run verify`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl } from '../../lib/json-io.mjs';
import { validateTraceEvent } from '../../lib/trace/schema.mjs';
import { scoreTrajectory, TOOL_CALL_CAP } from './scorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

/**
 * @type {{ fixtures: Array<{ name: string, file: string, thresholdCrossed: boolean,
 *   failsInvariant: string|null }> }}
 */
const MANIFEST = JSON.parse(await fsp.readFile(join(FIXTURES_DIR, 'manifest.json'), 'utf8'));

const INVARIANTS = /** @type {const} */ ([
  'noEditBeforeImpl',
  'legalTransitionSeq',
  'budgetEventsPresent',
  'boundedToolCalls',
]);

/**
 * Load a fixture's recorded events and score them with its manifest metadata.
 * @param {string} name
 * @returns {Promise<{ result: import('../../lib/types.mjs').TrajectoryEvalResult,
 *   events: Array<Record<string, unknown>> }>}
 */
async function scoreFixture(name) {
  const entry = MANIFEST.fixtures.find((f) => f.name === name);
  assert.ok(entry, `fixture "${name}" is in the manifest`);
  const raw = await fsp.readFile(join(FIXTURES_DIR, entry.file), 'utf8');
  const events = /** @type {any[]} */ (parseJsonl(raw));
  return { result: scoreTrajectory({ events, thresholdCrossed: entry.thresholdCrossed }), events };
}

/**
 * Assert exactly the targeted invariant fails and the other three hold.
 * @param {import('../../lib/types.mjs').TrajectoryEvalResult} result
 * @param {(typeof INVARIANTS)[number]} target
 */
function assertIsolatedFailure(result, target) {
  for (const invariant of INVARIANTS) {
    assert.equal(
      result[invariant],
      invariant !== target,
      `${invariant} expected ${invariant !== target}: ${JSON.stringify(result)}`
    );
  }
  assert.equal(result.score, 3);
}

test('every fixture event is schema-valid', async () => {
  // @bounded-alloc — reads the checked-in fixture files listed in the manifest.
  for (const entry of MANIFEST.fixtures) {
    const raw = await fsp.readFile(join(FIXTURES_DIR, entry.file), 'utf8');
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const verdict = validateTraceEvent(JSON.parse(line));
      assert.deepEqual(verdict, { ok: true, errors: [] }, `${entry.file}: ${line}`);
    }
  }
});

test('clean trace scores 4/4', async () => {
  const { result } = await scoreFixture('clean');
  assert.deepEqual(result, {
    noEditBeforeImpl: true,
    legalTransitionSeq: true,
    budgetEventsPresent: true,
    boundedToolCalls: true,
    score: 4,
  });
});

test('edit-before-impl trace fails noEditBeforeImpl', async () => {
  const { result } = await scoreFixture('edit-before-impl');
  assertIsolatedFailure(result, 'noEditBeforeImpl');
});

test('illegal transition fails legalTransitionSeq', async () => {
  const { result } = await scoreFixture('illegal-transition');
  assertIsolatedFailure(result, 'legalTransitionSeq');
});

test('missing budget event fails budgetEventsPresent', async () => {
  const { result } = await scoreFixture('missing-budget-event');
  assertIsolatedFailure(result, 'budgetEventsPresent');
});

test('excess tool calls fail boundedToolCalls', async () => {
  const { result, events } = await scoreFixture('excess-tool-calls');
  // Self-check against cap drift: the fixture must actually exceed the cap,
  // or the assertion below would be testing nothing.
  const toolCalls = events.filter((e) => e.type === 'action').length;
  assert.ok(toolCalls > TOOL_CALL_CAP, `fixture has ${toolCalls} tool calls vs cap ${TOOL_CALL_CAP}`);
  assertIsolatedFailure(result, 'boundedToolCalls');
});

/* ------------------------------------------------------------------ *
 * FO-5: two-phase discovery fan-out trajectory shape.                 *
 * ------------------------------------------------------------------ */

/**
 * Load a fixture's parsed events (no scoring — the fanout fixtures pin a
 * dispatch shape, not the four E9-23 invariants).
 * @param {string} name
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function loadFixtureEvents(name) {
  const entry = MANIFEST.fixtures.find((f) => f.name === name);
  assert.ok(entry, `fixture "${name}" is in the manifest`);
  const raw = await fsp.readFile(join(FIXTURES_DIR, entry.file), 'utf8');
  return /** @type {any[]} */ (parseJsonl(raw));
}

/**
 * Pair subagent_start/subagent_complete events by stepId into
 * [startMs, endMs] windows for one agent name.
 * @param {Array<Record<string, unknown>>} events
 * @param {string} agentName
 * @returns {Array<{ start: number, end: number }>}
 */
function subagentWindows(events, agentName) {
  /** @type {Map<string, { start: number, end: number }>} */
  const byStep = new Map();
  for (const event of events) {
    if (event.agentName !== agentName) continue;
    const stepId = String(event.stepId);
    const ts = Date.parse(String(event.ts));
    if (event.type === 'subagent_start') {
      byStep.set(stepId, { start: ts, end: Number.NaN });
    } else if (event.type === 'subagent_complete') {
      const window = byStep.get(stepId);
      if (window) window.end = ts;
    }
  }
  const windows = [...byStep.values()];
  for (const window of windows) {
    assert.ok(Number.isFinite(window.start) && Number.isFinite(window.end),
      `every ${agentName} start has a matching complete`);
  }
  return windows;
}

/**
 * Count pairs of windows whose time ranges overlap.
 * @param {Array<{ start: number, end: number }>} windows
 * @returns {number}
 */
function overlappingPairs(windows) {
  let pairs = 0;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows.at(i);
      const b = windows.at(j);
      if (a && b && a.start <= b.end && b.start <= a.end) pairs += 1;
    }
  }
  return pairs;
}

for (const name of ['fanout-standard', 'fanout-large']) {
  test(`${name}: >=2 overlapping discovery worker windows, then one discovery_merge`, async () => {
    const events = await loadFixtureEvents(name);

    // (1) Parallelism actually happened: >=2 discovery windows whose
    // timestamps overlap.
    const windows = subagentWindows(events, 'discovery');
    assert.ok(windows.length >= 2, `expected >=2 discovery windows, got ${windows.length}`);
    assert.ok(
      overlappingPairs(windows) >= 1,
      'at least two discovery worker windows must overlap in time',
    );

    // (2) A discovery_merge event follows the fan-out.
    const mergeIdx = events.findIndex((e) => e.type === 'discovery_merge');
    assert.ok(mergeIdx !== -1, 'discovery_merge event present');
    const lastCompleteIdx = events.reduce(
      (acc, e, i) => (e.type === 'subagent_complete' && e.agentName === 'discovery' ? i : acc),
      -1,
    );
    assert.ok(
      mergeIdx > lastCompleteIdx,
      'discovery_merge must follow the last discovery worker completion',
    );
    const merge = /** @type {Record<string, unknown>} */ (events.at(mergeIdx));
    assert.equal(merge.inputs, windows.length, 'merge inputs count the fan-out workers');
  });
}

test('fanout-tiny: exactly one discovery dispatch and no merge event', async () => {
  const events = await loadFixtureEvents('fanout-tiny');
  const starts = events.filter(
    (e) => e.type === 'subagent_start' && e.agentName === 'discovery',
  );
  assert.equal(starts.length, 1, 'tiny dispatches exactly one discovery agent');
  assert.ok(
    !events.some((e) => e.type === 'discovery_merge'),
    'tiny must not emit a discovery_merge event',
  );
});
