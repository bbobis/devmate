// @ts-check

/**
 * FO-8: fan-out observability — the join of a task's trace and the
 * worker-telemetry ledger that the concurrency-ceiling calibration procedure
 * (docs/parallel-dispatch.md, "Calibrating the ceilings") reads.
 *
 * Given a task's trace events and the telemetry ledger entries, summarize the
 * parallelism actually achieved (max overlap depth, wall-clock window vs the
 * serial-equivalent sum of worker durations), the candidate-scan phase, merge
 * quality, and token cost. This is the read-only counterpart to the two
 * provisional concurrency ceilings (`MAX_PARALLEL_WORKSTREAMS`,
 * `maxConcurrentAgents`): the ceilings bound dispatch; this report produces the
 * data that justifies changing them. Pure functions — no I/O.
 */

/** @typedef {import('../types.mjs').FanoutParallelism} FanoutParallelism */
/** @typedef {import('../types.mjs').FanoutScanStrategy} FanoutScanStrategy */
/** @typedef {import('../types.mjs').FanoutMergeQuality} FanoutMergeQuality */
/** @typedef {import('../types.mjs').FanoutCost} FanoutCost */
/** @typedef {import('../types.mjs').FanoutReport} FanoutReport */

/**
 * Speedup at or above which a run with zero contract violations is GREEN.
 * Advisory heuristic mirroring the raise-rule in the calibration procedure.
 * @type {number}
 */
// TODO: calibrate — provisional placeholder (docs/parallel-dispatch.md, "Calibrating the ceilings")
export const SPEEDUP_GREEN_MIN = 1.5;

/**
 * Speedup below which a run that actually fanned out (>= 2 workers) is RED —
 * the fan-out is not paying for its coordination cost. Advisory heuristic
 * mirroring the lower-rule in the calibration procedure.
 * @type {number}
 */
// TODO: calibrate — provisional placeholder (docs/parallel-dispatch.md, "Calibrating the ceilings")
export const SPEEDUP_RED_MAX = 1.2;

/**
 * Dedup rate above which a fanned-out run is RED — the disjoint partitioning
 * is not keeping overlap low. Advisory heuristic mirroring the lower-rule in
 * the calibration procedure.
 * @type {number}
 */
// TODO: calibrate — provisional placeholder (docs/parallel-dispatch.md, "Calibrating the ceilings")
export const DEDUP_RED_MAX = 0.5;

/** Prefix identifying FO-3 candidate-scan strategies in the telemetry ledger. */
const SCAN_WORKER_PREFIX = 'scan-by-';

/** Hard cap on the single-task digest so it never floods a context window. */
const MAX_REPORT_LINES = 20;

/**
 * Parse an ISO-8601 timestamp; null when absent or unparseable.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseTs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when `value` is a finite, non-negative number.
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @typedef {Object} WorkerPair
 * @property {number} startMs
 * @property {number} completeMs
 * @property {number} durationMs
 */

/**
 * Pair `subagent_start`/`subagent_complete` events by stepId, in file order.
 * @param {Array<Record<string, unknown>>} events  Valid object events.
 * @returns {{ pairs: WorkerPair[], unpaired: number, skipped: number }}
 */
