// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/fanout-report.mjs', import.meta.url));

/**
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string }}
 */
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '' };
}

/** A minimal fan-out trace: two overlapping workers and a merge. */
const TRACE_EVENTS = [
  { type: 'gate_transition', stepId: 'gatectl', taskId: 'feat-x', ts: '2026-07-01T00:00:00.000Z', schemaVersion: 1, from: 'no-lane', to: 'lane-set', gate: 'lane-set' },
  { type: 'subagent_start', stepId: 'w1', taskId: 'feat-x', ts: '2026-07-01T00:01:00.000Z', schemaVersion: 1, agentName: 'discovery', persona: 'unknown', activeCount: 1 },
  { type: 'subagent_start', stepId: 'w2', taskId: 'feat-x', ts: '2026-07-01T00:01:10.000Z', schemaVersion: 1, agentName: 'discovery', persona: 'unknown', activeCount: 2 },
  { type: 'subagent_complete', stepId: 'w1', taskId: 'feat-x', ts: '2026-07-01T00:03:00.000Z', schemaVersion: 1, agentName: 'discovery', persona: 'unknown', durationMs: 120000, activeCount: 1 },
  { type: 'subagent_complete', stepId: 'w2', taskId: 'feat-x', ts: '2026-07-01T00:03:30.000Z', schemaVersion: 1, agentName: 'discovery', persona: 'unknown', durationMs: 140000, activeCount: 0 },
  { type: 'discovery_merge', stepId: 'merge-discovery', taskId: 'feat-x', ts: '2026-07-01T00:04:00.000Z', schemaVersion: 1, inputs: 2, merged: 8, dropped: 1, conflicts: 0 },
];

/** Telemetry entries inside (and one outside) the trace window above. */
const TELEMETRY_ENTRIES = [
  { timestamp: '2026-07-01T00:00:30.000Z', workerId: 'scan-by-name', promptTokens: 0, completionTokens: 40, latencyMs: 800, contractValid: true },
  { timestamp: '2026-07-01T00:00:31.000Z', workerId: 'scan-by-content', promptTokens: 0, completionTokens: 60, latencyMs: 1200, contractValid: true },
  { timestamp: '2026-06-01T00:00:00.000Z', workerId: 'scan-by-name', promptTokens: 0, completionTokens: 999, latencyMs: 9, contractValid: true },
];

/**
 * @param {string} dir
 * @param {string} name
 * @param {Array<Record<string, unknown>>|string[]} rows  Objects are JSON-encoded; strings are written raw (malformed-line fixtures).
 * @returns {string}
 */
