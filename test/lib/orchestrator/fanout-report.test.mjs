// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFanoutReport,
  formatFanoutDashboard,
  formatFanoutReport,
  maxOverlapDepth,
  SPEEDUP_GREEN_MIN,
  SPEEDUP_RED_MAX,
} from '../../../lib/orchestrator/fanout-report.mjs';

/**
 * Build a subagent_start trace event.
 * @param {string} stepId
 * @param {string} ts
 * @param {number} activeCount
 * @returns {Record<string, unknown>}
 */
function start(stepId, ts, activeCount = 1) {
  return {
    type: 'subagent_start',
    stepId,
    taskId: 't1',
    ts,
    schemaVersion: 1,
    agentName: 'discovery',
    persona: 'unknown',
    activeCount,
  };
}

/**
 * Build a subagent_complete trace event.
 * @param {string} stepId
 * @param {string} ts
 * @param {number} durationMs
 * @returns {Record<string, unknown>}
 */
function complete(stepId, ts, durationMs) {
  return {
    type: 'subagent_complete',
    stepId,
    taskId: 't1',
    ts,
    schemaVersion: 1,
    agentName: 'discovery',
    persona: 'unknown',
    durationMs,
    activeCount: 0,
  };
}

/**
 * Build a discovery_merge trace event.
 * @param {string} ts
 * @param {{ inputs: number, merged: number, dropped: number, conflicts: number }} counts
 * @returns {Record<string, unknown>}
 */
function mergeEvent(ts, counts) {
  return {
    type: 'discovery_merge',
    stepId: 'merge-discovery',
    taskId: 't1',
    ts,
    schemaVersion: 1,
    ...counts,
  };
}

/**
 * Build a gate_transition trace event (window anchor).
 * @param {string} ts
 * @returns {Record<string, unknown>}
 */
function gate(ts) {
  return {
    type: 'gate_transition',
    stepId: 'gatectl',
    taskId: 't1',
    ts,
    schemaVersion: 1,
    from: 'no-lane',
    to: 'lane-set',
    gate: 'lane-set',
  };
}

/**
 * Build a worker-telemetry ledger entry.
 * @param {string} workerId
 * @param {string} timestamp
 * @param {{ promptTokens?: number, completionTokens?: number, latencyMs?: number, contractValid?: boolean }} [overrides]
 * @returns {Record<string, unknown>}
 */
function telemetry(workerId, timestamp, overrides = {}) {
  return {
    timestamp,
    workerId,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 100,
    contractValid: true,
    ...overrides,
  };
}

/** The FO-5-style standard fan-out trace: 3 overlapping workers + a merge. */
const STANDARD_TRACE = [
  gate('2026-07-01T00:00:00.000Z'),
  start('w1', '2026-07-01T00:02:00.000Z', 1),
  start('w2', '2026-07-01T00:02:05.000Z', 2),
  start('w3', '2026-07-01T00:02:10.000Z', 3),
  complete('w1', '2026-07-01T00:04:00.000Z', 120000),
  complete('w2', '2026-07-01T00:04:30.000Z', 145000),
  complete('w3', '2026-07-01T00:05:00.000Z', 170000),
  mergeEvent('2026-07-01T00:05:30.000Z', { inputs: 2, merged: 8, dropped: 1, conflicts: 1 }),
  gate('2026-07-01T00:06:00.000Z'),
];

test('fanout-report › overlap, window, serial-equivalent, and speedup match hand-computed values', () => {
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: [] });
  assert.equal(report.parallelism.workers, 3);
  assert.equal(report.parallelism.unpaired, 0);
  assert.equal(report.parallelism.maxOverlap, 3);
  // 00:02:00 → 00:05:00
  assert.equal(report.parallelism.windowMs, 180000);
  // 120000 + 145000 + 170000
  assert.equal(report.parallelism.serialEquivalentMs, 435000);
  assert.equal(report.parallelism.speedup, 435000 / 180000);
});

test('fanout-report › verdict is green at speedup >= threshold with zero violations', () => {
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: [] });
  assert.ok(/** @type {number} */ (report.parallelism.speedup) >= SPEEDUP_GREEN_MIN);
  assert.equal(report.violations, 0);
  assert.equal(report.verdict, 'green');
  assert.equal(
    report.verdictLine,
    'K=3 / overlap=3 / speedup=2.42x / dedup=n/a / violations=0',
  );
});

test('fanout-report › K=1 single worker: overlap 1, speedup 1, yellow with a no-fan-out note', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('only', '2026-07-01T00:00:10.000Z'),
      complete('only', '2026-07-01T00:00:40.000Z', 30000),
    ],
    telemetryEntries: [],
  });
  assert.equal(report.parallelism.workers, 1);
  assert.equal(report.parallelism.maxOverlap, 1);
  assert.equal(report.parallelism.windowMs, 30000);
  assert.equal(report.parallelism.serialEquivalentMs, 30000);
  assert.equal(report.parallelism.speedup, 1);
  assert.equal(report.verdict, 'yellow', 'a single worker is never RED — there was no fan-out');
  assert.ok(report.notes.some((n) => n.includes('Single paired worker')));
});

