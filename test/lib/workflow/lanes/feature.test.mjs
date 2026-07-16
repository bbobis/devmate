// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeTaskState } from "../../../../lib/task-state.mjs";
import { SCOPE_CHANGE_NOTE_FILENAME } from "../../../../lib/gate-preconditions.mjs";
import { evaluateGuard } from "../../../../lib/gate-guard-core.mjs";
import { parseScope } from "../../../../lib/workflow/scope.mjs";
import {
  continueApprovedFeature,
  FEATURE_IMPL_STARTED,
  FEATURE_STEERING_EVENTS,
  formatPlanAnnouncement,
  PLAN_PATH,
  SPEC_PATH,
  steerFeature,
} from "../../../../lib/workflow/lanes/feature.mjs";

/**
 * Create a minimal workspace with config/spec/state paths.
 * @returns {Promise<{ dir: string, statePath: string, transitionsPath: string, configPath: string, specPath: string }>}
 */
async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "devmate-feature-test-"));
  const stateDir = join(dir, ".devmate", "state");
  await mkdir(stateDir, { recursive: true });
  const configPath = join(dir, ".devmate", "devmate.config.json");
  const specPath = join(dir, SPEC_PATH);
  await mkdir(join(dir, ".devmate", "session"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        personas: [
          {
            persona: "backend",
            editableGlobs: ["lib/**", "server/**"],
            offLimitsGlobs: ["ui/**"],
            instructionFile: null,
          },
          {
            persona: "frontend",
            editableGlobs: ["ui/**", "src/web/**"],
            offLimitsGlobs: ["server/**"],
            instructionFile: null,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    specPath,
    [
      "# Spec",
      "",
      "## Files that will change",
      "- lib/service/user.mjs",
      "- ui/components/button.mjs",
      "- shared/contracts/api.json",
    ].join("\n"),
    "utf8",
  );
  return {
    dir,
    statePath: join(stateDir, "task.json"),
    transitionsPath: join(dir, "transitions.jsonl"),
    configPath,
    specPath,
  };
}

/**
 * Build a minimal valid TaskState for the feature lane.
 * @param {Partial<import('../../../../lib/types.mjs').TaskState>} overrides
 * @returns {import('../../../../lib/types.mjs').TaskState}
 */
function makeFeatureState(overrides = {}) {
  return {
    taskId: "task-test-001",
    lane: "feature",
    // HITL-2: implementation is reachable only from spec-approved.
    workflowGate: "spec-approved",
    artifactHashes: {
      spec: ".devmate/session/spec.md",
      specDigest: "deadbeef",
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

test("feature lane › continueApprovedFeature advances gate to impl-started", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState();
    await writeTaskState(initial, fx.statePath);

    const { state: advanced, gate, mode, workstreams } =
      await continueApprovedFeature(initial, {
        repoRoot: fx.dir,
        statePath: fx.statePath,
        transitionsPath: fx.transitionsPath,
        configPath: fx.configPath,
        specPath: fx.specPath,
      });

    assert.equal(advanced.workflowGate, FEATURE_IMPL_STARTED);
    assert.equal(gate, FEATURE_IMPL_STARTED);
    assert.equal(mode, "sequential-shared-first");
    assert.deepEqual(workstreams, {
      backendFiles: ["lib/service/user.mjs"],
      frontendFiles: ["ui/components/button.mjs"],
      sharedFiles: ["shared/contracts/api.json"],
    });

    const raw = JSON.parse(await readFile(fx.statePath, "utf8"));
    assert.equal(raw.workflowGate, FEATURE_IMPL_STARTED);
    assert.equal(raw.artifactHashes.plan_stored_at, fx.statePath);
    assert.equal(
      raw.artifactHashes.handoff_at,
      join(fx.dir, ".devmate", "state", "handoff", "task-test-001"),
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature does NOT author scope.md — the gate-advance hook does", async () => {
  // #92: the lane used to carry a `writeFeatureScope` helper that derived the
  // contract from a broken markdown parse of spec.md. It has been deleted; the
  // gate-advance hook now authors .devmate/session/<taskId>/scope.md from the
  // planner's (or @diagnose's) typed return. This test pins that the lane
  // function itself writes no scope.md, so the file can only ever come from the
  // one producer — and re-adding a second writer would fail here.
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState();
    await writeTaskState(initial, fx.statePath);

    await continueApprovedFeature(initial, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });

    const scopePath = join(
      fx.dir,
      ".devmate",
      "session",
      "task-test-001",
      "scope.md",
    );
    await assert.rejects(
      () => readFile(scopePath, "utf8"),
      /ENOENT/,
      "continueApprovedFeature must not author scope.md",
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › the hook-authored scope.md is what gate-guard Rule 6 enforces", async () => {
  // The contract's *content* is still worth pinning end-to-end: parse a scope.md
  // in the shape the gate-advance hook writes and run it through the real guard.
  const scopeRaw = [
    "---",
    "lane: feature",
    "---",
    "# Scope",
    "",
    "## Allowed paths",
    "- lib/service/user.mjs",
    "- ui/components/button.mjs",
    "",
    "## Allowed globs",
    "- **/*.test.mjs",
    "",
  ].join("\n");
  const scope = parseScope(scopeRaw);
  const state = /** @type {any} */ ({
    ...makeFeatureState(),
    workflowGate: "impl-started",
    tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
  });
  const cfg = /** @type {any} */ ({
    ok: true,
    config: {
      schemaVersion: 1,
      personas: [
        { persona: "backend", editableGlobs: ["lib/**"] },
        { persona: "frontend", editableGlobs: ["ui/**"] },
      ],
    },
  });

  // A planned file is allowed; a file outside the plan is denied by Rule 6.
  assert.equal(
    evaluateGuard({ tool_name: "write_file", path: "lib/service/user.mjs" }, state, cfg, { scope }).decision,
    "allow",
  );
  const outScope = evaluateGuard(
    { tool_name: "write_file", path: "lib/service/secret.mjs" }, state, cfg, { scope },
  );
  assert.equal(outScope.decision, "deny");
  assert.ok(outScope.reason?.includes("scope.md"), `reason: ${outScope.reason}`);

  // A test file the contract admits by glob is permitted (TDD floor).
  assert.equal(
    evaluateGuard({ tool_name: "write_file", path: "test/service/user.test.mjs" }, state, cfg, { scope }).decision,
    "allow",
  );
});

test("feature lane › continueApprovedFeature appends gate_transition trace event", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState();
    await writeTaskState(initial, fx.statePath);

    await continueApprovedFeature(initial, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });

    const lines = (await readFile(fx.transitionsPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[1]);
    assert.equal(entry.event, "gate_transition");
    assert.equal(entry.from, "spec-approved");
    assert.equal(entry.to, "impl-started");
    assert.equal(entry.lane, "feature");
    assert.equal(entry.taskId, "task-test-001");
    assert.equal(entry.mode, "sequential-shared-first");
    assert.deepEqual(entry.workstreams, {
      backend: 1,
      frontend: 1,
      shared: 1,
    });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature throws when gate is not spec-approved", async () => {
  const state = makeFeatureState({ workflowGate: "impl-started" });
  await assert.rejects(
    () => continueApprovedFeature(state),
    /Refusing to re-advance/,
  );
});

test("feature lane › continueApprovedFeature rejects plan-approved (HITL-2: unapproved spec cannot reach implementation)", async () => {
  const state = makeFeatureState({ workflowGate: "plan-approved" });
  await assert.rejects(
    () => continueApprovedFeature(state),
    /gate must be 'spec-approved'.*Refusing to re-advance/,
  );
});

test("feature lane › continueApprovedFeature returns absolute planPath", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState();
    await writeTaskState(initial, fx.statePath);

    const { planPath } = await continueApprovedFeature(initial, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });

    assert.equal(planPath, join(fx.dir, PLAN_PATH));
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature is idempotent-safe (re-advance throws)", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState();
    await writeTaskState(initial, fx.statePath);

    const { state: advanced } = await continueApprovedFeature(initial, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });

    await assert.rejects(
      () =>
        continueApprovedFeature(advanced, {
          repoRoot: fx.dir,
          statePath: fx.statePath,
          transitionsPath: fx.transitionsPath,
        }),
      /Refusing to re-advance/,
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature throws when spec metadata is missing", async () => {
  const fx = await makeFixture();
  try {
    const state = makeFeatureState({ artifactHashes: {} });
    await writeTaskState(state, fx.statePath);
    await assert.rejects(
      () =>
        continueApprovedFeature(state, {
          repoRoot: fx.dir,
          statePath: fx.statePath,
          transitionsPath: fx.transitionsPath,
          configPath: fx.configPath,
          specPath: fx.specPath,
        }),
      /missing spec artifact metadata/i,
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature writes fallback warning when specFiles are missing from state", async () => {
  const fx = await makeFixture();
  try {
    const state = makeFeatureState();
    await writeTaskState(state, fx.statePath);
    await continueApprovedFeature(state, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });
    const lines = (await readFile(fx.transitionsPath, "utf8")).trim().split("\n");
    const warn = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "warn_spec_files_fallback");
    assert.ok(warn, "expected warn_spec_files_fallback event");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature fails closed when fallback yields zero spec files", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      fx.specPath,
      ["# Spec", "", "## Summary", "- no files section"].join("\n"),
      "utf8",
    );
    const state = makeFeatureState();
    await writeTaskState(state, fx.statePath);

    await assert.rejects(
      () =>
        continueApprovedFeature(state, {
          repoRoot: fx.dir,
          statePath: fx.statePath,
          transitionsPath: fx.transitionsPath,
          configPath: fx.configPath,
          specPath: fx.specPath,
        }),
      /specFiles is empty after fallback/i,
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › continueApprovedFeature accepts spec-approved source gate", async () => {
  const fx = await makeFixture();
  try {
    const state = makeFeatureState({ workflowGate: "spec-approved" });
    await writeTaskState(state, fx.statePath);
    const result = await continueApprovedFeature(state, {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
      configPath: fx.configPath,
      specPath: fx.specPath,
    });
    assert.equal(result.gate, FEATURE_IMPL_STARTED);
    assert.equal(result.state.workflowGate, FEATURE_IMPL_STARTED);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › FO-8: config maxConcurrentAgents of 1 downgrades parallel dispatch to sequential", async () => {
  const parallelSpec = [
    "# Spec",
    "",
    "## Files that will change",
    "- lib/service/user.mjs",
    "- ui/components/button.mjs",
  ].join("\n");

  // Without a configured ceiling the same two-stack spec dispatches in parallel…
  const unbounded = await makeFixture();
  try {
    await writeFile(unbounded.specPath, parallelSpec, "utf8");
    const initial = makeFeatureState();
    await writeTaskState(initial, unbounded.statePath);
    const { mode } = await continueApprovedFeature(initial, {
      repoRoot: unbounded.dir,
      statePath: unbounded.statePath,
      transitionsPath: unbounded.transitionsPath,
      configPath: unbounded.configPath,
      specPath: unbounded.specPath,
    });
    assert.equal(mode, "parallel");
  } finally {
    await rm(unbounded.dir, { recursive: true, force: true });
  }

  // …but a ceiling of 1 reaches the partitioner and forbids concurrent dispatch.
  const bounded = await makeFixture();
  try {
    const raw = JSON.parse(await readFile(bounded.configPath, "utf8"));
    raw.maxConcurrentAgents = 1;
    await writeFile(bounded.configPath, JSON.stringify(raw, null, 2), "utf8");
    await writeFile(bounded.specPath, parallelSpec, "utf8");
    const initial = makeFeatureState();
    await writeTaskState(initial, bounded.statePath);
    const { mode } = await continueApprovedFeature(initial, {
      repoRoot: bounded.dir,
      statePath: bounded.statePath,
      transitionsPath: bounded.transitionsPath,
      configPath: bounded.configPath,
      specPath: bounded.specPath,
    });
    assert.equal(
      mode,
      "sequential-backend-first",
      "the configured ceiling must bound what the lane proposes (FO-8)",
    );
  } finally {
    await rm(bounded.dir, { recursive: true, force: true });
  }
});

test("feature lane › formatPlanAnnouncement includes plan path and confirmation prompt", () => {
  const msg = formatPlanAnnouncement("/repo/.devmate/session/plan.md");
  assert.ok(
    msg.includes("/repo/.devmate/session/plan.md"),
    "should include the plan path",
  );
  assert.ok(msg.includes("Review it"), "should prompt developer to review");
});

test("feature lane › PLAN_PATH constant matches expected relative path", () => {
  assert.equal(PLAN_PATH, ".devmate/session/plan.md");
});

// ---- E10-05: steering (revise-scope / re-plan) ----

/**
 * Write a valid scope-change note next to the fixture's task.json.
 * @param {string} statePath
 * @param {string} [taskId]
 */
async function writeScopeChangeNote(statePath, taskId = "task-test-001") {
  const stateDir = join(statePath, "..");
  await writeFile(
    join(stateDir, SCOPE_CHANGE_NOTE_FILENAME),
    JSON.stringify({
      taskId,
      note: "Replace the CSV export with JSON streaming.",
      capturedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

/**
 * Write valid critique evidence next to the fixture's task.json.
 * @param {string} statePath
 */
async function writeCritiqueEvidence(statePath) {
  const stateDir = join(statePath, "..");
  await writeFile(
    join(stateDir, "critique-result.json"),
    JSON.stringify({
      taskId: "task-test-001",
      mode: "critique",
      schemaVersion: 1,
      returnedAt: new Date().toISOString(),
      missingAcceptanceCriteria: [],
      missingTests: [],
      riskySequencing: [],
      unlistedFiles: [],
      backwardsCompatRisks: [],
      rollbackRisk: "low",
      verdict: "APPROVE_PLAN",
    }),
    "utf8",
  );
}

test("feature lane › steerFeature revise-scope re-enters the spec loop preserving taskId and completed workstreams", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState({
      workflowGate: FEATURE_IMPL_STARTED,
      currentStep: 6,
      specFiles: ["lib/service/user.mjs", "ui/components/button.mjs"],
    });
    await writeTaskState(initial, fx.statePath);
    await writeScopeChangeNote(fx.statePath);

    const { state: steered, gate, from } = await steerFeature(initial, "revise-scope", {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
    });

    assert.equal(gate, "spec-draft");
    assert.equal(from, FEATURE_IMPL_STARTED);
    assert.equal(steered.workflowGate, "spec-draft");
    assert.equal(steered.taskId, "task-test-001", "taskId preserved — never a restart");
    assert.deepEqual(
      /** @type {{ specFiles?: string[] }} */ (steered).specFiles,
      ["lib/service/user.mjs", "ui/components/button.mjs"],
      "completed workstream input (persisted spec file list) is not discarded",
    );
    assert.equal(steered.artifactHashes.spec, ".devmate/session/spec.md");
    assert.equal(steered.artifactHashes.specDigest, "deadbeef");
    assert.equal(steered.budget, initial.budget, "budget not reset");

    const raw = JSON.parse(await readFile(fx.statePath, "utf8"));
    assert.equal(raw.workflowGate, "spec-draft", "steered state persisted atomically");
    assert.equal(raw.taskId, "task-test-001");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › steerFeature re-plan re-enters planning and appends a gate_transition trace event", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState({ workflowGate: FEATURE_IMPL_STARTED });
    await writeTaskState(initial, fx.statePath);
    await writeCritiqueEvidence(fx.statePath);

    const { state: steered, gate } = await steerFeature(initial, "re-plan", {
      repoRoot: fx.dir,
      statePath: fx.statePath,
      transitionsPath: fx.transitionsPath,
    });

    assert.equal(gate, "plan-done");
    assert.equal(steered.taskId, "task-test-001");

    const lines = (await readFile(fx.transitionsPath, "utf8")).trim().split("\n");
    const entry = lines.map((line) => JSON.parse(line)).find((e) => e.event === "gate_transition");
    assert.ok(entry, "expected a gate_transition trace event");
    assert.equal(entry.from, FEATURE_IMPL_STARTED);
    assert.equal(entry.to, "plan-done");
    assert.equal(entry.lane, "feature");
    assert.equal(entry.taskId, "task-test-001");
    assert.equal(entry.steeringEvent, "re-plan");
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › steerFeature refuses revise-scope without the captured scope-change note", async () => {
  const fx = await makeFixture();
  try {
    const initial = makeFeatureState({ workflowGate: FEATURE_IMPL_STARTED });
    await writeTaskState(initial, fx.statePath);
    await assert.rejects(
      () =>
        steerFeature(initial, "revise-scope", {
          repoRoot: fx.dir,
          statePath: fx.statePath,
          transitionsPath: fx.transitionsPath,
        }),
      /scope-change note/,
    );
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("feature lane › steerFeature refuses to steer outside impl-started and rejects non-steering events", async () => {
  const preImpl = makeFeatureState();
  await assert.rejects(
    () => steerFeature(preImpl, "revise-scope"),
    /gate must be 'impl-started'/,
  );
  const atImpl = makeFeatureState({ workflowGate: FEATURE_IMPL_STARTED });
  await assert.rejects(
    () => steerFeature(atImpl, "complete"),
    /unsupported steering event/,
  );
  assert.deepEqual([...FEATURE_STEERING_EVENTS], ["revise-scope", "re-plan"]);
});