function writeJsonl(dir, name, rows) {
  const file = join(dir, name);
  const lines = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

test('fanout-report script › --trace prints the parallelism digest, exit 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-report-'));
  try {
    const trace = writeJsonl(dir, 'trace.jsonl', TRACE_EVENTS);
    const telemetry = writeJsonl(dir, 'workers.jsonl', TELEMETRY_ENTRIES);
    const { exitCode, stdout } = run(['--trace', trace, '--telemetry', telemetry]);
    assert.equal(exitCode, 0);
    // Window 00:01:00 → 00:03:30 = 150s; serial 120s + 140s = 260s; speedup 1.7333….
    assert.match(stdout, /K=2 \/ overlap=2 \/ speedup=1\.73x/);
    assert.match(stdout, /scan: scan-by-content — 1 run\(s\), mean 1200ms/);
    assert.match(stdout, /merge: 2 artifact\(s\) in — 8 claim\(s\) kept/);
    const lines = stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 20, `default digest must be <= 20 lines, got ${lines.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fanout-report script › --json emits the report object with malformed-line counts', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-report-'));
  try {
    const trace = writeJsonl(dir, 'trace.jsonl', TRACE_EVENTS);
    const telemetry = writeJsonl(dir, 'workers.jsonl', TELEMETRY_ENTRIES);
    const { exitCode, stdout } = run(['--trace', trace, '--telemetry', telemetry, '--json']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.verdict, 'green');
    assert.equal(parsed.parallelism.workers, 2);
    assert.equal(parsed.parallelism.windowMs, 150000);
    assert.equal(parsed.parallelism.serialEquivalentMs, 260000);
    assert.equal(parsed.cost.totalCompletionTokens, 100);
    assert.equal(parsed.malformedTraceLines, 0);
    assert.equal(parsed.malformedTelemetryLines, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fanout-report script › --task resolves the trace under --root', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'fanout-report-task-'));
  try {
    const traceDir = join(root, '.devmate', 'state', 'trace');
    mkdirSync(traceDir, { recursive: true });
    writeJsonl(traceDir, 'feat-x.jsonl', TRACE_EVENTS);
    const telemetry = writeJsonl(root, 'workers.jsonl', TELEMETRY_ENTRIES);
    const { exitCode, stdout } = run(['--task', 'feat-x', '--root', root, '--telemetry', telemetry]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /^Fan-out report — GREEN \(task feat-x\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fanout-report script › --all prints the fleet dashboard and tally', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'fanout-report-all-'));
  try {
    const traceDir = join(root, '.devmate', 'state', 'trace');
    mkdirSync(traceDir, { recursive: true });
    writeJsonl(traceDir, 'feat-a.jsonl', TRACE_EVENTS);
    // A trace with no fan-out at all — yellow.
    writeJsonl(traceDir, 'feat-b.jsonl', [TRACE_EVENTS[0]]);
    const telemetry = writeJsonl(root, 'workers.jsonl', TELEMETRY_ENTRIES);
    const { exitCode, stdout } = run(['--all', '--root', root, '--telemetry', telemetry]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Fan-out dashboard — 2 task\(s\): 1 green, 1 yellow, 0 red/);
    assert.match(stdout, /GREEN {2}feat-a/);
    assert.match(stdout, /YELLOW feat-b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fanout-report script › --all on an absent trace dir → 0 tasks, exit 0', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'fanout-report-empty-'));
  try {
    const { exitCode, stdout } = run(['--all', '--root', root, '--telemetry', join(root, 'none.jsonl')]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /0 task\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fanout-report script › malformed JSONL lines are skipped and counted, never a crash', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-report-bad-'));
  try {
    const trace = writeJsonl(dir, 'trace.jsonl', [
      JSON.stringify(TRACE_EVENTS[1]),
      '{not json at all',
      JSON.stringify(TRACE_EVENTS[3]),
    ]);
    const telemetry = writeJsonl(dir, 'workers.jsonl', [
      '<<<garbage>>>',
      JSON.stringify(TELEMETRY_ENTRIES[0]),
    ]);
    const { exitCode, stdout } = run(['--trace', trace, '--telemetry', telemetry]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /skipped 1 malformed trace line\(s\), 1 malformed telemetry line\(s\)/);

    const jsonRun = run(['--trace', trace, '--telemetry', telemetry, '--json']);
    assert.equal(jsonRun.exitCode, 0);
    const parsed = JSON.parse(jsonRun.stdout.trim());
    assert.equal(parsed.malformedTraceLines, 1);
    assert.equal(parsed.malformedTelemetryLines, 1);
    assert.equal(parsed.parallelism.workers, 1, 'the surviving pair still reports');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fanout-report script › missing trace and telemetry files → empty report, exit 0', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run([
    '--trace', join(tmpdir(), 'no-such-fanout-trace.jsonl'),
    '--telemetry', join(tmpdir(), 'no-such-workers.jsonl'),
  ]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Fan-out report — YELLOW/);
  assert.match(stdout, /K=0/);
});

test('fanout-report script › neither --trace, --task, nor --all exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--json']);
  assert.equal(exitCode, 2);
  assert.match(stdout, /trace|task/i);
});
