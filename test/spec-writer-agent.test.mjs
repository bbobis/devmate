// @ts-check

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTaskState, writeTaskState } from "../lib/task-state.mjs";
import { assertFullstackDispatchAllowed } from "../lib/workflow/orchestrator.mjs";
import { createPlannerArtifact } from "../lib/workflow/agents/planner.mjs";
import {
  SpecWriterAgentError,
  writeSpec,
} from "../lib/workflow/agents/spec-writer.mjs";

/** @returns {string} */
function makeTmpRepo() {
  const path = join(
    tmpdir(),
    `spec-writer-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * @param {string} taskId
 * @returns {import('../lib/types.mjs').TaskState}
 */
function createState(taskId) {
  return {
    taskId,
    lane: "feature",
    workflowGate: "plan-approved",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

/**
 * @param {string} repoRoot
 * @param {string} taskId
 * @returns {void}
 */
function seedUpstreamArtifacts(repoRoot, taskId) {
  const sessionDir = join(repoRoot, ".devmate", "session", taskId);
  const stateDir = join(repoRoot, ".devmate", "state");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    join(sessionDir, "discovery.json"),
    JSON.stringify(
      {
        claims: [
          {
            fact: "feature lane step 9 dispatches spec-writer",
            path: "agents/orchestrator.agent.md#L126",
            confidence: "high",
          },
        ],
        unverified: ["[UNVERIFIED] no additional discovery findings"],
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(sessionDir, "plan.json"),
    JSON.stringify({ note: "seeded plan artifact" }, null, 2),
    "utf8",
  );

  writeFileSync(
    join(stateDir, "grill-result.json"),
    JSON.stringify(
      {
        assumptions: [],
        missingRequirements: [],
        edgeCases: ["empty assumptions list"],
        cornerCases: [],
        securityRisks: [],
        blockingQuestions: ["What is the fallback state path?"],
        unverifiedItems: ["[UNVERIFIED] grilling data is synthetic in tests"],
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * @returns {import('../lib/workflow/agents/planner.mjs').PlannerArtifact}
 */
function createPlanArtifact() {
  return createPlannerArtifact({
    tasks: [
      {
        description: "Generate deterministic spec writer output",
        ac: [
          "spec.md includes assumptions from planner",
          "task state includes spec metadata before gate move",
        ],
        tddApproach: "node:test integration assertions",
        persona: "backend",
        files: [
          "lib/workflow/agents/spec-writer.mjs",
          "test/spec-writer-agent.test.mjs",
        ],
        alignment: [
          {
            capability: "spec writer output",
            decision: "add",
            target: null,
            usageEvidence: [],
            patternRefs: ["lib/workflow/agents/spec-writer.mjs:1"],
            reason: "fixture: nothing suitable to reuse",
          },
        ],
      },
    ],
    assumptions: ["[UNVERIFIED] plan assumptions are still pending review"],
    openRisks: ["[UNVERIFIED] rollout risk: spec metadata drift"],
  });
}

/**
 * @param {import('../lib/workflow/agents/planner.mjs').PlannerArtifact} planArtifact
 * @returns {{ ac: string, tier: 1|2|3, runCommand: string }[]}
 */
function makeTestPlanSeed(planArtifact) {
  /** @type {{ ac: string, tier: 1|2|3, runCommand: string }[]} */
  const seed = [];
  let counter = 1;
  for (const task of planArtifact.tasks) {
    for (const ac of task.ac) {
      seed.push({
        ac,
        tier: 1,
        runCommand: `node --test test/spec-scenario-${counter}.test.mjs`,
      });
      counter += 1;
    }
  }
  return seed;
}

describe("spec-writer adapter", () => {
  it("integration: approved plan writes spec and carries assumptions/risks to artifact + metadata", async () => {
    const repoRoot = makeTmpRepo();
    const taskId = "SW-INT-1";
    const statePath = join(repoRoot, ".devmate", "state", "task.json");

    try {
      mkdirSync(join(repoRoot, ".devmate", "state"), { recursive: true });
      await writeTaskState(createState(taskId), statePath);
      seedUpstreamArtifacts(repoRoot, taskId);

      const planArtifact = createPlanArtifact();
      const taskStateResult = readTaskState(statePath);
      assert.equal(taskStateResult.ok, true);
      assert.ok(taskStateResult.ok);

      const result = await writeSpec(
        { planArtifact, taskState: taskStateResult.state },
        {
          repoRoot,
          statePath,
          testPlanSeed: makeTestPlanSeed(planArtifact),
          now: () => new Date("2026-06-28T00:00:00.000Z"),
        },
      );

      assert.equal(existsSync(result.specPath), true);
      const specBody = readFileSync(result.specPath, "utf8");

      for (const item of planArtifact.assumptions) {
        assert.equal(specBody.includes(item), true);
      }
      for (const risk of planArtifact.openRisks) {
        assert.equal(specBody.includes(risk), true);
      }

      assert.equal(result.metadata.storedAt, result.specPath);
      assert.deepEqual(result.metadata.assumptions, planArtifact.assumptions);
      assert.deepEqual(result.metadata.risks, planArtifact.openRisks);
      assert.equal(typeof result.metadata.specDigest, "string");
      assert.equal(result.metadata.specDigest.length > 0, true);

      const updatedState = readTaskState(statePath);
      assert.equal(updatedState.ok, true);
      assert.ok(updatedState.ok);
      assert.equal(updatedState.state.artifactHashes.spec, result.specPath);
      assert.equal(
        updatedState.state.artifactHashes.specDigest,
        result.metadata.specDigest,
      );
      assert.equal(updatedState.state.artifactHashes.plan_stored_at, statePath);
      assert.equal(
        updatedState.state.artifactHashes.handoff_at,
        join(repoRoot, ".devmate", "state", "handoff", taskId),
      );
      assert.equal(
        updatedState.state.artifactHashes.specStoredAt,
        "2026-06-28T00:00:00.000Z",
      );
      assert.equal(Array.isArray(updatedState.state.specFiles), true);
      assert.deepEqual(updatedState.state.specFiles, [
        "lib/workflow/agents/spec-writer.mjs",
        "test/spec-writer-agent.test.mjs",
      ]);
      // The ordered AC list is persisted so per-AC progress ids are stable
      // across sessions (index+1 == impl-AC{n}). Order mirrors the checkboxes.
      assert.deepEqual(updatedState.state.acceptanceCriteria, [
        "spec.md includes assumptions from planner",
        "task state includes spec metadata before gate move",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("negative: invalid inputs do not write spec and keep fullstack dispatch blocked", async () => {
    const repoRoot = makeTmpRepo();
    const taskId = "SW-NEG-1";
    const statePath = join(repoRoot, ".devmate", "state", "task.json");

    try {
      mkdirSync(join(repoRoot, ".devmate", "state"), { recursive: true });
      await writeTaskState(createState(taskId), statePath);

      const invalidPlan = createPlannerArtifact({
        tasks: [],
        assumptions: [],
        openRisks: [],
      });
      const taskStateResult = readTaskState(statePath);
      assert.equal(taskStateResult.ok, true);
      assert.ok(taskStateResult.ok);

      await assert.rejects(
        () =>
          writeSpec(
            {
              planArtifact: invalidPlan,
              taskState: taskStateResult.state,
            },
            { repoRoot, statePath, testPlanSeed: [] },
          ),
        (err) => {
          assert.equal(err instanceof SpecWriterAgentError, true);
          return true;
        },
      );

      const specPath = join(repoRoot, ".devmate", "session", "spec.md");
      assert.equal(existsSync(specPath), false);

      const stateAfter = readTaskState(statePath);
      assert.equal(stateAfter.ok, true);
      assert.ok(stateAfter.ok);
      assert.equal("spec" in stateAfter.state.artifactHashes, false);

      const guard = assertFullstackDispatchAllowed(stateAfter.state);
      assert.equal(guard.ok, false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("regression: identical inputs produce stable metadata and spec body", async () => {
    const repoRoot = makeTmpRepo();
    const taskId = "SW-REG-1";
    const statePath = join(repoRoot, ".devmate", "state", "task.json");

    try {
      mkdirSync(join(repoRoot, ".devmate", "state"), { recursive: true });
      await writeTaskState(createState(taskId), statePath);
      seedUpstreamArtifacts(repoRoot, taskId);

      const planArtifact = createPlanArtifact();
      const stateResult = readTaskState(statePath);
      assert.equal(stateResult.ok, true);
      assert.ok(stateResult.ok);

      const first = await writeSpec(
        {
          planArtifact: structuredClone(planArtifact),
          taskState: stateResult.state,
        },
        {
          repoRoot,
          statePath,
          testPlanSeed: makeTestPlanSeed(planArtifact),
          now: () => new Date("2026-06-28T01:00:00.000Z"),
        },
      );
      const body1 = readFileSync(first.specPath, "utf8");

      const stateMid = readTaskState(statePath);
      assert.equal(stateMid.ok, true);
      assert.ok(stateMid.ok);

      const second = await writeSpec(
        {
          planArtifact: structuredClone(planArtifact),
          taskState: stateMid.state,
        },
        {
          repoRoot,
          statePath,
          testPlanSeed: makeTestPlanSeed(planArtifact),
          now: () => new Date("2026-06-28T01:00:00.000Z"),
        },
      );
      const body2 = readFileSync(second.specPath, "utf8");

      assert.equal(first.metadata.specDigest, second.metadata.specDigest);
      assert.deepEqual(first.metadata.assumptions, second.metadata.assumptions);
      assert.deepEqual(first.metadata.risks, second.metadata.risks);
      assert.equal(body1, body2);
      assert.equal(first.metadata.storedAt, second.metadata.storedAt);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
