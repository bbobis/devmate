// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/orch-assert-fullstack.mjs', import.meta.url));

/**
 * Spawn the script with given args.
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
 * Write a task state JSON to a tmp file and return its path.
 * @param {unknown} data
 * @param {string} dir
 * @returns {string}
 */
function writeTmp(data, dir) {
  const file = join(dir, `state-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

test('orch-assert-fullstack / missing --state exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run([]);
  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /state/i);
});

test('orch-assert-fullstack / state with correct gate and spec metadata exits 0', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-full-'));
  try {
    const file = writeTmp({
      taskId: 't-1',
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc123' },
      preImplStash: null,
      currentStep: 0,
      budget: 5,
      schemaVersion: 1,
    }, dir);
    const { exitCode, stdout } = run(['--state', file]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-fullstack / wrong workflowGate exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-full-'));
  try {
    const file = writeTmp({
      taskId: 't-2',
      lane: 'feature',
      workflowGate: 'plan-approved',
      artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc123' },
      preImplStash: null,
      currentStep: 0,
      budget: 5,
      schemaVersion: 1,
    }, dir);
    const { exitCode, stdout } = run(['--state', file]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /impl-started/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-fullstack / missing specDigest exits 1', skipUnlessNode(24), () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-full-'));
  try {
    const file = writeTmp({
      taskId: 't-3',
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 5,
      schemaVersion: 1,
    }, dir);
    const { exitCode, stdout } = run(['--state', file]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /spec artifact metadata/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-fullstack / unreadable file exits 1', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(['--state', '/nonexistent/path/task.json']);
  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /cannot read state file/i);
});
