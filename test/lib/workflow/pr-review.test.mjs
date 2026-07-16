// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gatherReviewContext } from '../../../lib/workflow/pr-review.mjs';

/** Canned unified diff used across tests (stdout of `git diff`). */
const CANNED_DIFF = [
  'diff --git a/lib/a.mjs b/lib/a.mjs',
  'index 111..222 100644',
  '--- a/lib/a.mjs',
  '+++ b/lib/a.mjs',
  '@@ -1 +1 @@',
  '-const x = 1;',
  '+const x = 2;',
].join('\n');

const FIXED_TS = '2026-07-12T00:00:00.000Z';
const now = () => new Date(FIXED_TS);

/**
 * Build an injectable git runner from a name-status string. Matches on the
 * joined argv so each git subcommand returns its canned result.
 * @param {{ nameStatus: string, insideRepo?: boolean, symbolic?: string, untracked?: string, diff?: string }} cfg
 */
function makeGitRunner(cfg) {
  const insideRepo = cfg.insideRepo ?? true;
  const diff = cfg.diff ?? CANNED_DIFF;
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../../../lib/types.mjs').RunCommandResult} */
  const base = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
  /** @type {(argv: string[], opts?: object) => Promise<import('../../../lib/types.mjs').RunCommandResult>} */
  const run = async (argv) => {
    calls.push(argv);
    const j = argv.join(' ');
    if (j.includes('rev-parse --is-inside-work-tree')) {
      return insideRepo
        ? { ...base, stdout: 'true\n' }
        : { ...base, exitCode: 128, stderr: 'fatal: not a git repository\n' };
    }
    if (j.includes('symbolic-ref')) {
      return cfg.symbolic !== undefined
        ? { ...base, stdout: `${cfg.symbolic}\n` }
        : { ...base, exitCode: 1 };
    }
    if (j.includes('rev-parse --verify')) return { ...base, stdout: 'aaaaaaaaaaaa\n' };
    if (j === 'git rev-parse HEAD') return { ...base, stdout: 'headsha0000\n' };
    if (j.includes('merge-base')) return { ...base, stdout: 'basesha1234\n' };
    if (j.includes('diff --name-status')) return { ...base, stdout: cfg.nameStatus };
    if (j.includes('ls-files')) return { ...base, stdout: cfg.untracked ?? '' };
    if (j.startsWith('git diff ')) return { ...base, stdout: diff };
    return base;
  };
  return { run, calls };
}

/**
 * @param {{ taskId: string, lane: 'feature'|'bug'|'chore', specFiles?: string[] }} over
 * @returns {import('../../../lib/types.mjs').TaskState}
 */
function makeState(over) {
  return {
    taskId: over.taskId,
    lane: over.lane,
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...(over.specFiles ? { specFiles: over.specFiles } : {}),
  };
}

/**
 * Create a temp repo with the requested session artifacts.
 * @param {{
 *   taskId: string,
 *   spec?: string,
 *   plan?: object,
 *   scope?: string,
 *   diagnosis?: object,
 *   security?: object,
 * }} cfg
 * @returns {Promise<{ repo: string, outputDir: string }>}
 */
