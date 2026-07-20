// @ts-check
/**
 * #202 — deterministic coverage of the two versioned CAS loops' own retry/exhaust
 * branches, using the test-only conflict seam (lib/testing/cas-conflict-seam.mjs).
 *
 * #198 added per-site no-clobber concurrency tests, but the handlers' `conflict →
 * continue` branch and the retries-exhausted path had no DETERMINISTIC coverage —
 * a bare Promise.all race cannot guarantee a version bump lands in the window
 * between the loop's fresh read and its commit. The seam closes that window on
 * demand, so these tests force exactly N conflicts and assert the outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { handlePostToolUse } from '../../hooks/gate-advance.mjs';
import { handleUserPromptSubmit } from '../../hooks/approval-listener.mjs';
import { readTaskState, stateVersionOf } from '../../lib/task-state.mjs';
import { resetCasConflictSeam, CAS_CONFLICT_ENV } from '../../lib/testing/cas-conflict-seam.mjs';

/** A sink stream (the hooks write JSON lines we don't assert on here). */
function sink() {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

/**
 * Read the on-disk task state (asserting it is readable).
 * @param {string} statePath
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function readState(statePath) {
  const r = readTaskState(statePath);
  assert.ok(r.ok, 'task.json must be readable');
  return r.state;
}

/**
 * Arm the seam for one test body, always disarming + resetting afterwards.
 * @param {string} spec
 * @param {() => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withArmedConflict(spec, body) {
  process.env[CAS_CONFLICT_ENV] = spec;
  resetCasConflictSeam();
  try {
    await body();
  } finally {
    delete process.env[CAS_CONFLICT_ENV];
    resetCasConflictSeam();
  }
}

// ── gate-advance lane walk ───────────────────────────────────────────────────

/**
 * A feature workspace at grill-done (a digest-stampable gate) with a spec.md but
 * NO recorded specDigest. A runSubagent PostToolUse return reaches the gate-advance
 * CAS loop, where stampSpecDigest makes the base change and the loop COMMITS it
 * under a version pin — the exact `mutateTaskStateUnderLock(expectedVersion)` the
 * seam forces to conflict.
 * @returns {{ root: string, statePath: string }}
 */
function gateWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'devmate-cas-ga-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'session'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't1',
      lane: 'feature',
      workflowGate: 'grill-done',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  // A non-empty spec whose digest is not yet recorded → stampSpecDigest changes
  // the base, so the CAS loop has something to commit.
  writeFileSync(join(root, '.devmate', 'session', 'spec.md'), '# Spec\n\nbody\n', 'utf8');
  return { root, statePath: join(root, '.devmate', 'state', 'task.json') };
}

/** A valid PlannerArtifact whose task names a file (plan.json + scope.md both land). */
const PLAN_OK = {
  agentName: 'planner',
  tasks: [{ description: 'Do it', ac: ['AC1'], tddApproach: 'test first', persona: 'backend', files: ['lib/a.mjs'] }],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

/**
 * @param {string} root
 * @returns {{ repoRoot: string, toolName: string, toolUseId: string, toolResponse: string }}
 */
const plannerReturn = (root) => ({
  repoRoot: root,
  toolName: 'runSubagent',
  toolUseId: 'toolu_1',
  toolResponse: `Here is the plan.\n\n${JSON.stringify(PLAN_OK)}`,
});

test('gate-advance/#202 — one forced conflict is retried and the state commit still lands', async () => {
  const { root, statePath } = gateWorkspace();
  try {
    const before = stateVersionOf(readState(statePath));
    await withArmedConflict('gate-advance:1', async () => {
      await handlePostToolUse(plannerReturn(root), { stdout: sink(), stderr: sink() });
    });
    const after = readState(statePath);
    // The retry recomputed against the newer state and committed: the spec digest
    // the loop derived is now recorded.
    assert.ok(after.artifactHashes.specDigest, 'the recomputed spec digest was committed after the retry');
    // one external bump (the seam) + one successful commit = +2.
    assert.equal(stateVersionOf(after) - before, 2, 'exactly one retry: seam bump + landed commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/#202 — conflicts on every attempt exhaust the loop and nothing is committed', async () => {
  const { root, statePath } = gateWorkspace();
  try {
    const before = stateVersionOf(readState(statePath));
    /** @type {any} */
    let res;
    await withArmedConflict('gate-advance:3', async () => {
      res = await handlePostToolUse(plannerReturn(root), { stdout: sink(), stderr: sink() });
    });
    assert.equal(res.action, 'no_action', 'exhausted retries bail without committing');
    const after = readState(statePath);
    assert.equal(after.workflowGate, 'grill-done', 'the gate stayed put — no half-move');
    assert.equal(after.artifactHashes.specDigest, undefined, 'nothing was committed — the digest was never stamped');
    // three seam bumps, no landed commit (GATE_ADVANCE_CAS_ATTEMPTS === 3).
    assert.equal(stateVersionOf(after) - before, 3, 'all three attempts conflicted; nothing committed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── approve-plan ─────────────────────────────────────────────────────────────

/** A bug-lane workspace at plan-approved, where "approve plan" advances to impl-started. */
function approveWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'devmate-cas-ap-'));
  const stateDir = join(root, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, '.devmate', 'session'), { recursive: true });
  const statePath = join(stateDir, 'task.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      taskId: 'bug-1',
      lane: 'bug',
      workflowGate: 'plan-approved',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({ schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }] }),
    'utf8',
  );
  return { root, statePath };
}

test('approve-plan/#202 — one forced conflict is retried and the approval still advances', async () => {
  const { root, statePath } = approveWorkspace();
  try {
    const before = stateVersionOf(readState(statePath));
    /** @type {any} */
    let result;
    await withArmedConflict('approve-plan:1', async () => {
      result = await handleUserPromptSubmit({ prompt: 'approve plan', root, stdout: sink() });
    });
    assert.equal(result.action, 'gate_advanced', 'the approval landed after retrying the conflict');
    const after = readState(statePath);
    assert.equal(after.workflowGate, 'impl-started');
    assert.equal(stateVersionOf(after) - before, 2, 'one retry: seam bump + landed commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve-plan/#202 — conflicts on every attempt exhaust the loop and refuse (gate unchanged)', async () => {
  const { root, statePath } = approveWorkspace();
  try {
    const before = stateVersionOf(readState(statePath));
    let output = '';
    const capture = new Writable({ write(c, _e, cb) { output += String(c); cb(); } });
    /** @type {any} */
    let result;
    await withArmedConflict('approve-plan:3', async () => {
      result = await handleUserPromptSubmit({ prompt: 'approve plan', root, stdout: capture });
    });
    assert.equal(result.action, 'passthrough', 'exhausted retries do not claim an advance');
    assert.match(output, /repeated concurrent state changes/, 'the refusal is surfaced to the model');
    const after = readState(statePath);
    assert.equal(after.workflowGate, 'plan-approved', 'the gate stayed put');
    assert.equal(stateVersionOf(after) - before, 3, 'all three attempts conflicted; nothing committed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
