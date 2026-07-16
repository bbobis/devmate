// @ts-check

/**
 * Delegation observability.
 *
 * Given a task's trace events, summarize how much work the orchestrator
 * *delegated* to subagents versus likely did *inline*. This is the read-only
 * counterpart to the dispatch floor: the floor blocks inline analysis at a
 * gate; this report makes the delegation behaviour of a whole run visible, so
 * "the orchestrator isn't delegating" is an observation anyone can confirm from
 * the trace rather than a hunch. Pure functions — no I/O.
 */

import { GATE_DISPATCH_FLOOR } from '../workflow/orchestrator.mjs';
import { getOwn } from '../object-utils.mjs';

/**
 * The read-heavy analysis specialists — the union of every agent the dispatch
 * floor can require. These are the roles whose work, done inline, fills the
 * orchestrator's own context window.
 * @type {string[]}
 */
export const ANALYSIS_SPECIALISTS = [
  ...new Set(Object.values(GATE_DISPATCH_FLOOR).flat()),
];

/**
 * The analysis specialists each lane is expected to delegate to. A chore has no
 * analysis phase (it goes straight to an `editor` implementation dispatch), so
 * its expected set is empty — reporting "missing discovery/grill" for a chore
 * would be a false alarm. When the lane is unknown the generic superset
 * ({@link ANALYSIS_SPECIALISTS}) is used.
 * @type {Record<string, string[]>}
 */
export const LANE_ANALYSIS = {
  feature: ['discovery', 'tech-design', 'rubber-duck', 'planner'],
  bug: ['diagnose', 'rubber-duck'],
  chore: [],
};

/**
 * Persisted workflow gates that only exist once the pre-spec analysis phase is
 * behind us. Reaching one of these with zero dispatches is the tell-tale sign
 * of an all-inline run.
 * @type {string[]}
 */
const POST_ANALYSIS_GATES = [
  'spec-draft',
  'spec-approved',
  'impl-started',
  'verification-passed',
  'pr-ready',
  'done',
];

/**
 * Normalize a dispatched-agent name: strip a leading '@', a trailing '.agent',
 * lowercase, trim. Unlike the floor's matcher this does NOT canonicalize
 * personas — a per-persona breakdown is more informative in a report.
 * @param {unknown} name
 * @returns {string}
 */
function normalizeAgentName(name) {
  if (typeof name !== 'string') return '';
  let normalized = name.trim().toLowerCase();
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized.endsWith('.agent')) normalized = normalized.slice(0, -'.agent'.length);
  return normalized.trim();
}

/**
 * The analysis specialists expected for a lane; the generic superset when the
 * lane is unknown or unrecognised.
 * @param {string|undefined} lane
 * @returns {string[]}
 */
function expectedAnalysisFor(lane) {
  if (typeof lane !== 'string') return ANALYSIS_SPECIALISTS;
  const laneExpected = getOwn(LANE_ANALYSIS, lane);
  return Array.isArray(laneExpected) ? laneExpected : ANALYSIS_SPECIALISTS;
}

/**
 * @typedef {Object} DelegationSummary
 * @property {'green'|'yellow'|'red'} verdict
 * @property {string|null} lane                 The lane the run was scored against, or null.
 * @property {number} totalDispatches
 * @property {Record<string, number>} byAgent   Dispatch count per specialist, most first.
 * @property {string[]} analysisRan             Expected analysis specialists that were dispatched.
 * @property {string[]} analysisMissing         Expected analysis specialists never dispatched.
 * @property {string[]} gatesReached            Distinct gates seen in gate_transition events.
 * @property {string[]} floorViolations         Missing groups recorded by warn-mode delegation-floor violations.
 * @property {string[]} notes                   Human-readable interpretation.
 */

/**
 * Summarize the delegation behaviour recorded in a task's trace events.
 * @param {unknown} traceEvents
 * @param {{ lane?: string }} [opts]  When `lane` is given, expected-analysis is
 *        scored per lane (a chore is not penalised for skipping discovery/grill).
 * @returns {DelegationSummary}
 */
