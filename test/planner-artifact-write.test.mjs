// @ts-check

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { writeTaskState, readTaskState } from '../lib/task-state.mjs';
import { createTechDesignArtifact } from '../lib/workflow/agents/tech-design.mjs';
import {
  createPlannerArtifact,
  persistPlanArtifact,
  readAndRecordDesign,
} from '../lib/workflow/agents/planner.mjs';

/**
 * @returns {string}
 */
function makeTmpRepo() {
  return mkdtempSync(join(tmpdir(), 'devmate-planner-'));
}

/**
 * @param {string} taskId
 * @returns {import('../lib/types.mjs').TaskState}
 */
function minimalState(taskId) {
  return {
    taskId,
    lane: 'feature',
    workflowGate: 'plan-approved',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

describe('planner artifact read/write helpers', () => {
  test('regression / readAndRecordDesign records artifactHashes.design and designDigest', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PLAN-1';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');
      const designPath = join(repoRoot, '.devmate', 'session', taskId, 'design.json');
      mkdirSync(join(repoRoot, '.devmate', 'state'), { recursive: true });
      mkdirSync(join(repoRoot, '.devmate', 'session', taskId), { recursive: true });

      await writeTaskState(minimalState(taskId), statePath);

      const designArtifact = createTechDesignArtifact({
        apiContracts: [{ name: 'GetOrder', method: 'GET', path: '/orders/:id', purpose: 'Fetch one order' }],
      });
      writeFileSync(designPath, `${JSON.stringify(designArtifact, null, 2)}\n`, 'utf8');

      const result = await readAndRecordDesign(taskId, { repoRoot, statePath });
      assert.equal(result.path, designPath);

      const expectedDigest = createHash('sha256').update(readFileSync(designPath, 'utf8'), 'utf8').digest('hex');
      assert.equal(result.designDigest, expectedDigest);

      const stateResult = readTaskState(statePath);
      assert.equal(stateResult.ok, true);
      assert.ok(stateResult.ok);
      assert.equal(stateResult.state.artifactHashes.design, designPath);
      assert.equal(stateResult.state.artifactHashes.designDigest, expectedDigest);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('regression / persistPlanArtifact writes plan.json and records plan digest/hash', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PLAN-2';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');
      const expectedPlanPath = join(repoRoot, '.devmate', 'session', taskId, 'plan.json');
      mkdirSync(join(repoRoot, '.devmate', 'state'), { recursive: true });

      await writeTaskState(minimalState(taskId), statePath);

      const artifact = createPlannerArtifact({
        tasks: [
          {
            description: 'Implement planner persistence',
            ac: ['Plan artifact is persisted'],
            tddApproach: 'node:test unit assertions',
            persona: 'backend',
            files: ['lib/workflow/agents/planner.mjs'],
            alignment: [
              {
                capability: 'plan artifact persistence',
                decision: 'add',
                target: null,
                usageEvidence: [],
                patternRefs: ['lib/workflow/agents/planner.mjs:1'],
                reason: 'fixture: nothing suitable to reuse',
              },
            ],
          },
        ],
        assumptions: ['state file exists before planner run'],
        openRisks: ['digest mismatch during writes'],
      });

      const persisted = await persistPlanArtifact(artifact, { taskId, repoRoot, statePath });
      assert.equal(persisted.path, expectedPlanPath);
      assert.equal(existsSync(expectedPlanPath), true);

      const planContent = readFileSync(expectedPlanPath, 'utf8');
      assert.equal(planContent.endsWith('\n'), true);
      const expectedDigest = createHash('sha256').update(planContent, 'utf8').digest('hex');

      const stateResult = readTaskState(statePath);
      assert.equal(stateResult.ok, true);
      assert.ok(stateResult.ok);
      assert.equal(stateResult.state.artifactHashes.plan, expectedPlanPath);
      assert.equal(stateResult.state.artifactHashes.planDigest, expectedDigest);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('negative / readAndRecordDesign throws structured error when design.json is missing', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PLAN-MISSING';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');
      mkdirSync(join(repoRoot, '.devmate', 'state'), { recursive: true });
      await writeTaskState(minimalState(taskId), statePath);

      await assert.rejects(
        () => readAndRecordDesign(taskId, { repoRoot, statePath }),
        (err) => {
          assert.equal(err instanceof Error, true);
          const message = /** @type {Error} */ (err).message;
          assert.equal(message.includes('planner: unable to read design artifact'), true);
          return true;
        },
      );

      const stateResult = readTaskState(statePath);
      assert.equal(stateResult.ok, true);
      assert.ok(stateResult.ok);
      assert.equal('design' in stateResult.state.artifactHashes, false);
      assert.equal('designDigest' in stateResult.state.artifactHashes, false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('negative / readAndRecordDesign throws structured error when design.json is invalid', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PLAN-INVALID';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');
      const designPath = join(repoRoot, '.devmate', 'session', taskId, 'design.json');
      mkdirSync(join(repoRoot, '.devmate', 'state'), { recursive: true });
      mkdirSync(join(repoRoot, '.devmate', 'session', taskId), { recursive: true });

      await writeTaskState(minimalState(taskId), statePath);
      writeFileSync(designPath, JSON.stringify({ dataModel: {}, apiContracts: [] }, null, 2), 'utf8');

      await assert.rejects(
        () => readAndRecordDesign(taskId, { repoRoot, statePath }),
        (err) => {
          assert.equal(err instanceof Error, true);
          const message = /** @type {Error} */ (err).message;
          assert.equal(message.includes('planner: design artifact failed validation'), true);
          return true;
        },
      );

      const stateResult = readTaskState(statePath);
      assert.equal(stateResult.ok, true);
      assert.ok(stateResult.ok);
      assert.equal('design' in stateResult.state.artifactHashes, false);
      assert.equal('designDigest' in stateResult.state.artifactHashes, false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('negative / persistPlanArtifact throws when plan artifact is invalid', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const taskId = 'T-PLAN-BAD-PLAN';
      const statePath = join(repoRoot, '.devmate', 'state', 'task.json');
      mkdirSync(join(repoRoot, '.devmate', 'state'), { recursive: true });
      await writeTaskState(minimalState(taskId), statePath);

      await assert.rejects(
        () =>
          persistPlanArtifact(
            /** @type {import('../lib/workflow/agents/planner.mjs').PlannerArtifact} */ ({
              tasks: [],
              assumptions: [],
              openRisks: [],
              unverified: [],
            }),
            { taskId, repoRoot, statePath },
          ),
        (err) => {
          assert.equal(err instanceof Error, true);
          const message = /** @type {Error} */ (err).message;
          assert.equal(message.includes('planner: invalid plan artifact'), true);
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
