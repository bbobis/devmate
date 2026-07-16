// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/orch-assert-dispatch.mjs', import.meta.url));

/**
 * Spawn the script with given args and optional tmpfile content.
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
  };
}

/**
 * Write JSON to a tmp file and return its path. Caller owns cleanup.
 * @param {unknown} data
 * @param {string} dir
 * @returns {string}
 */
function writeTmp(data, dir) {
  const file = join(dir, `result-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

/**
 * Write a JSONL trace file with the given events and return its path.
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
 * A minimal `subagent_start` trace event fixture.
 * @param {string} agentName
 * @returns {Record<string, unknown>}
 */
function startEvent(agentName) {
  return { type: 'subagent_start', stepId: `s-${agentName}`, agentName, persona: agentName, activeCount: 1 };
}

test('orch-assert-dispatch / missing --agent exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--file', '/dev/null']);
  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /agent/i);
});

test('orch-assert-dispatch / missing --file exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--agent', 'discovery']);
  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /file/i);
});

test('orch-assert-dispatch / valid discovery result exits 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({
      status: 'ok',
      payload: {
        claims: [{ fact: 'f', path: 'p', confidence: 'high' }],
        unverified: [],
      },
    }, dir);
    const { exitCode, stdout } = run(['--agent', 'discovery', '--file', file]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / malformed JSON in file exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = join(dir, 'bad.json');
    writeFileSync(file, 'not-json', 'utf8');
    const { exitCode, stdout } = run(['--agent', 'discovery', '--file', file]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /cannot read file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / unregistered agent exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({ status: 'ok', artifactPath: 'some/path.json' }, dir);
    const { exitCode, stdout } = run(['--agent', 'ghost-agent', '--file', file]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /no validator registered/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / missing required payload keys exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({ status: 'ok', payload: { bugScope: 'backend' } }, dir);
    const { exitCode, stdout } = run(['--agent', 'diagnose', '--file', file]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /diagnose/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / valid diagnose payload exits 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({
      status: 'ok',
      payload: { bugScope: 'backend', reproCommand: 'npm test', taskId: 't-001' },
    }, dir);
    const { exitCode, stdout } = run(['--agent', 'diagnose', '--file', file]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / fullstack ok result backed by a subagent_start trace exits 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({ agentName: 'fullstack', status: 'ok', payload: { summary: 'done' } }, dir);
    const trace = writeTrace([startEvent('fullstack')], dir);
    const { exitCode, stdout } = run(['--agent', 'fullstack', '--file', file, '--trace', trace]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / fullstack ok result with no backing dispatch exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    // Shape is perfect — the artifact could have been hand-authored to pass the
    // validator — but the trace holds no fullstack subagent_start, so it is rejected.
    const file = writeTmp({ agentName: 'fullstack', status: 'ok', payload: { summary: 'done' } }, dir);
    const trace = writeTrace([startEvent('discovery')], dir);
    const { exitCode, stdout } = run(['--agent', 'fullstack', '--file', file, '--trace', trace]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /not backed by a dispatch|subagent_start/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / fullstack without --trace exits 2 (trace is required)', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({ agentName: 'fullstack', status: 'ok', payload: { summary: 'done' } }, dir);
    const { exitCode, stdout } = run(['--agent', 'fullstack', '--file', file]);
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /trace/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / backend persona is trace-backed and normalizes to fullstack', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    const file = writeTmp({ agentName: 'fullstack', status: 'ok', payload: { changedFiles: ['a.js'] } }, dir);
    // A backend dispatch is recorded as a backend subagent_start; it must
    // resolve to fullstack so the backing check clears.
    const trace = writeTrace([startEvent('backend')], dir);
    const { exitCode } = run(['--agent', 'backend', '--file', file, '--trace', trace]);
    assert.equal(exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-dispatch / non-ok fullstack result needs no dispatch backing', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    // A blocked result carries a reason and advances nothing — the shape check
    // is enough; an empty trace must not turn it into a failure.
    const file = writeTmp({ agentName: 'fullstack', status: 'blocked', reason: 'scope conflict' }, dir);
    const trace = writeTrace([], dir);
    const { exitCode, stdout } = run(['--agent', 'fullstack', '--file', file, '--trace', trace]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