async function makeRepo(cfg) {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-prreview-'));
  const sessionDir = path.join(repo, '.devmate', 'session');
  const taskDir = path.join(sessionDir, cfg.taskId);
  const outputDir = path.join(repo, '.devmate', 'state');
  await fsp.mkdir(taskDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  if (cfg.spec !== undefined) await fsp.writeFile(path.join(sessionDir, 'spec.md'), cfg.spec, 'utf8');
  if (cfg.plan !== undefined) {
    await fsp.writeFile(path.join(taskDir, 'plan.json'), JSON.stringify(cfg.plan), 'utf8');
  }
  if (cfg.scope !== undefined) await fsp.writeFile(path.join(taskDir, 'scope.md'), cfg.scope, 'utf8');
  if (cfg.diagnosis !== undefined) {
    await fsp.writeFile(path.join(taskDir, 'diagnosis.json'), JSON.stringify(cfg.diagnosis), 'utf8');
  }
  if (cfg.security !== undefined) {
    await fsp.writeFile(path.join(taskDir, 'security.json'), JSON.stringify(cfg.security), 'utf8');
  }
  return { repo, outputDir };
}

const SPEC = [
  '# Spec: demo',
  '',
  '## Acceptance criteria',
  '- [ ] AC1: first',
  '- [ ] AC2: second',
  '',
  '## Out of scope',
  '- the moon',
  '',
].join('\n');

// ---------------------------------------------------------------------------

test('feature — parses changed files, unlisted/planned-but-unchanged, stable digest', async () => {
  const taskId = 'feat-1';
  const { repo, outputDir } = await makeRepo({
    taskId,
    spec: SPEC,
    plan: { tasks: [{ description: 'd', ac: [], tddApproach: 't', persona: 'backend', files: ['lib/b.mjs'] }], assumptions: [], openRisks: [], unverified: [] },
  });
  const nameStatus = 'M\tlib/a.mjs\nA\tlib/c.mjs\n';
  const { run, calls } = makeGitRunner({ nameStatus, symbolic: 'refs/remotes/origin/main' });
  const state = makeState({ taskId, lane: 'feature', specFiles: ['lib/a.mjs'] });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir });

  assert.equal(ctx.schemaVersion, 1);
  assert.equal(ctx.generatedAt, FIXED_TS);
  assert.equal(ctx.git.available, true);
  assert.equal(ctx.git.baseRef, 'origin/main');
  assert.equal(ctx.git.base, 'basesha1234');
  assert.equal(ctx.git.head, 'headsha0000');
  assert.deepEqual(ctx.git.changedFiles, [
    { status: 'M', path: 'lib/a.mjs' },
    { status: 'A', path: 'lib/c.mjs' },
  ]);
  // Planned = specFiles(lib/a.mjs) ∪ plan files(lib/b.mjs).
  assert.deepEqual(ctx.alignmentSignals.unlistedFiles, ['lib/c.mjs']);
  assert.deepEqual(ctx.alignmentSignals.plannedButUnchanged, ['lib/b.mjs']);
  assert.equal(ctx.alignmentSignals.regressionTestPresent, false);

  // Digest is the sha256 of the raw diff (stderr empty) — stable, deterministic.
  const expected = createHash('sha256').update(CANNED_DIFF).digest('hex').slice(0, 64);
  assert.equal(ctx.git.diffDigest, expected);

  // Spec parsed.
  assert.equal(ctx.artifacts.spec.found, true);
  assert.equal(ctx.artifacts.spec.acceptanceCriteria.length, 2);
  assert.deepEqual(ctx.artifacts.spec.outOfScope, ['the moon']);
  assert.equal(ctx.artifacts.plan.found, true);
  assert.equal(ctx.artifacts.plan.taskCount, 1);

  // A capped-diff-only invariant: no raw diff on the context root, digest present.
  assert.equal(typeof ctx.git.diffCapped, 'string');
  assert.ok(!('diffFull' in ctx.git));

  // Context file written to .devmate/state.
  const written = JSON.parse(await fsp.readFile(path.join(outputDir, 'pr-review-context.json'), 'utf8'));
  assert.equal(written.git.diffDigest, expected);

  // Base auto-detected via origin/HEAD (symbolic-ref hit) — no --verify probe needed.
  assert.ok(calls.some((c) => c.join(' ').includes('symbolic-ref')));
});

test('--base override wins over auto-detection', async () => {
  const taskId = 'feat-2';
  const { repo, outputDir } = await makeRepo({ taskId });
  const { run, calls } = makeGitRunner({ nameStatus: 'M\tlib/a.mjs\n', symbolic: 'refs/remotes/origin/main' });
  const state = makeState({ taskId, lane: 'feature' });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir, baseRef: 'develop' });

  assert.equal(ctx.git.baseRef, 'develop');
  // symbolic-ref must NOT be consulted when --base is supplied.
  assert.ok(!calls.some((c) => c.join(' ').includes('symbolic-ref')));
  assert.ok(calls.some((c) => c.join(' ').includes('merge-base HEAD develop')));
});

