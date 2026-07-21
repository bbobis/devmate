// @ts-check
/**
 * #92 — the hook authors the scope contract from the returns agents can actually
 * produce.
 *
 * The per-file boundary existed on no lane. `writeFeatureScope`/`writeChoreScope`
 * had no reachable caller (the orchestrator has no tool that runs a JS function),
 * and `@diagnose` — whose prompt instructed it to produce the bug lane's
 * scope.md — has no `edit` tool and cannot write a file. So the contract Rule 6
 * enforces was never authored, and Rule 6 skipped whenever it was absent.
 *
 * The fix is the same shape as #91's: the layer that can execute writes the
 * artifact, from the typed return the agent CAN produce.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { projectWorkerReturn } from '../../../lib/workflow/gate-advance.mjs';
import { parseScope, validateScope } from '../../../lib/workflow/scope.mjs';
import { scopePathFor } from '../../../lib/workflow/scope-writer.mjs';

/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-scope-proj-'));
  mkdirSync(join(dir, '.devmate', 'state'), { recursive: true });
  return dir;
}

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
const taskState = (over = {}) =>
  /** @type {TaskState} */ ({
    taskId: 't1',
    lane: 'feature',
    workflowGate: 'grill-done',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
    ...over,
  });

const CONFIG = /** @type {any} */ ({
  schemaVersion: 1,
  mode: 'single-root',
  personas: [{ persona: 'backend', editableGlobs: ['lib/**'], offLimitsGlobs: [] }],
  testGlobs: ['**/*.test.mjs'],
});

/** A PlannerArtifact exactly as `validatePlannerArtifact` requires it. */
const PLANNER_RETURN = {
  agentName: 'planner',
  tasks: [
    {
      description: 'Add the guard',
      ac: ['AC1'],
      tddApproach: 'write the failing test first',
      persona: 'backend',
      files: ['lib/guard.mjs', 'lib/index.mjs'],
      alignment: [
        {
          capability: 'guard',
          decision: 'add',
          target: null,
          usageEvidence: [],
          patternRefs: ['lib/index.mjs:1'],
          reason: 'fixture: nothing suitable to reuse',
        },
      ],
    },
    {
      description: 'Wire it up',
      ac: ['AC2'],
      tddApproach: 'extend the suite',
      persona: 'backend',
      // Deliberately overlapping — the contract must dedupe.
      files: ['lib/index.mjs'],
      alignment: [
        {
          capability: 'wiring',
          decision: 'add',
          target: null,
          usageEvidence: [],
          patternRefs: ['lib/index.mjs:1'],
          reason: 'fixture: nothing suitable to reuse',
        },
      ],
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

/** A DiagnosisResult carrying the bug lane's boundary (#92). */
const DIAGNOSE_RETURN = {
  agentName: 'diagnose',
  bugScope: 'backend',
  suspectedLayer: 'service layer',
  reproCommand: 'npm test -- order',
  fixerRecommendation: 'null-guard the total',
  allowedPaths: ['src/services/OrderService.mjs'],
  allowedGlobs: ['src/services/**/*.mjs'],
  taskId: 't1',
  schemaVersion: 1,
};

test('gate-advance/scope › the planner return becomes the lane\'s scope contract', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(root, 'planner', PLANNER_RETURN, taskState(), CONFIG);
    assert.equal(res.artifact, 'plan.json');

    const parsed = parseScope(readFileSync(scopePathFor(root, 't1'), 'utf8'));
    assert.equal(validateScope(parsed).ok, true);
    assert.equal(parsed.lane, 'feature');
    assert.deepEqual(
      parsed.allowedPaths,
      ['lib/guard.mjs', 'lib/index.mjs'],
      'the plan\'s files, deduped and sorted',
    );
    assert.ok(
      parsed.allowedGlobs.includes('**/*.test.mjs'),
      'the test-glob floor must be in scope, or TDD\'s first failing test is itself an out-of-scope edit',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope › the diagnose return becomes the BUG lane\'s scope contract', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'diagnose',
      DIAGNOSE_RETURN,
      taskState({ lane: 'bug' }),
      CONFIG,
    );
    // Both artifacts: the one the dispatch gate reads, and the one Rule 6 enforces.
    assert.equal(res.artifact, 'diagnosis.json');
    const diagnosis = JSON.parse(
      readFileSync(join(root, '.devmate', 'state', 'diagnosis.json'), 'utf8'),
    );
    assert.equal(diagnosis.bugScope, 'backend');

    const parsed = parseScope(readFileSync(scopePathFor(root, 't1'), 'utf8'));
    assert.equal(parsed.lane, 'bug');
    assert.deepEqual(parsed.allowedPaths, ['src/services/OrderService.mjs']);
    assert.ok(parsed.allowedGlobs.includes('src/services/**/*.mjs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope › #180 an escaping glob in a diagnose return never reaches the bug lane scope contract', async () => {
  // The bug lane's @diagnose return is the only attacker-influenceable glob
  // source. An escaping glob must be dropped end-to-end, exactly as #170 drops an
  // escaping path — proven here through the real projectWorkerReturn → writeScope
  // path, not just the writeScope unit.
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'diagnose',
      { ...DIAGNOSE_RETURN, allowedGlobs: ['../../etc/**', 'src/services/**/*.mjs'] },
      taskState({ lane: 'bug' }),
      CONFIG,
    );
    assert.equal(res.artifact, 'diagnosis.json');
    const parsed = parseScope(readFileSync(scopePathFor(root, 't1'), 'utf8'));
    assert.ok(!parsed.allowedGlobs.includes('../../etc/**'), 'the exact escaping glob is dropped');
    assert.ok(parsed.allowedGlobs.includes('src/services/**/*.mjs'), 'the contained glob survives');
    assert.ok(parsed.allowedGlobs.includes('**/*.test.mjs'), 'the test-glob floor survives');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope › a diagnosis bounded to NOTHING is refused', async () => {
  // Both lists empty would serialize to a contract that denies every edit. The
  // validator rejects it, so no diagnosis.json and no scope.md are written and
  // the dispatch gate refuses for want of them — naming the real cause.
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'diagnose',
      { ...DIAGNOSE_RETURN, allowedPaths: [], allowedGlobs: [] },
      taskState({ lane: 'bug' }),
      CONFIG,
    );
    assert.equal(res.artifact, null);
    assert.match(String(res.reason), /cannot both be empty/i);
    assert.throws(() => readFileSync(scopePathFor(root, 't1'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope › a malformed planner return writes no scope at all', async () => {
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'planner',
      { agentName: 'planner', tasks: 'not-an-array' },
      taskState(),
      CONFIG,
    );
    assert.equal(res.artifact, null);
    assert.throws(() => readFileSync(scopePathFor(root, 't1'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope › the chore lane gets its boundary from its scoping dispatch', async () => {
  // The chore lane dispatches nobody before @fullstack, so `proposedFiles` — the
  // list its own procedure calls "the authoritative scope contract" — was
  // produced by orchestrator prose that could never reach disk. It now runs
  // @planner as a scoping pass, and that return is the contract.
  const root = workspace();
  try {
    const res = await projectWorkerReturn(
      root,
      'planner',
      PLANNER_RETURN,
      taskState({ lane: 'chore' }),
      CONFIG,
    );
    assert.equal(res.artifact, 'plan.json');

    const parsed = parseScope(readFileSync(scopePathFor(root, 't1'), 'utf8'));
    assert.equal(parsed.lane, 'chore');
    assert.deepEqual(parsed.allowedPaths, ['lib/guard.mjs', 'lib/index.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
