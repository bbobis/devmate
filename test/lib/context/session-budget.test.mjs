// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRACE_DIAGNOSTIC_TOKENS,
  checkBudget,
  checkTraceSize,
  formatTraceDiagnostic,
  formatWarning,
  measureSession,
  reportId,
  resetContextBudget,
} from '../../../lib/context/session-budget.mjs';
import { readContextMeter, recordToolResult } from '../../../lib/context/context-meter.mjs';

/**
 * Create a temp dir with a task.json plus optional component files.
 * @param {{
 *   sessionBytes?: number,
 *   traceBytes?: number,
 *   toolBytes?: number,
 *   loadedSkills?: string[],
 *   omitState?: boolean,
 * }} [opts]
 * @returns {Promise<{ taskStatePath: string, dir: string, sessionPath: string }>}
 */
async function mkSession(opts = {}) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'session-budget-'));
  const sessionPath = join(dir, 'session.md');
  const traceFile = join(dir, 'trace.jsonl');
  const toolPath = join(dir, 'tool.txt');

  if (opts.sessionBytes) await fsp.writeFile(sessionPath, 'x'.repeat(opts.sessionBytes));
  if (opts.traceBytes) await fsp.writeFile(traceFile, 'y'.repeat(opts.traceBytes));
  if (opts.toolBytes) await fsp.writeFile(toolPath, 'z'.repeat(opts.toolBytes));

  const taskStatePath = join(dir, 'task.json');
  if (!opts.omitState) {
    const state = {
      sessionPath,
      traceFile,
      lastToolOutputPath: toolPath,
      loadedSkills: opts.loadedSkills ?? [],
    };
    await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  }
  return { taskStatePath, dir, sessionPath };
}

/**
 * Build a snapshot directly for pure checkBudget tests.
 * @param {number} totalEstimatedTokens
 * @param {Partial<import('../../../lib/types.mjs').BudgetSnapshot>} [overrides]
 * @returns {import('../../../lib/types.mjs').BudgetSnapshot}
 */
function snap(totalEstimatedTokens, overrides = {}) {
  return {
    sessionMarkdownBytes: 0,
    traceSummaryBytes: 0,
    loadedSkillCount: 0,
    recentToolOutputBytes: 0,
    contextTokens: 0,
    totalEstimatedTokens,
    measuredAt: new Date().toISOString(),
    ...overrides,
  };
}

/** @param {string} p @returns {Promise<boolean>} */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// #87 — the load-bearing assertion of this whole file. The trace is an on-disk
// event log that never enters the prompt; counting it is what made the budget
// warn on every tool call over a file nothing can trim.
test('measureSession — the trace is measured but NOT counted toward the context total', async () => {
  const { taskStatePath } = await mkSession({ sessionBytes: 400, traceBytes: 400, toolBytes: 400, loadedSkills: ['a', 'b'] });
  const s = await measureSession({ taskStatePath });

  assert.equal(s.traceSummaryBytes, 400, 'trace is still measured');
  assert.equal(s.sessionMarkdownBytes, 400);
  assert.equal(s.recentToolOutputBytes, 400);
  assert.equal(s.loadedSkillCount, 2);
  // (400 session + 400 tool output) / 4 = 200. The 400 trace bytes add nothing.
  assert.equal(s.totalEstimatedTokens, 200);
});

test('measureSession — a huge trace alone never breaches the budget', async () => {
  // 200 KB of trace: 50,000 tokens if it were counted — over even the large
  // critical threshold. It is not in context, so the session is within budget.
  const { taskStatePath } = await mkSession({ traceBytes: 200_000 });
  const s = await measureSession({ taskStatePath });
  assert.equal(s.totalEstimatedTokens, 0);
  assert.equal(checkBudget(s, 'tiny').level, 'ok');
});