function pairSubagentEvents(events) {
  /** @type {Map<string, number[]>} */
  const startsByStep = new Map();
  /** @type {Map<string, Array<{ completeMs: number, durationMs: number }>>} */
  const completesByStep = new Map();
  let skipped = 0;

  for (const ev of events) {
    if (ev.type !== 'subagent_start' && ev.type !== 'subagent_complete') continue;
    const stepId = typeof ev.stepId === 'string' && ev.stepId !== '' ? ev.stepId : null;
    const ms = parseTs(ev.ts);
    if (stepId === null || ms === null) {
      skipped += 1;
      continue;
    }
    if (ev.type === 'subagent_start') {
      const list = startsByStep.get(stepId) ?? [];
      list.push(ms);
      startsByStep.set(stepId, list);
    } else {
      if (!isCount(ev.durationMs)) {
        skipped += 1;
        continue;
      }
      const list = completesByStep.get(stepId) ?? [];
      list.push({ completeMs: ms, durationMs: ev.durationMs });
      completesByStep.set(stepId, list);
    }
  }

  /** @type {WorkerPair[]} */
  const pairs = [];
  let unpaired = 0;
  const stepIds = new Set([...startsByStep.keys(), ...completesByStep.keys()]);
  for (const stepId of stepIds) {
    const starts = startsByStep.get(stepId) ?? [];
    const completes = completesByStep.get(stepId) ?? [];
    const paired = Math.min(starts.length, completes.length);
    unpaired += starts.length + completes.length - 2 * paired;
    for (let i = 0; i < paired; i++) {
      const startMs = starts[i];
      const { completeMs, durationMs } = completes[i];
      if (completeMs < startMs) {
        // Clock skew or a corrupt line — both constituent events are counted
        // as skipped (corrupt data, not crashed workers) and excluded from
        // the parallelism math, never a crash.
        skipped += 2;
        continue;
      }
      pairs.push({ startMs, completeMs, durationMs });
    }
  }

  return { pairs, unpaired, skipped };
}

/**
 * Maximum number of workers running at the same instant. A worker completing
 * at the exact instant another starts does NOT overlap it (the complete
 * boundary is processed first), so interleaved-but-not-overlapping runs
 * report a depth of 1. Depth is clamped at 0 so a zero-width pair (start and
 * complete on the same timestamp) still counts as one running worker at that
 * instant instead of dragging the sweep negative.
 * @param {WorkerPair[]} pairs
 * @returns {number}
 */
