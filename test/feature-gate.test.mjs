// @ts-check

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { handleUserPromptSubmit } from "../hooks/approval-listener.mjs";
import { writeTaskState } from "../lib/task-state.mjs";
import {
  assertFullstackDispatchAllowed,
} from "../lib/workflow/orchestrator.mjs";
import {
  continueApprovedFeature,
  FEATURE_IMPL_STARTED,
  SPEC_PATH,
} from "../lib/workflow/lanes/feature.mjs";

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides = {}) {
  return {
    taskId: "feat-204",
    lane: "feature",
    workflowGate: "spec-draft",
    artifactHashes: {
      spec: ".devmate/session/spec.md",
      specDigest: "digest-204",
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * @param {{ filesSection?: string[], stateOverrides?: Partial<TaskState> }} [opts]
 * @returns {{ root: string, statePath: string, transitionsPath: string, specPath: string, cleanup: () => void }}
 */
function makeWorkspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "devmate-feature-gate-"));
  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  mkdirSync(resolve(root, ".devmate", "session"), { recursive: true });

  const filesSection =
    opts.filesSection ?? ["lib/feature/flow.mjs", "ui/feature/panel.mjs", "shared/schema.json"];

  writeFileSync(
    resolve(root, SPEC_PATH),
    [
      "# Spec",
      "",
      "## Files that will change",
      ...filesSection.map((file) => `- ${file}`),
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    resolve(root, ".devmate", "devmate.config.json"),
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
            editableGlobs: ["ui/**", "web/**"],
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

  const statePath = resolve(root, ".devmate", "state", "task.json");
  const state = makeState(opts.stateOverrides);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  return {
    root,
    statePath,
    transitionsPath: resolve(root, ".devmate", "state", "transitions.jsonl"),
    specPath: resolve(root, SPEC_PATH),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("feature-gate e2e / approve spec moves state to impl-started and records partition evidence", async () => {
  const ws = makeWorkspace();
  try {
    const result = await handleUserPromptSubmit({ prompt: "approve spec", root: ws.root });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-approved");

    const state = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(state.workflowGate, FEATURE_IMPL_STARTED);

    const transitionLines = readFileSync(ws.transitionsPath, "utf8").trim().split("\n");
    const transitionEvents = transitionLines.map((line) => JSON.parse(line));
    const gateEvent = transitionEvents.find((entry) => entry.event === "gate_transition");
    assert.ok(gateEvent, "expected gate_transition event in transitions log");
    assert.equal(gateEvent.mode, "sequential-shared-first");
    assert.ok(gateEvent.workstreams.backend >= 1);
    assert.ok(gateEvent.workstreams.frontend >= 1);
  } finally {
    ws.cleanup();
  }
});

test("feature-gate negative / fullstack dispatch blocked before approval", () => {
  const verdict = assertFullstackDispatchAllowed(
    makeState({ workflowGate: "plan-approved" }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /impl-started/i);
});

test("feature-gate negative / continueApprovedFeature throws outside allowed source gates", async () => {
  const ws = makeWorkspace({ stateOverrides: { workflowGate: "impl-started" } });
  try {
    const state = makeState({ workflowGate: "impl-started" });
    await writeTaskState(state, ws.statePath);
    await assert.rejects(
      () =>
        continueApprovedFeature(state, {
          repoRoot: ws.root,
          statePath: ws.statePath,
          transitionsPath: ws.transitionsPath,
          specPath: ws.specPath,
        }),
      /Refusing to re-advance/,
    );
  } finally {
    ws.cleanup();
  }
});

test("feature-gate regression / partition is stable for the same spec input", async () => {
  const ws1 = makeWorkspace();
  const ws2 = makeWorkspace();
  try {
    const state1 = makeState({ workflowGate: "spec-approved" });
    const state2 = makeState({ workflowGate: "spec-approved" });
    await writeTaskState(state1, ws1.statePath);
    await writeTaskState(state2, ws2.statePath);

    const first = await continueApprovedFeature(state1, {
      repoRoot: ws1.root,
      statePath: ws1.statePath,
      transitionsPath: ws1.transitionsPath,
      specPath: ws1.specPath,
    });
    const second = await continueApprovedFeature(state2, {
      repoRoot: ws2.root,
      statePath: ws2.statePath,
      transitionsPath: ws2.transitionsPath,
      specPath: ws2.specPath,
    });

    assert.equal(first.mode, second.mode);
    assert.deepEqual(first.workstreams, second.workstreams);
  } finally {
    ws1.cleanup();
    ws2.cleanup();
  }
});

test("feature-gate warn fallback / missing state.specFiles emits warn_spec_files_fallback", async () => {
  const ws = makeWorkspace({ stateOverrides: { workflowGate: "spec-approved" } });
  try {
    const state = makeState({ workflowGate: "spec-approved" });
    await writeTaskState(state, ws.statePath);
    await continueApprovedFeature(state, {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      specPath: ws.specPath,
    });

    const events = readFileSync(ws.transitionsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const warnEvent = events.find((entry) => entry.event === "warn_spec_files_fallback");
    assert.ok(warnEvent, "expected fallback warning event");
  } finally {
    ws.cleanup();
  }
});