test('measureSession — the context meter is counted', async () => {
  const { taskStatePath } = await mkSession({});
  await recordToolResult(taskStatePath, 'z'.repeat(4000)); // 1,000 tokens
  const s = await measureSession({ taskStatePath });
  assert.equal(s.contextTokens, 1000);
  assert.equal(s.totalEstimatedTokens, 1000);
});

test('measureSession — missing component files count as zero, never throws', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'session-budget-empty-'));
  const taskStatePath = join(dir, 'task.json');
  await fsp.writeFile(
    taskStatePath,
    JSON.stringify({ sessionPath: join(dir, 'nope.md'), traceFile: join(dir, 'nope.jsonl') }),
    'utf8',
  );
  const s = await measureSession({ taskStatePath });
  assert.equal(s.totalEstimatedTokens, 0);
  assert.equal(s.recentToolOutputBytes, 0);
});

test('measureSession — absent task.json yields an all-zero snapshot', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'session-budget-nostate-'));
  const s = await measureSession({ taskStatePath: join(dir, 'task.json') });
  assert.equal(s.totalEstimatedTokens, 0);
  assert.equal(s.loadedSkillCount, 0);
  assert.equal(s.contextTokens, 0);
});

test('checkBudget — below warn returns ok with no actions', () => {
  const w = checkBudget(snap(1000), 'standard');
  assert.equal(w.level, 'ok');
  assert.deepEqual(w.cleanupActions, []);
  assert.equal(w.thresholdTokens, 8000);
});

test('checkBudget — at or above warn but below critical returns warn', () => {
  const w = checkBudget(snap(8000, { sessionMarkdownBytes: 32000 }), 'standard');
  assert.equal(w.level, 'warn');
  assert.match(w.message, /Session markdown/);
  assert.equal(w.thresholdTokens, 8000);
});

test('checkBudget — at or above critical returns critical', () => {
  const w = checkBudget(snap(16000, { contextTokens: 16000 }), 'standard');
  assert.equal(w.level, 'critical');
  assert.match(w.message, /Tool results in context/);
  assert.equal(w.thresholdTokens, 16000);
});

// #87 AC2 — the trace can never be named as the thing to trim, because there is
// nothing that trims it. This is the exact line the bug printed on every call:
//   "Trace summaries is 12,222 tokens ... Trim the largest component: Trace summaries"
test('checkBudget — the trace is never named the dominant component', () => {
  // A trace 100x the size of every in-context component.
  const w = checkBudget(
    snap(8000, { traceSummaryBytes: 4_000_000, sessionMarkdownBytes: 32000 }),
    'standard',
  );
  assert.equal(w.level, 'warn');
  assert.doesNotMatch(w.message, /Trace/i, 'the trace must not be reported as a budget component');
  assert.doesNotMatch(formatWarning(w), /Trim the largest component/);
});

// #87 AC2 — every action must name a mechanism that exists. The old list
// ("Unload unused skills", "Cap or trim session markdown") named none.
test('checkBudget — every cleanup action names a real mechanism', () => {
  for (const level of [snap(8000), snap(99999)]) {
    const w = checkBudget(level, 'standard');
    for (const action of w.cleanupActions) {
      assert.match(action, /compact-session/, `unactionable advice: ${action}`);
    }
  }
});

test('checkBudget — tiny class uses tiny thresholds', () => {
  assert.equal(checkBudget(snap(1999), 'tiny').level, 'ok');
  assert.equal(checkBudget(snap(2000), 'tiny').level, 'warn');
  assert.equal(checkBudget(snap(4000), 'tiny').level, 'critical');
});

test('formatWarning — ok is one line; warn/critical include an actions block', () => {
  assert.equal(formatWarning(checkBudget(snap(10), 'standard')), '[BUDGET:ok] Within budget.');

  const critLine = formatWarning(checkBudget(snap(50000, { sessionMarkdownBytes: 200000 }), 'large'));
  assert.match(critLine, /^\[BUDGET:critical\] /);
  assert.match(critLine, /\nActions: .+/);
});