test('chore — outOfScopeFiles flags changed files scope.md forbids', async () => {
  const taskId = 'chore-1';
  const scope = ['---', 'lane: chore', '---', '# Scope', '', '## Allowed paths', '- lib/allowed.mjs', ''].join('\n');
  const { repo, outputDir } = await makeRepo({ taskId, scope });
  const nameStatus = 'M\tlib/allowed.mjs\nA\tlib/forbidden.mjs\n';
  const { run } = makeGitRunner({ nameStatus, symbolic: 'refs/remotes/origin/main' });
  const state = makeState({ taskId, lane: 'chore' });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir });

  assert.deepEqual(ctx.alignmentSignals.outOfScopeFiles, ['lib/forbidden.mjs']);
  assert.deepEqual(ctx.alignmentSignals.unlistedFiles, []); // feature-only
  assert.equal(ctx.artifacts.scope.found, true);
  assert.equal(ctx.artifacts.scope.lane, 'chore');
});

test('bug — regressionTestPresent true when a *.test.mjs changed; security counts read', async () => {
  const taskId = 'bug-1';
  const { repo, outputDir } = await makeRepo({
    taskId,
    diagnosis: { bugScope: 'backend', suspectedLayer: 'db', reproCommand: 'npm test', fixerRecommendation: 'x', taskId, schemaVersion: 1 },
    security: {
      findings: [
        { severity: 'low', description: 'minor', path: 'lib/a.mjs' },
        { severity: 'medium', description: 'meh', path: 'lib/b.mjs' },
      ],
      passed: true,
      unverified: ['[UNVERIFIED] check auth path'],
    },
  });
  const nameStatus = 'M\tlib/a.mjs\nA\ttest/lib/a.test.mjs\n';
  const { run } = makeGitRunner({ nameStatus, symbolic: 'refs/remotes/origin/main' });
  const state = makeState({ taskId, lane: 'bug' });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir });

  assert.equal(ctx.alignmentSignals.regressionTestPresent, true);
  assert.deepEqual(ctx.alignmentSignals.testFilesChanged, ['test/lib/a.test.mjs']);
  assert.equal(ctx.artifacts.diagnosis.found, true);
  assert.equal(ctx.artifacts.diagnosis.suspectedLayer, 'db');
  assert.equal(ctx.artifacts.security.found, true);
  assert.equal(ctx.artifacts.security.findingCount, 2);
  assert.equal(ctx.artifacts.security.passed, true);
  assert.deepEqual(ctx.artifacts.security.unverified, ['[UNVERIFIED] check auth path']);
});

test('include-full-output embeds the redacted diff', async () => {
  const taskId = 'feat-3';
  const { repo, outputDir } = await makeRepo({ taskId });
  const { run } = makeGitRunner({ nameStatus: 'M\tlib/a.mjs\n', symbolic: 'refs/remotes/origin/main' });
  const state = makeState({ taskId, lane: 'feature' });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir, includeFullOutput: true });

  assert.equal(typeof ctx.git.diffFull, 'string');
  assert.ok(/** @type {string} */ (ctx.git.diffFull).includes('const x = 2;'));
});

test('no git — rev-parse fails → git.available false, no throw, no diff attempted', async () => {
  const taskId = 'feat-4';
  const { repo, outputDir } = await makeRepo({ taskId });
  const { run, calls } = makeGitRunner({ nameStatus: '', insideRepo: false });
  const state = makeState({ taskId, lane: 'feature' });

  const ctx = await gatherReviewContext(state, { run, repoRoot: repo, now, outputDir });

  assert.equal(ctx.git.available, false);
  assert.equal(ctx.git.diffDigest, '');
  assert.match(ctx.git.note, /not a git work tree/);
  // No diff/merge-base commands should run once the repo check fails.
  assert.ok(!calls.some((c) => c.join(' ').includes('git diff')));
  assert.ok(!calls.some((c) => c.join(' ').includes('merge-base')));

  // Context still written (review from artifacts only).
  const written = JSON.parse(await fsp.readFile(path.join(outputDir, 'pr-review-context.json'), 'utf8'));
  assert.equal(written.git.available, false);
});