test('fanout-report › interleaved-but-not-overlapping workers report overlap 1 and go red', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('a', '2026-07-01T00:00:00.000Z'),
      complete('a', '2026-07-01T00:01:00.000Z', 60000),
      // b starts at the exact instant a completes — NOT an overlap.
      start('b', '2026-07-01T00:01:00.000Z'),
      complete('b', '2026-07-01T00:02:00.000Z', 60000),
    ],
    telemetryEntries: [],
  });
  assert.equal(report.parallelism.maxOverlap, 1);
  assert.equal(report.parallelism.speedup, 1);
  assert.ok(/** @type {number} */ (report.parallelism.speedup) < SPEEDUP_RED_MAX);
  assert.equal(report.verdict, 'red', 'two workers that ran serially is fan-out not paying off');
});

test('fanout-report › unpaired events are counted and excluded from the math', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('crashed', '2026-07-01T00:00:00.000Z'),
      start('ok', '2026-07-01T00:00:05.000Z'),
      complete('ok', '2026-07-01T00:00:35.000Z', 30000),
    ],
    telemetryEntries: [],
  });
  assert.equal(report.parallelism.workers, 1);
  assert.equal(report.parallelism.unpaired, 1);
  // Window spans only the paired worker: 00:00:05 → 00:00:35.
  assert.equal(report.parallelism.windowMs, 30000);
  assert.ok(report.notes.some((n) => n.includes('no matching start/complete counterpart')));
});

test('fanout-report › dedup rate follows the issue formula when counts are comparable', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('a', '2026-07-01T00:00:00.000Z'),
      complete('a', '2026-07-01T00:01:40.000Z', 100000),
      start('b', '2026-07-01T00:00:00.000Z'),
      complete('b', '2026-07-01T00:00:30.000Z', 30000),
      mergeEvent('2026-07-01T00:02:00.000Z', { inputs: 8, merged: 6, dropped: 1, conflicts: 0 }),
    ],
    telemetryEntries: [],
  });
  assert.ok(report.merge, 'expected a merge summary');
  assert.equal(report.merge.dedupRate, (8 - 6) / 8);
  assert.match(report.verdictLine, /dedup=25%/);
});

test('fanout-report › dedup rate is null (a noted gap) when merged claims exceed input artifacts', () => {
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: [] });
  assert.ok(report.merge, 'expected a merge summary');
  assert.equal(report.merge.inputs, 2);
  assert.equal(report.merge.merged, 8);
  assert.equal(report.merge.dropped, 1);
  assert.equal(report.merge.conflicts, 1);
  assert.equal(report.merge.dedupRate, null);
  assert.ok(report.notes.some((n) => n.includes('Dedup rate unavailable')));
});

test('fanout-report › dedup rate above the red ceiling downgrades a fanned-out run to red', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('a', '2026-07-01T00:00:00.000Z'),
      complete('a', '2026-07-01T00:01:40.000Z', 100000),
      start('b', '2026-07-01T00:00:00.000Z'),
      complete('b', '2026-07-01T00:00:30.000Z', 30000),
      mergeEvent('2026-07-01T00:02:00.000Z', { inputs: 10, merged: 4, dropped: 0, conflicts: 0 }),
    ],
    telemetryEntries: [],
  });
  // speedup 1.3 is in the yellow band; dedup 0.6 forces red.
  assert.equal(report.parallelism.speedup, 1.3);
  assert.ok(report.merge);
  assert.equal(report.merge.dedupRate, 0.6);
  assert.equal(report.verdict, 'red');
});

test('fanout-report › telemetry joins by trace window; scan strategies aggregate per workerId', () => {
  const entries = [
    telemetry('scan-by-name', '2026-07-01T00:00:30.000Z', { latencyMs: 800, completionTokens: 40 }),
    telemetry('scan-by-content', '2026-07-01T00:00:31.000Z', { latencyMs: 1200, completionTokens: 60 }),
    telemetry('discovery-w1', '2026-07-01T00:04:00.000Z', { latencyMs: 120000, completionTokens: 2000 }),
    // One second before the trace window opens — never attributed.
    telemetry('scan-by-name', '2026-06-30T23:59:59.000Z', { latencyMs: 9999 }),
    'not an object',
  ];
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: entries });

  assert.deepEqual(
    report.scan,
    [
      { workerId: 'scan-by-content', runs: 1, meanLatencyMs: 1200, violations: 0, violationRate: 0 },
      { workerId: 'scan-by-name', runs: 1, meanLatencyMs: 800, violations: 0, violationRate: 0 },
    ],
    'sorted by workerId; the out-of-window run is excluded',
  );
  assert.equal(report.cost.totalCompletionTokens, 2100);
  assert.equal(report.cost.totalPromptTokens, 0);
  assert.deepEqual(report.cost.perWorker[0], { workerId: 'discovery-w1', completionTokens: 2000 });
  assert.equal(report.skipped, 1, 'the non-object telemetry entry is skipped, never a crash');
  assert.ok(report.notes.some((n) => n.includes('Prompt tokens total 0')));
});

