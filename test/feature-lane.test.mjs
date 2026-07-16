// @ts-check

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDiscoveryArtifact, validateDiscoveryArtifact } from '../lib/workflow/agents/discovery.mjs';
import { createPlannerArtifact, validatePlannerArtifact } from '../lib/workflow/agents/planner.mjs';
import {
  createCritiqueResult,
  createGrillResult,
} from '../lib/workflow/agents/rubber-duck.mjs';
import {
  validateCritiqueResult,
  validateGrillResult,
} from '../lib/workflow/contracts.mjs';
import { writeSpec } from '../lib/workflow/agents/spec-writer.mjs';
import { continueApprovedFeature } from '../lib/workflow/lanes/feature.mjs';
import { createMockExecutor, assertCallOrder } from '../lib/test-utils/mock-executor.mjs';

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: 'feat-lane-1',
    lane: 'feature',
    workflowGate: 'spec-approved',
    artifactHashes: {
      spec: '.devmate/session/spec.md',
      specDigest: 'digest-before',
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'feature-lane-test-'));
  mkdirSync(resolve(root, '.devmate', 'state'), { recursive: true });
  mkdirSync(resolve(root, '.devmate', 'session'), { recursive: true });

  writeFileSync(
    resolve(root, '.devmate', 'devmate.config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        personas: [
          {
            persona: 'backend',
            editableGlobs: ['lib/**', 'server/**'],
            offLimitsGlobs: ['ui/**'],
            instructionFile: null,
          },
          {
            persona: 'frontend',
            editableGlobs: ['ui/**', 'web/**'],
            offLimitsGlobs: ['server/**'],
            instructionFile: null,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const statePath = resolve(root, '.devmate', 'state', 'task.json');
  const transitionsPath = resolve(root, '.devmate', 'state', 'transitions.jsonl');
  writeFileSync(statePath, JSON.stringify(makeState(), null, 2), 'utf8');

  return {
    root,
    statePath,
    transitionsPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('feature lane e2e uses discovery -> grill -> plan -> critique -> spec -> impl dispatch order', async () => {
  const ws = makeWorkspace();
  const { executor, getCallLog } = createMockExecutor({
    agents: ['discovery', 'rubber-duck', 'planner', 'spec-writer', 'fullstack'],
    stubResults: {
      discovery: { status: 'ok' },
      'rubber-duck': { status: 'ok' },
      planner: { status: 'ok' },
      'spec-writer': { status: 'ok' },
      fullstack: { status: 'ok' },
    },
  });

  try {
    executor.invoke('discovery', { taskId: 'feat-lane-1' });
    const discovery = createDiscoveryArtifact(
      ['Current behavior is documented -> docs/CURRENT_BEHAVIOR.md [high]'],
      ['Need confirmation for legacy edge case'],
    );
    const discoveryValidation = validateDiscoveryArtifact(discovery);
    assert.equal(discoveryValidation.ok, true);

    executor.invoke('rubber-duck', { mode: 'grill' });
    const grill = createGrillResult(
      {
        assumptions: ['Feature behavior matches docs.'],
        missingRequirements: ['Define rollback condition.'],
        edgeCases: ['Empty payload from client.'],
        cornerCases: ['Parallel update race.'],
        securityRisks: ['Token scope drift'],
        blockingQuestions: ['Is migration backward compatible?'],
      },
      { taskId: 'feat-lane-1', iterationNumber: 1 },
    );
    const grillValidation = validateGrillResult(grill);
    assert.equal(grillValidation.ok, true);

    executor.invoke('planner', { lane: 'feature' });
    const planArtifact = createPlannerArtifact({
      tasks: [
        {
          description: 'Implement deterministic lane orchestration checks.',
          ac: ['Call order is deterministic', 'Spec metadata persisted'],
          tddApproach: 'Write failing lane tests before implementation updates.',
          persona: 'backend',
          files: ['lib/workflow/lanes/feature.mjs', 'test/feature-lane.test.mjs'],
        },
      ],
      assumptions: ['Discovery output is fresh'],
      openRisks: ['[UNVERIFIED] production traffic burst may need tuning'],
    });
    const planValidation = validatePlannerArtifact(planArtifact);
    assert.equal(planValidation.ok, true);

    executor.invoke('rubber-duck', { mode: 'critique' });
    const critique = createCritiqueResult(
      {
        missingAcceptanceCriteria: [],
        missingTests: [],
        riskySequencing: [],
        unlistedFiles: [],
        backwardsCompatRisks: [],
        rollbackRisk: 'Minimal; rollback plan documented.',
        verdict: 'APPROVE_PLAN',
      },
      { taskId: 'feat-lane-1', iterationNumber: 1 },
    );
    const critiqueValidation = validateCritiqueResult(critique);
    assert.equal(critiqueValidation.ok, true);

    executor.invoke('spec-writer', { gate: 'spec-draft' });
    const planningState = makeState({
      workflowGate: 'plan-approved',
      artifactHashes: {},
    });
    const specResult = await writeSpec(
      {
        planArtifact,
        taskState: planningState,
      },
      {
        repoRoot: ws.root,
        statePath: ws.statePath,
        testPlanSeed: [
          {
            ac: "Call order is deterministic",
            tier: 1,
            runCommand: "node --test test/feature-lane.test.mjs",
          },
          {
            ac: "Spec metadata persisted",
            tier: 1,
            runCommand: "node --test test/feature-lane.test.mjs",
          },
        ],
      },
    );
    const normalizedSpecPath = specResult.specPath.replace(/\\/g, '/');
    assert.equal(normalizedSpecPath.endsWith('.devmate/session/spec.md'), true);

    const stateAfterSpec = /** @type {TaskState} */ (JSON.parse(readFileSync(ws.statePath, 'utf8')));
    /** @type {TaskState} */
    const approvedState = {
      ...stateAfterSpec,
      lane: 'feature',
      workflowGate: 'spec-approved',
    };

    const gateResult = await continueApprovedFeature(approvedState, {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      specPath: specResult.specPath,
    });
    assert.equal(gateResult.gate, 'impl-started');

    executor.invoke('fullstack', {
      mode: gateResult.mode,
      workstreams: gateResult.workstreams,
    });

    assertCallOrder(getCallLog(), [
      'discovery',
      'rubber-duck',
      'planner',
      'rubber-duck',
      'spec-writer',
      'fullstack',
    ]);

    const onDisk = /** @type {TaskState} */ (JSON.parse(readFileSync(ws.statePath, 'utf8')));
    assert.equal(onDisk.workflowGate, 'impl-started');
  } finally {
    ws.cleanup();
  }
});