// #87 AC3 — the trace gets its own tag and its own threshold, and it is not a
// budget level: a big trace is `ok` as far as the budget is concerned.
test('checkTraceSize — reports on its own tag, below the diagnostic threshold is silent', () => {
  const quiet = checkTraceSize(snap(0, { traceSummaryBytes: 1000 }));
  assert.equal(quiet.level, 'ok');
  assert.equal(formatTraceDiagnostic(quiet), '');

  const loud = checkTraceSize(snap(0, { traceSummaryBytes: TRACE_DIAGNOSTIC_TOKENS * 4 }));
  assert.equal(loud.level, 'warn');
  assert.equal(loud.tokens, TRACE_DIAGNOSTIC_TOKENS);
  assert.match(formatTraceDiagnostic(loud), /^\[TRACE:size\] /);
  assert.match(loud.message, /not context/i, 'must say plainly that this is not a budget breach');
});

// #87 AC5 — the identity of a report. Same breach → same key → not re-reported.
test('reportId — is null when ok, stable for an unchanged breach, changes as it worsens', () => {
  assert.equal(reportId(checkBudget(snap(10), 'standard')), null);

  const a = reportId(checkBudget(snap(8000, { contextTokens: 8000 }), 'standard'));
  const b = reportId(checkBudget(snap(8100, { contextTokens: 8100 }), 'standard'));
  assert.equal(a, b, 'a breach that has barely moved is the same report');

  const worse = reportId(checkBudget(snap(14000, { contextTokens: 14000 }), 'standard'));
  assert.notEqual(a, worse, 'a breach that is materially worse re-reports');
});

// #87 AC4 — the structural half of the fix: everything measureSession counts,
// resetContextBudget reduces. If these two ever disagree, critical is a livelock.
test('resetContextBudget — reduces every counted component, so a re-measure is smaller', async () => {
  const { taskStatePath, dir, sessionPath } = await mkSession({ sessionBytes: 40_000, toolBytes: 8_000 });
  await recordToolResult(taskStatePath, 'z'.repeat(40_000));
  await fsp.writeFile(join(dir, 'budget-critical.json'), '{}', 'utf8');

  const before = await measureSession({ taskStatePath });
  assert.ok(before.totalEstimatedTokens > 20_000, 'precondition: a big session');

  const archivePath = join(dir, 'archive.md');
  const reset = await resetContextBudget({ taskStatePath, archivePath });

  assert.deepEqual(reset.errors, []);
  assert.equal(reset.sessionArchivedTo, archivePath);
  assert.equal(reset.toolOutputPointerCleared, true);
  assert.equal(reset.contextMeterReset, true);
  assert.equal(reset.markerCleared, true);

  // The content is not destroyed — it is moved out of context and pointed at.
  assert.equal(await exists(archivePath), true, 'session markdown archived, not deleted');
  assert.match(await fsp.readFile(sessionPath, 'utf8'), /compacted/i);
  assert.equal(await exists(join(dir, 'budget-critical.json')), false);
  assert.equal((await readContextMeter(taskStatePath)).contextTokens, 0);

  const after = await measureSession({ taskStatePath });
  assert.ok(
    after.totalEstimatedTokens < before.totalEstimatedTokens,
    'the whole point: the next measurement is strictly smaller',
  );
  assert.equal(checkBudget(after, 'standard').level, 'ok');
});

test('resetContextBudget — is a safe no-op on a session with nothing to reduce', async () => {
  const { taskStatePath, dir } = await mkSession({ omitState: true });
  const reset = await resetContextBudget({ taskStatePath, archivePath: join(dir, 'archive.md') });
  assert.deepEqual(reset.errors, []);
  assert.equal(reset.sessionArchivedTo, null);
  assert.equal(reset.markerCleared, false, 'no marker to clear');
});
