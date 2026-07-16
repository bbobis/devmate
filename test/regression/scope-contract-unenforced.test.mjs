// @ts-check
/**
 * Regression: the per-file boundary was enforced on NO lane.
 *
 * Once the gate reached `impl-started`, `@fullstack` could edit any path in the
 * repository. Three rules were supposed to prevent that and none did:
 *
 *   Rule 4 (session artifacts) — its inputs have no producer.
 *   Rule 5 (persona ownership) — skipped: nothing writes `activePersona`. #77
 *     turned it off deliberately, resting the boundary on "the lane's scope.md
 *     (Rule 6), which all three lanes now write before implementation."
 *   Rule 6 (scope.md)          — that clause was false. NO lane wrote a scope.md:
 *     `writeFeatureScope`/`writeChoreScope` had no reachable caller, and
 *     `@diagnose`, told to author the bug lane's scope.md, has no `edit` tool.
 *     And Rule 6 skipped entirely when the file was absent — so the boundary was
 *     waived precisely when it was missing.
 *
 * The polarity was backwards in a way that hid it: an ABSENT contract permitted
 * everything, while an EMPTY one denied everything. Only the permissive branch
 * ever ran.
 *
 * These tests drive the REAL PreToolUse hook as a subprocess, so they exercise
 * the path a session actually takes. They fail on the pre-fix code: without a
 * scope.md the guard used to answer `allow`.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

const TASK_ID = 'scope-regression-1';

/**
 * A workspace at `impl-started` — implementation is legitimately open, so the
 * ONLY thing that can bound an edit here is the scope contract.
 * @param {{ scope?: string }} [opts]
 * @returns {string} workspace root
 */
function workspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-scope-reg-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });

  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['**/*'], offLimitsGlobs: [] }],
    }),
    'utf8',
  );

  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: TASK_ID,
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      // TDD already satisfied, so Rule 7 cannot be the thing that denies.
      tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
      schemaVersion: 1,
    }),
    'utf8',
  );

  if (opts.scope !== undefined) {
    const dir = join(root, '.devmate', 'session', TASK_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scope.md'), opts.scope, 'utf8');
  }

  return root;
}

/** The contract a real run now gets from @planner's return, via the gate-advance hook. */
const SCOPE_MD = [
  '---',
  'lane: feature',
  '---',
  '# Scope',
  '',
  '## Allowed paths',
  '- lib/in-scope.mjs',
  '',
  '## Allowed globs',
  '- **/*.test.mjs',
  '',
].join('\n');

/**
 * Drive the real hook and return its decision.
 * @param {string} root
 * @param {string} filePath
 * @returns {{ decision: string, reason: string }}
 */
function guard(root, filePath) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'create_file',
      tool_input: { filePath, content: 'x' },
      cwd: join(root, '.devmate'),
    }),
    encoding: 'utf8',
  });
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason ?? '' };
}

test(
  'scope regression — with NO scope contract, an edit at impl-started is DENIED',
  skipUnlessNode(24),
  () => {
    // THE BUG. This is the state every real session was in — no lane could write
    // a scope.md — and the guard answered `allow` for any path in the repo.
    const root = workspace();
    try {
      const v = guard(root, 'anything/at/all.mjs');
      assert.equal(v.decision, 'deny', 'an unbounded edit was permitted at impl-started');
      assert.match(v.reason, /no scope contract/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'scope regression — an OUT-OF-SCOPE edit is denied, and says what the contract allows',
  skipUnlessNode(24),
  () => {
    const root = workspace({ scope: SCOPE_MD });
    try {
      const v = guard(root, 'lib/not-in-the-plan.mjs');
      assert.equal(v.decision, 'deny');
      assert.match(v.reason, /out of scope/i);
      assert.match(v.reason, /lib\/in-scope\.mjs/, 'the deny must name the contract it enforced');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'scope regression — an IN-SCOPE edit is allowed: the boundary bounds, it does not brick',
  skipUnlessNode(24),
  () => {
    const root = workspace({ scope: SCOPE_MD });
    try {
      assert.equal(guard(root, 'lib/in-scope.mjs').decision, 'allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'scope regression — a test file is allowed by the glob floor, so TDD can still write its first failing test',
  skipUnlessNode(24),
  () => {
    // Without the floor, the failing test the bug lane REQUIRES before a fix
    // would itself be an out-of-scope edit, and the guard would block the very
    // workflow it exists to protect.
    const root = workspace({ scope: SCOPE_MD });
    try {
      assert.equal(guard(root, 'test/lib/in-scope.test.mjs').decision, 'allow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