export function maxOverlapDepth(pairs) {
  /** @type {Array<{ ms: number, delta: 1|-1 }>} */
  const boundaries = [];
  for (const pair of pairs) {
    boundaries.push({ ms: pair.startMs, delta: 1 });
    boundaries.push({ ms: pair.completeMs, delta: -1 });
  }
  boundaries.sort((a, b) => (a.ms - b.ms) || (a.delta - b.delta));
  let depth = 0;
  let max = 0;
  for (const b of boundaries) {
    depth = Math.max(0, depth + b.delta);
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Compute the parallelism achieved from paired subagent events.
 * @param {WorkerPair[]} pairs
 * @param {number} unpaired
 * @returns {FanoutParallelism}
 */
function summarizeParallelism(pairs, unpaired) {
  if (pairs.length === 0) {
    return {
      workers: 0,
      unpaired,
      maxOverlap: 0,
      windowMs: null,
      serialEquivalentMs: null,
      speedup: null,
    };
  }
  const windowStart = Math.min(...pairs.map((p) => p.startMs));
  const windowEnd = Math.max(...pairs.map((p) => p.completeMs));
  const windowMs = windowEnd - windowStart;
  const serialEquivalentMs = pairs.reduce((sum, p) => sum + p.durationMs, 0);
  return {
    workers: pairs.length,
    unpaired,
    maxOverlap: maxOverlapDepth(pairs),
    windowMs,
    serialEquivalentMs,
    speedup: windowMs > 0 ? serialEquivalentMs / windowMs : null,
  };
}

/**
 * Read the merge quality off the trace's LAST `discovery_merge` event (a
 * steered task can merge more than once; the last merge is the one the lane
 * advanced on). Null when the trace holds none.
 * @param {Array<Record<string, unknown>>} events
 * @returns {FanoutMergeQuality|null}
 */
function summarizeMerge(events) {
  /** @type {Record<string, unknown>|null} */
  let last = null;
  for (const ev of events) {
    if (ev.type === 'discovery_merge') last = ev;
  }
  if (last === null) return null;
  const inputs = isCount(last.inputs) ? last.inputs : 0;
  const merged = isCount(last.merged) ? last.merged : 0;
  const dropped = isCount(last.dropped) ? last.dropped : 0;
  const conflicts = isCount(last.conflicts) ? last.conflicts : 0;
  // The issue-specified formula, computed only when the two counts are
  // comparable — see the FanoutMergeQuality typedef for the artifact-vs-claim
  // instrumentation caveat.
  const dedupRate = inputs > 0 && merged <= inputs ? (inputs - merged) / inputs : null;
  return { inputs, merged, dropped, conflicts, dedupRate };
}

/**
 * @typedef {Object} UsableTelemetryEntry
 * @property {string}  workerId
 * @property {number}  timestampMs
 * @property {number}  promptTokens
 * @property {number}  completionTokens
 * @property {number}  latencyMs
 * @property {boolean} contractValid
 */

/**
 * Filter telemetry entries down to usable, in-window records. The ledger is
 * repo-global and its entries carry no taskId, so the task's trace time range
 * is the join key: only entries recorded inside [windowStart, windowEnd] are
 * attributed to this task. With no window (an empty or timestamp-less trace)
 * no entry is attributed — cross-task pollution would be worse than a gap.
 * @param {unknown[]} entries
 * @param {{ start: number, end: number }|null} window
 * @returns {{ usable: UsableTelemetryEntry[], skipped: number, outOfWindow: number }}
 */
function filterTelemetry(entries, window) {
  /** @type {UsableTelemetryEntry[]} */
  const usable = [];
  let skipped = 0;
  let outOfWindow = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    const timestampMs = parseTs(record.timestamp);
    if (
      typeof record.workerId !== 'string' ||
      record.workerId === '' ||
      timestampMs === null ||
      !isCount(record.promptTokens) ||
      !isCount(record.completionTokens) ||
      !isCount(record.latencyMs) ||
      typeof record.contractValid !== 'boolean'
    ) {
      skipped += 1;
      continue;
    }
    if (window === null || timestampMs < window.start || timestampMs > window.end) {
      outOfWindow += 1;
      continue;
    }
    usable.push({
      workerId: record.workerId,
      timestampMs,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      latencyMs: record.latencyMs,
      contractValid: record.contractValid,
    });
  }
  return { usable, skipped, outOfWindow };
}

/**
 * Aggregate the FO-3 scan strategies (`scan-by-*` workerIds) per strategy.
 * @param {UsableTelemetryEntry[]} entries
 * @returns {FanoutScanStrategy[]}
 */
function summarizeScan(entries) {
  /** @type {Map<string, { runs: number, latencyTotal: number, violations: number }>} */
  const byStrategy = new Map();
  for (const entry of entries) {
    if (!entry.workerId.startsWith(SCAN_WORKER_PREFIX)) continue;
    const agg = byStrategy.get(entry.workerId) ?? { runs: 0, latencyTotal: 0, violations: 0 };
    agg.runs += 1;
    agg.latencyTotal += entry.latencyMs;
    if (!entry.contractValid) agg.violations += 1;
    byStrategy.set(entry.workerId, agg);
  }
  return [...byStrategy.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([workerId, agg]) => ({
      workerId,
      runs: agg.runs,
      meanLatencyMs: agg.latencyTotal / agg.runs,
      violations: agg.violations,
      violationRate: agg.violations / agg.runs,
    }));
}

/**
 * Total token cost per worker and per task.
 * @param {UsableTelemetryEntry[]} entries
 * @returns {FanoutCost}
 */
function summarizeCost(entries) {
  /** @type {Map<string, number>} */
  const completionByWorker = new Map();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  for (const entry of entries) {
    totalPromptTokens += entry.promptTokens;
    totalCompletionTokens += entry.completionTokens;
    completionByWorker.set(
      entry.workerId,
      (completionByWorker.get(entry.workerId) ?? 0) + entry.completionTokens,
    );
  }
  const perWorker = [...completionByWorker.entries()]
    .map(([workerId, completionTokens]) => ({ workerId, completionTokens }))
    .sort((a, b) => b.completionTokens - a.completionTokens || (a.workerId < b.workerId ? -1 : 1));
  return { totalPromptTokens, totalCompletionTokens, perWorker };
}

/**
 * Render a number as a fixed-precision string, or the given fallback for null.
 * @param {number|null} value
 * @param {number} digits
 * @param {string} suffix
 * @returns {string}
 */
function fmtOrNa(value, digits, suffix) {
  return value === null ? 'n/a' : `${value.toFixed(digits)}${suffix}`;
}

/**
 * Render a rate in [0,1] as a whole percent, or 'n/a' for null.
 * @param {number|null} rate
 * @returns {string}
 */
function fmtPercent(rate) {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

/**
 * Build the per-task fan-out report — the pure aggregation behind
 * `scripts/fanout-report.mjs`.
 *
 * Verdict thresholds (ADVISORY heuristics, not gates — the report always
 * reports, never fails a run):
 *   - GREEN:  speedup >= {@link SPEEDUP_GREEN_MIN} and zero telemetry
 *             contract violations in the task window.
 *   - RED:    the run actually fanned out (>= 2 paired workers) yet
 *             speedup < {@link SPEEDUP_RED_MAX}, or its dedup rate exceeds
 *             {@link DEDUP_RED_MAX} — fan-out is not paying for itself.
 *   - YELLOW: everything else, including a trace with no fan-out to measure.
 *
 * @param {{ traceEvents: unknown, telemetryEntries?: unknown }} input
 * @returns {FanoutReport}
 */
export function buildFanoutReport(input) {
  const traceEvents = Array.isArray(input.traceEvents) ? input.traceEvents : [];
  const telemetryEntries = Array.isArray(input.telemetryEntries) ? input.telemetryEntries : [];

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  let skipped = 0;
  for (const ev of traceEvents) {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      skipped += 1;
      continue;
    }
    events.push(/** @type {Record<string, unknown>} */ (ev));
  }

  // The task's overall time range (ALL events, not just subagent ones) is the
  // join key onto the task-agnostic telemetry ledger.
  /** @type {{ start: number, end: number }|null} */
  let window = null;
  for (const ev of events) {
    const ms = parseTs(ev.ts);
    if (ms === null) continue;
    if (window === null) window = { start: ms, end: ms };
    else {
      if (ms < window.start) window.start = ms;
      if (ms > window.end) window.end = ms;
    }
  }

  const { pairs, unpaired, skipped: pairSkipped } = pairSubagentEvents(events);
  skipped += pairSkipped;
  const parallelism = summarizeParallelism(pairs, unpaired);
  const merge = summarizeMerge(events);

  const { usable, skipped: telemetrySkipped, outOfWindow } = filterTelemetry(
    telemetryEntries,
    window,
  );
  skipped += telemetrySkipped;
  const scan = summarizeScan(usable);
  const cost = summarizeCost(usable);
  const violations = usable.filter((entry) => !entry.contractValid).length;

  /** @type {string[]} */
  const notes = [];
  if (parallelism.workers === 0) {
    notes.push('No completed subagent fan-out recorded in this trace — nothing to measure yet.');
  } else if (parallelism.workers === 1) {
    notes.push('Single paired worker — no fan-out to measure; speedup ~1.0x is expected.');
  }
  if (unpaired > 0) {
    notes.push(
      `${unpaired} subagent event(s) had no matching start/complete counterpart and were excluded from the parallelism math.`,
    );
  }
  if (merge !== null && merge.dedupRate === null) {
    notes.push(
      'Dedup rate unavailable: the discovery_merge event records worker-artifact and claim counts, which are not comparable — recording input-claim counts on the event is the instrumentation gap.',
    );
  }
  // eslint-disable-next-line secure-coding/no-insecure-comparison -- 'totalPromptTokens' is a telemetry token COUNT compared to zero, not a credential; the rule keyword-matches the name.
  if (usable.length > 0 && cost.totalPromptTokens === 0) {
    notes.push(
      'Prompt tokens total 0 — fanout records promptTokens as 0 today (a recorded gap, not a free run).',
    );
  }
  if (usable.length === 0 && outOfWindow > 0) {
    notes.push(
      `None of the ${outOfWindow} usable telemetry entries fall inside this task's trace window — the ledger carries no task ids, so out-of-window entries are never attributed.`,
    );
  }

  /** @type {'green'|'yellow'|'red'} */
  let verdict = 'yellow';
  const { speedup } = parallelism;
  const dedupRate = merge === null ? null : merge.dedupRate;
  if (speedup !== null && speedup >= SPEEDUP_GREEN_MIN && violations === 0) {
    verdict = 'green';
  } else if (
    parallelism.workers >= 2 &&
    ((speedup !== null && speedup < SPEEDUP_RED_MAX) ||
      (dedupRate !== null && dedupRate > DEDUP_RED_MAX))
  ) {
    verdict = 'red';
  }

  const verdictLine =
    `K=${parallelism.workers} / overlap=${parallelism.maxOverlap} / ` +
    `speedup=${fmtOrNa(speedup, 2, 'x')} / dedup=${fmtPercent(dedupRate)} / ` +
    `violations=${violations}`;

  return {
    verdict,
    verdictLine,
    parallelism,
    scan,
    merge,
    cost,
    violations,
    skipped,
    notes,
  };
}

/**
 * Render a {@link FanoutReport} as a compact human-readable digest, capped at
 * {@link MAX_REPORT_LINES} lines (overflow is truncated with a visible count,
 * never silently).
 * @param {FanoutReport} report
 * @param {string} [taskId]
 * @returns {string}
 */
export function formatFanoutReport(report, taskId) {
  /** @type {string[]} */
  const lines = [];
  const suffix = taskId ? ` (task ${taskId})` : '';
  lines.push(`Fan-out report — ${report.verdict.toUpperCase()}${suffix}`);
  lines.push(`  ${report.verdictLine}`);
  const p = report.parallelism;
  lines.push(
    `  parallelism: window ${fmtOrNa(p.windowMs === null ? null : p.windowMs / 1000, 1, 's')}, ` +
      `serial-equivalent ${fmtOrNa(p.serialEquivalentMs === null ? null : p.serialEquivalentMs / 1000, 1, 's')}, ` +
      `${p.workers} paired worker(s), ${p.unpaired} unpaired`,
  );
  for (const strategy of report.scan.slice(0, 5)) {
    lines.push(
      `  scan: ${strategy.workerId} — ${strategy.runs} run(s), ` +
        `mean ${strategy.meanLatencyMs.toFixed(0)}ms, violations ${fmtPercent(strategy.violationRate)}`,
    );
  }
  if (report.scan.length > 5) lines.push(`  scan: … ${report.scan.length - 5} more strategies`);
  if (report.merge !== null) {
    const m = report.merge;
    lines.push(
      `  merge: ${m.inputs} artifact(s) in — ${m.merged} claim(s) kept, ` +
        `${m.dropped} dropped by cap, ${m.conflicts} conflict(s), dedup ${fmtPercent(m.dedupRate)}`,
    );
  }
  lines.push(
    `  cost: ${report.cost.totalCompletionTokens} completion token(s) across ` +
      `${report.cost.perWorker.length} worker(s), ${report.cost.totalPromptTokens} prompt token(s)`,
  );
  if (report.skipped > 0) lines.push(`  skipped ${report.skipped} unusable record(s)`);
  for (const note of report.notes) lines.push(`  • ${note}`);

  if (lines.length > MAX_REPORT_LINES) {
    const kept = lines.slice(0, MAX_REPORT_LINES - 1);
    kept.push(`  … ${lines.length - (MAX_REPORT_LINES - 1)} more line(s) truncated`);
    return kept.join('\n');
  }
  return lines.join('\n');
}

/**
 * Render a fleet-wide fan-out dashboard: a verdict tally plus one line per
 * task (mirrors the delegation dashboard's shape).
 * @param {Array<{ taskId: string, report: FanoutReport }>} entries
 * @returns {string}
 */
export function formatFanoutDashboard(entries) {
  const green = entries.filter((e) => e.report.verdict === 'green').length;
  const yellow = entries.filter((e) => e.report.verdict === 'yellow').length;
  const red = entries.filter((e) => e.report.verdict === 'red').length;
  /** @type {string[]} */
  const lines = [
    `Fan-out dashboard — ${entries.length} task(s): ${green} green, ${yellow} yellow, ${red} red`,
  ];
  if (entries.length === 0) {
    lines.push('  (no task traces found)');
    return lines.join('\n');
  }
  for (const { taskId, report } of entries) {
    lines.push(`  ${report.verdict.toUpperCase().padEnd(6)} ${taskId} — ${report.verdictLine}`);
  }
  return lines.join('\n');
}
