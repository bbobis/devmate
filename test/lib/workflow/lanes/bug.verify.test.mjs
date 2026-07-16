// @ts-check
/**
 * E9-13: bug lane runs a real verify by default; chore lane behavior is
 * unchanged (regression) and now persists verify evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBugLane } from '../../../../lib/workflow/lanes/bug.mjs';
import { persistVerifyResult } from '../../../../lib/loop/verify-step.mjs';

/** @returns {import('../../../../lib/types.mjs').TaskState} */
function makeState() {
  return /** @type {any} */ ({
    taskId: 'bug-verify-1',
    lane: 'bug',
    workflowGate: 'impl-started',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
  });
}

/** @returns {any} */
function makeDiagnosis() {
  return {
    taskId: 'bug-verify-1',
    bugScope: 'backend',
    suspectedLayer: 'pagination service',
    reproCommand: 'node --test test/repro.test.mjs',
    fixerRecommendation: 'Fix the off-by-one in pagination.',
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/pagination.mjs'],
    allowedGlobs: [],
    schemaVersion: 1,
  };
}

/** @type {(d: any, s: any, o: any) => Promise<any>} */
const okDispatch = async (d) => ({ target: 'fullstack', persona: d.bugScope, stateUpdated: true });

test('bug lane default verify runs', async () => {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'bug-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  // Passing command: the default verify (verifyStep) really executes it.
  const result = await runBugLane('fix pagination bug', makeState(), {
    diagnosis: makeDiagnosis(),
    dispatch: okDispatch,
    verifyArgv: [process.execPath, '--version'],
    traceFile: join(tmp, 'trace.jsonl'),
    repoRoot: tmp,
    outputDir: join(tmp, 'output'),
  });
  assert.equal(result.status, 'verified');

  // The verify evidence artifact was persisted by verifyStep (E9-13).
  const artifact = JSON.parse(
    await fsp.readFile(join(tmp, '.devmate', 'state', 'verify-result.json'), 'utf8')
  );
  assert.equal(artifact.passed, true);
  assert.equal(typeof artifact.completedAt, 'string');
  assert.equal(typeof artifact.digest, 'string');
});

test('bug lane default verify fails the lane on a failing command', async () => {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'bug-verify-fail-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  const result = await runBugLane('fix pagination bug', makeState(), {
    diagnosis: makeDiagnosis(),
    dispatch: okDispatch,
    verifyArgv: [process.execPath, '-e', 'process.exit(1)'],
    traceFile: join(tmp, 'trace.jsonl'),
    repoRoot: tmp,
    outputDir: join(tmp, 'output'),
  });
  assert.equal(result.status, 'failed', 'no more unconditional status: verified');
});

test('injected verify still takes precedence (regression)', async () => {
  let called = false;
  const result = await runBugLane('fix pagination bug', makeState(), {
    diagnosis: makeDiagnosis(),
    dispatch: okDispatch,
    verify: async () => {
      called = true;
      return { passed: true, summary: 'injected verify passed' };
    },
  });
  assert.equal(called, true);
  assert.equal(result.status, 'verified');
  assert.match(result.summary, /injected verify passed/);
});

test('persistVerifyResult writes an atomic, typed artifact', async () => {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'pvr-'));
  const stateDir = join(tmp, 'state');
  const path = await persistVerifyResult(
    { passed: true, digest: 'd', fullOutputPath: '/tmp/f.log' },
    { stateDir }
  );
  const artifact = JSON.parse(await fsp.readFile(path, 'utf8'));
  assert.equal(artifact.passed, true);
  assert.equal(artifact.digest, 'd');
  assert.equal(artifact.specDigest, '', 'no task.json in stateDir → empty specDigest');
  assert.ok(!Number.isNaN(Date.parse(artifact.completedAt)));
});