test('fanout-report › a telemetry contract violation in the window blocks green', () => {
  const entries = [
    telemetry('scan-by-imports', '2026-07-01T00:00:30.000Z', { contractValid: false }),
  ];
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: entries });
  assert.equal(report.violations, 1);
  assert.equal(report.scan[0].violationRate, 1);
  assert.equal(report.verdict, 'yellow', 'speedup is green-range but the violation blocks green');
});

test('fanout-report › garbage inputs produce an empty yellow report, never a crash', () => {
  const fromGarbage = buildFanoutReport({ traceEvents: 'nope', telemetryEntries: 42 });
  assert.equal(fromGarbage.parallelism.workers, 0);
  assert.equal(fromGarbage.parallelism.speedup, null);
  assert.equal(fromGarbage.merge, null);
  assert.equal(fromGarbage.verdict, 'yellow');

  const fromJunkRows = buildFanoutReport({
    traceEvents: [null, 42, 'x', { type: 'subagent_start', stepId: 'w', ts: 'not-a-date' }],
    telemetryEntries: [],
  });
  assert.equal(fromJunkRows.skipped, 4);
  assert.equal(fromJunkRows.parallelism.workers, 0);
});

test('fanout-report › a zero-width window yields a null speedup but still one running worker', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('w', '2026-07-01T00:00:00.000Z'),
      complete('w', '2026-07-01T00:00:00.000Z', 0),
    ],
    telemetryEntries: [],
  });
  assert.equal(report.parallelism.windowMs, 0);
  assert.equal(report.parallelism.speedup, null);
  assert.equal(report.parallelism.maxOverlap, 1, 'K=1 must never report overlap 0');
  assert.equal(report.verdict, 'yellow');
});

test('fanout-report › a reversed-timestamp pair counts both events as skipped, not paired', () => {
  const report = buildFanoutReport({
    traceEvents: [
      start('w', '2026-07-01T00:01:00.000Z'),
      // Completes BEFORE it started — corrupt data, excluded from the math.
      complete('w', '2026-07-01T00:00:00.000Z', 60000),
    ],
    telemetryEntries: [],
  });
  assert.equal(report.parallelism.workers, 0);
  assert.equal(report.parallelism.unpaired, 0);
  assert.equal(report.skipped, 2, 'both constituent events are visibly accounted for');
});

test('fanout-report › maxOverlapDepth ties resolve complete-before-start', () => {
  assert.equal(
    maxOverlapDepth([
      { startMs: 0, completeMs: 10, durationMs: 10 },
      { startMs: 10, completeMs: 20, durationMs: 10 },
    ]),
    1,
  );
  assert.equal(
    maxOverlapDepth([
      { startMs: 0, completeMs: 10, durationMs: 10 },
      { startMs: 9, completeMs: 20, durationMs: 11 },
      { startMs: 9, completeMs: 12, durationMs: 3 },
    ]),
    3,
  );
  assert.equal(maxOverlapDepth([]), 0);
  // A zero-width pair is one worker running at that instant, never depth 0.
  assert.equal(maxOverlapDepth([{ startMs: 5, completeMs: 5, durationMs: 0 }]), 1);
});

test('fanout-report › formatFanoutReport stays within the 20-line digest cap', () => {
  const entries = [
    telemetry('scan-by-name', '2026-07-01T00:00:30.000Z'),
    telemetry('scan-by-content', '2026-07-01T00:00:31.000Z'),
    telemetry('scan-by-imports', '2026-07-01T00:00:32.000Z'),
    telemetry('scan-by-test-mirror', '2026-07-01T00:00:33.000Z'),
    telemetry('discovery-w1', '2026-07-01T00:04:00.000Z', { completionTokens: 500 }),
  ];
  const report = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: entries });
  const text = formatFanoutReport(report, 'task-abc');
  const lines = text.split('\n');
  assert.ok(lines.length <= 20, `expected <= 20 lines, got ${lines.length}`);
  assert.match(lines[0], /^Fan-out report — GREEN \(task task-abc\)$/);
  assert.match(text, /K=3 \/ overlap=3/);
  assert.match(text, /merge: 2 artifact\(s\) in/);
  assert.match(text, /scan: scan-by-content/);
});

test('fanout-report › formatFanoutDashboard tallies verdicts with one line per task', () => {
  const green = buildFanoutReport({ traceEvents: STANDARD_TRACE, telemetryEntries: [] });
  const yellow = buildFanoutReport({ traceEvents: [], telemetryEntries: [] });
  const text = formatFanoutDashboard([
    { taskId: 'feat-a', report: green },
    { taskId: 'feat-b', report: yellow },
  ]);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Fan-out dashboard — 2 task(s): 1 green, 1 yellow, 0 red');
  assert.match(lines[1], /^ {2}GREEN {2}feat-a — K=3/);
  assert.match(lines[2], /^ {2}YELLOW feat-b — K=0/);

  assert.match(formatFanoutDashboard([]), /no task traces found/);
});