export function summarizeDelegation(traceEvents, opts = {}) {
  const lane = typeof opts.lane === 'string' && opts.lane.trim() !== '' ? opts.lane.trim() : undefined;
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Set<string>} */
  const gatesReached = new Set();
  /** @type {Set<string>} */
  const floorViolations = new Set();
  let totalDispatches = 0;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (event);
    if (record.type === 'subagent_start') {
      const name = normalizeAgentName(record.agentName);
      if (name !== '') {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        totalDispatches += 1;
      }
    } else if (record.type === 'gate_transition' && typeof record.to === 'string') {
      gatesReached.add(record.to);
    } else if (record.type === 'contract_violation' && record.contract === 'delegation-floor') {
      const errs = record.errors;
      if (Array.isArray(errs)) {
        for (const e of errs) if (typeof e === 'string' && e !== '') floorViolations.add(e);
      }
    }
  }

  const ran = new Set(counts.keys());
  const expected = expectedAnalysisFor(lane);
  const analysisRan = expected.filter((a) => ran.has(a));
  const analysisMissing = expected.filter((a) => !ran.has(a));
  const reachedBeyondAnalysis = [...gatesReached].some((g) => POST_ANALYSIS_GATES.includes(g));
  const laneLabel = lane ? `${lane} lane` : 'run';

  /** @type {string[]} */
  const notes = [];
  /** @type {'green'|'yellow'|'red'} */
  let verdict;
  if (totalDispatches === 0 && reachedBeyondAnalysis) {
    verdict = 'red';
    notes.push(
      `This ${laneLabel} reached implementation/spec but recorded no subagent dispatch — work was almost certainly done inline (the context-degradation failure this guards against).`,
    );
  } else if (totalDispatches === 0) {
    verdict = 'yellow';
    notes.push('No subagent dispatch recorded yet — the task is pre-dispatch, or work is being done inline.');
  } else if (expected.length > 0 && analysisRan.length === 0) {
    verdict = 'yellow';
    notes.push(
      `Subagents ran, but none of the expected analysis specialists for the ${laneLabel} (${expected.join(', ')}) — confirm that analysis was not done inline.`,
    );
  } else {
    verdict = 'green';
    notes.push(
      expected.length === 0
        ? `${laneLabel}: no analysis phase expected; ${totalDispatches} dispatch(es) recorded.`
        : `Read-heavy analysis was delegated to: ${analysisRan.join(', ')}.`,
    );
  }

  const floors = [...floorViolations];
  if (floors.length > 0) {
    // The floor fired at least once in warn mode: analysis was incomplete when
    // implementation started, so a would-be-green run is downgraded.
    if (verdict === 'green') verdict = 'yellow';
    notes.push(`Delegation floor fired (warn mode) — missing ${floors.join(', ')}.`);
  }

  return {
    verdict,
    lane: lane ?? null,
    totalDispatches,
    byAgent: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    analysisRan,
    analysisMissing,
    gatesReached: [...gatesReached],
    floorViolations: floors,
    notes,
  };
}

/**
 * Render a {@link DelegationSummary} as a compact human-readable report.
 * @param {DelegationSummary} summary
 * @returns {string}
 */
export function formatDelegationReport(summary) {
  /** @type {string[]} */
  const lines = [];
  const laneSuffix = summary.lane ? ` (${summary.lane} lane)` : '';
  lines.push(`Delegation report — ${summary.verdict.toUpperCase()}${laneSuffix}`);
  lines.push(`  dispatches: ${summary.totalDispatches}`);
  const agents = Object.entries(summary.byAgent);
  lines.push(
    `  specialists: ${agents.length ? agents.map(([a, n]) => `${a}×${n}`).join(', ') : '(none)'}`,
  );
  lines.push(
    `  analysis delegated: ${summary.analysisRan.length ? summary.analysisRan.join(', ') : '(none)'}`,
  );
  if (summary.analysisMissing.length > 0) {
    lines.push(`  analysis not seen: ${summary.analysisMissing.join(', ')}`);
  }
  lines.push(
    `  gates reached: ${summary.gatesReached.length ? summary.gatesReached.join(', ') : '(none)'}`,
  );
  if (summary.floorViolations && summary.floorViolations.length > 0) {
    lines.push(`  floor violations (warn): ${summary.floorViolations.join(', ')}`);
  }
  for (const note of summary.notes) lines.push(`  • ${note}`);
  return lines.join('\n');
}

/**
 * Render a fleet-wide delegation dashboard: a tally plus one line per task.
 * @param {Array<{ taskId: string, summary: DelegationSummary }>} entries
 * @returns {string}
 */
export function formatDelegationDashboard(entries) {
  const green = entries.filter((e) => e.summary.verdict === 'green').length;
  const yellow = entries.filter((e) => e.summary.verdict === 'yellow').length;
  const red = entries.filter((e) => e.summary.verdict === 'red').length;
  /** @type {string[]} */
  const lines = [
    `Delegation dashboard — ${entries.length} task(s): ${green} green, ${yellow} yellow, ${red} red`,
  ];
  if (entries.length === 0) {
    lines.push('  (no task traces found)');
    return lines.join('\n');
  }
  for (const { taskId, summary } of entries) {
    lines.push(`  ${summary.verdict.toUpperCase().padEnd(6)} ${taskId} — ${summary.totalDispatches} dispatch(es)`);
  }
  return lines.join('\n');
}
