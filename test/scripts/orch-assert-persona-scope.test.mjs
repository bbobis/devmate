// @ts-check

import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/orch-assert-persona-scope.mjs', import.meta.url));

/**
 * Build a temp workspace with a config (given personaScope mode) and a fullstack
 * result JSON listing changedFiles. Returns paths + a runner bound to its cwd.
 * @param {string} mode
 * @param {string[]} changedFiles
 */
function makeWorkspace(mode, changedFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-persona-'));
  mkdirSync(join(dir, '.devmate'), { recursive: true });
  writeFileSync(
    join(dir, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personaScope: mode,
      personas: [
        { persona: 'backend', editableGlobs: ['lib/**', 'src/**'], offLimitsGlobs: ['src/ui/**'] },
        { persona: 'frontend', editableGlobs: ['src/ui/**'] },
      ],
    }),
    'utf8',
  );
  const resultPath = join(dir, 'result.json');
  writeFileSync(
    resultPath,
    JSON.stringify({ agentName: 'fullstack', status: 'ok', payload: { changedFiles } }),
    'utf8',
  );
  return { dir, resultPath };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string }}
 */
function run(cwd, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '' };
}

test('orch-assert-persona-scope / missing --persona exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(process.cwd(), ['--file', '/dev/null']);
  assert.equal(exitCode, 2);
  assert.match(JSON.parse(stdout.trim()).error, /persona/i);
});

test('orch-assert-persona-scope / missing --file exits 2', skipUnlessNode(24), () => {
  const { exitCode, stdout } = run(process.cwd(), ['--persona', 'backend']);
  assert.equal(exitCode, 2);
  assert.match(JSON.parse(stdout.trim()).error, /file/i);
});

test('orch-assert-persona-scope / in-scope dispatch exits 0', skipUnlessNode(24), () => {
  const { dir, resultPath } = makeWorkspace('block', ['lib/a.mjs', 'src/b.mjs']);
  try {
    const { exitCode, stdout } = run(dir, ['--persona', 'backend', '--file', resultPath]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-persona-scope / block mode: out-of-scope exits 1 with violations', skipUnlessNode(24), () => {
  const { dir, resultPath } = makeWorkspace('block', ['lib/a.mjs', 'src/ui/x.mjs']);
  try {
    const { exitCode, stdout } = run(dir, ['--persona', 'backend', '--file', resultPath]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.violations, ['src/ui/x.mjs']);
    assert.equal(parsed.mode, 'block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-persona-scope / warn mode: same violation exits 0 (surfaces, does not halt)', skipUnlessNode(24), () => {
  const { dir, resultPath } = makeWorkspace('warn', ['src/ui/x.mjs']);
  try {
    const { exitCode, stdout } = run(dir, ['--persona', 'backend', '--file', resultPath]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.violations, ['src/ui/x.mjs']);
    assert.equal(parsed.mode, 'warn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orch-assert-persona-scope / off mode: no-op exits 0', skipUnlessNode(24), () => {
  const { dir, resultPath } = makeWorkspace('off', ['src/ui/x.mjs']);
  try {
    const { exitCode, stdout } = run(dir, ['--persona', 'backend', '--file', resultPath]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.trim()).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
