// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/orch-assert-floor.mjs', import.meta.url));

/**
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '' };
}

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
 * @param {Array<Record<string, unknown>>} events
 * @param {string} dir
 * @returns {string}
 */
function writeTrace(events, dir) {
  const file = join(dir, `trace-${Date.now()}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

test('orch-assert-floor / missing --gate exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--trace', '/dev/null']);
  assert.equal(exitCode, 2);
  assert.match(JSON.parse(stdout.trim()).error, /gate/i);
});

test('orch-assert-floor / missing --trace exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--gate', 'grill-done']);
  assert.equal(exitCode, 2);
  assert.match(JSON.parse(stdout.trim()).error, /trace/i);
});

test('orch-assert-floor / unfloored gate passes even with a missing trace file', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--gate', 'pr-ready', '--trace', '/no/such/trace.jsonl']);
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.trim()).ok, true);
});

test('orch-assert-floor / floored gate with no dispatch exits 1', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--gate', 'grill-done', '--trace', '/no/such/trace.jsonl']);
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /grill-done/);
});

test('orch-assert-floor / wrong specialist for the gate exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-floor-'));
  try {
    const file = writeTrace([startEvent('discovery')], dir);
    const { exitCode } = run(['--gate', 'plan-done', '--trace', file]);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-floor / owning specialist dispatched exits 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-floor-'));
  try {
    const file = writeTrace([startEvent('discovery'), startEvent('planner')], dir);
    const { exitCode, stdout } = run(['--gate', 'plan-done', '--trace', file]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
