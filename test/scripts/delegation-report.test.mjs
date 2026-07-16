// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/delegation-report.mjs', import.meta.url));

/**
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string }}
 */
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000 });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '' };
}

/**
 * @param {Array<Record<string, unknown>>} events
 * @param {string} dir
 * @returns {string}
 */
function writeTrace(events, dir) {
  const file = join(dir, `trace-${Date.now()}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

/**
 * @param {string} a
 * @returns {Record<string, unknown>}
 */
function startEvent(a) {
  return {
    type: 'subagent_start',
    stepId: `subagent-${a}`,
    taskId: 't',
    ts: '2026-07-05T00:00:00.000Z',
    schemaVersion: 1,
    agentName: a,
    persona: a,
    activeCount: 1,
  };
}

test('delegation-report / missing --trace exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run([]);
  assert.equal(exitCode, 2);
  assert.match(stdout, /trace/i);
});

test('delegation-report / green run reports delegated analysis', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-'));
  try {
    const file = writeTrace([startEvent('discovery'), startEvent('rubber-duck')], dir);
    const { exitCode, stdout } = run(['--trace', file]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /GREEN/);
    assert.match(stdout, /discovery/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation-report / --json emits the summary object', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-'));
  try {
    const file = writeTrace([startEvent('planner')], dir);
    const { exitCode, stdout } = run(['--trace', file, '--json']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.totalDispatches, 1);
    assert.ok(Array.isArray(parsed.analysisRan));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation-report / missing trace file → empty run, exit 0', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--trace', '/no/such/trace.jsonl']);
  assert.equal(exitCode, 0);
  assert.match(stdout, /dispatches: 0/);
});

test('delegation-report / neither --trace nor --task exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--json']);
  assert.equal(exitCode, 2);
  assert.match(stdout, /trace|task/i);
});

test('delegation-report / --task resolves trace path and lane from state', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'deleg-task-'));
  try {
    const stateDir = join(root, '.devmate', 'state');
    mkdirSync(join(stateDir, 'trace'), { recursive: true });
    writeFileSync(
      join(stateDir, 'task.json'),
      JSON.stringify({
        taskId: 'feat-x',
        lane: 'feature',
        workflowGate: 'plan-approved',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 0,
        budget: 10,
        schemaVersion: 1,
      }),
      'utf8',
    );
    writeFileSync(join(stateDir, 'trace', 'feat-x.jsonl'), JSON.stringify(startEvent('discovery')) + '\n', 'utf8');
    const { exitCode, stdout } = run(['--task', 'feat-x', '--root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /feature lane/);
    assert.match(stdout, /discovery/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delegation-report / --all scans every trace and tallies verdicts', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'deleg-all-'));
  try {
    const traceDir = join(root, '.devmate', 'state', 'trace');
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(join(traceDir, 'feat-a.jsonl'), JSON.stringify(startEvent('discovery')) + '\n', 'utf8');
    writeFileSync(
      join(traceDir, 'feat-b.jsonl'),
      JSON.stringify({
        type: 'gate_transition',
        stepId: 'gatectl',
        taskId: 'feat-b',
        ts: '2026-07-05T00:00:00.000Z',
        schemaVersion: 1,
        from: 'spec-approved',
        to: 'impl-started',
        gate: 'impl-started',
      }) + '\n',
      'utf8',
    );
    const { exitCode, stdout } = run(['--all', '--root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /2 task\(s\)/);
    assert.match(stdout, /feat-a/);
    assert.match(stdout, /feat-b/);
    // --strict fails the fleet because feat-b is RED.
    assert.equal(run(['--all', '--root', root, '--strict']).exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delegation-report / --all on an absent trace dir → 0 tasks, exit 0', skipUnlessNode(24), () => {
  const root = mkdtempSync(join(tmpdir(), 'deleg-empty-'));
  try {
    const { exitCode, stdout } = run(['--all', '--root', root]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /0 task\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delegation-report / --strict exits 1 on RED, 0 without it', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-'));
  try {
    const file = writeTrace(
      [
        {
          type: 'gate_transition',
          stepId: 'gatectl',
          taskId: 't',
          ts: '2026-07-05T00:00:00.000Z',
          schemaVersion: 1,
          from: 'spec-approved',
          to: 'impl-started',
          gate: 'impl-started',
        },
      ],
      dir,
    );
    const strictRun = run(['--trace', file, '--strict']);
    assert.equal(strictRun.exitCode, 1);
    assert.match(strictRun.stdout, /RED/);
    // Default (observability) never fails a run.
    assert.equal(run(['--trace', file]).exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation-report / --lane chore is not penalised for skipping analysis', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-'));
  try {
    const file = writeTrace(
      [
        startEvent('editor'),
        {
          type: 'gate_transition',
          stepId: 'gatectl',
          taskId: 't',
          ts: '2026-07-05T00:00:00.000Z',
          schemaVersion: 1,
          from: 'plan-approved',
          to: 'impl-started',
          gate: 'impl-started',
        },
      ],
      dir,
    );
    const { exitCode, stdout } = run(['--trace', file, '--lane', 'chore']);
    assert.equal(exitCode, 0);
    assert.match(stdout, /GREEN/);
    assert.doesNotMatch(stdout, /analysis not seen/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
