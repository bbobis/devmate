// @ts-check
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getDependencyGate } from "../../lib/dependency-gates.mjs";
import { main } from "../../scripts/gatectl.mjs";
import { parseJsonl } from "../../lib/json-io.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "test-task",
    lane: "feature",
    workflowGate: "plan-approved",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp dir, write task.json into its .devmate/state/ subdirectory,
 * change CWD into it, and return a cleanup function that restores CWD.
 * @param {Partial<TaskState>} [stateOverrides]
 * @returns {{ dir: string, cleanup: () => void }}
 */
function makeFixture(stateOverrides) {
  const prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "devmate-gatectl-"));
  const stateDir = join(dir, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const taskPath = join(stateDir, "task.json");
  writeFileSync(
    taskPath,
    JSON.stringify(makeState(stateOverrides), null, 2),
    "utf8",
  );
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * HITL-2: state overrides for a feature task legally positioned to start
 * implementation — spec approved and spec artifacts recorded.
 * @returns {Partial<TaskState>}
 */
function specApprovedOverrides() {
  return {
    workflowGate: "spec-approved",
    artifactHashes: { spec: ".devmate/session/spec.md", specDigest: "gatectl-digest" },
  };
}

test('gatectl main() — ["workflow", "set", "start-impl"] on spec-approved feature state → returns 0 and new gate is impl-started', async () => {
  const { dir, cleanup } = makeFixture(specApprovedOverrides());
  try {
    const code = await main(["workflow", "set", "start-impl"]);
    assert.equal(code, 0);
    const raw = readFileSync(
      join(dir, ".devmate", "state", "task.json"),
      "utf8",
    );
    const state = /** @type {TaskState} */ (JSON.parse(raw));
    assert.equal(state.workflowGate, "impl-started");
  } finally {
    cleanup();
  }
});

test('gatectl main() — ["workflow", "set", "start-impl"] on plan-approved FEATURE state → returns 1 (HITL-2: bypass edge removed)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const code = await main(["workflow", "set", "start-impl"]);
    assert.equal(code, 1);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "plan-approved", "gate must not move");
  } finally {
    cleanup();
  }
});

test('gatectl main() — ["workflow", "set", "draft-spec"] on plan-approved feature state with spec.md → returns 0, gate is spec-draft', async () => {
  const { dir, cleanup } = makeFixture();
  writeSessionSpec(dir);
  try {
    const code = await main(["workflow", "set", "draft-spec"]);
    assert.equal(code, 0);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    cleanup();
  }
});

test('gatectl main() — ["workflow", "set", "draft-spec"] without spec.md → returns 1 (nothing to review)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const code = await main(["workflow", "set", "draft-spec"]);
    assert.equal(code, 1);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "plan-approved", "gate must not move");
  } finally {
    cleanup();
  }
});

test('gatectl main() — ["dependency", "set", "backend-unit-pass", "pass"] → returns 0 and entry exists', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const code = await main(["dependency", "set", "backend-unit-pass", "pass"]);
    assert.equal(code, 0);
    const gatePath = join(dir, ".devmate", "state", "gates.json");
    const entry = getDependencyGate("backend-unit-pass", gatePath);
    assert.ok(entry !== null, "entry should exist");
    assert.equal(entry?.status, "pass");
  } finally {
    cleanup();
  }
});

test("gatectl main() — unknown subcommand → returns 1", async () => {
  const code = await main(["not-a-subcommand"]);
  assert.equal(code, 1);
});

test('gatectl main() — deprecated alias set-dependency-gate → stderr contains "deprecated", function still succeeds', async () => {
  // Use backend-unit-pass (no prerequisites) so the order-gate does not block it.
  const { cleanup } = makeFixture();
  const stderrChunks = /** @type {string[]} */ ([]);
  const origWrite = process.stderr.write.bind(process.stderr);
  // @ts-ignore patching stderr for test capture
  process.stderr.write = (/** @type {string} */ chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await main([
      "set-dependency-gate",
      "backend-unit-pass",
      "pass",
    ]);
    const stderrOutput = stderrChunks.join("");
    assert.ok(
      stderrOutput.toLowerCase().includes("deprecated"),
      "should warn about deprecation",
    );
    assert.equal(code, 0, "should succeed with a valid name + status");
  } finally {
    // @ts-ignore restoring stderr
    process.stderr.write = origWrite;
    cleanup();
  }
});

test('gatectl main() — deprecated alias set-workflow-gate → stderr contains "deprecated"', async () => {
  const { cleanup } = makeFixture(specApprovedOverrides());
  const stderrChunks = /** @type {string[]} */ ([]);
  const origWrite = process.stderr.write.bind(process.stderr);
  // @ts-ignore patching stderr for test capture
  process.stderr.write = (/** @type {string} */ chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await main(["set-workflow-gate", "start-impl"]);
    const stderrOutput = stderrChunks.join("");
    assert.ok(
      stderrOutput.toLowerCase().includes("deprecated"),
      "should warn about deprecation",
    );
    assert.equal(code, 0, "workflow set should succeed when task.json exists");
  } finally {
    // @ts-ignore restoring stderr
    process.stderr.write = origWrite;
    cleanup();
  }
});

test('gatectl main() — "dependency" with unknown action → returns 1', async () => {
  const code = await main(["dependency", "bogus-action"]);
  assert.equal(code, 1);
});

test('gatectl main() — "dependency" "get" with no name → returns 1', async () => {
  const code = await main(["dependency", "get"]);
  assert.equal(code, 1);
});

test('gatectl main() — "dependency" "list" → returns 0', async () => {
  const code = await main(["dependency", "list"]);
  assert.equal(code, 0);
});

test('gatectl main() — "workflow" "set" with no event → returns 1', async () => {
  const code = await main(["workflow", "set"]);
  assert.equal(code, 1);
});

test('gatectl main() — "workflow" "set" illegal event → returns 1', async () => {
  const { cleanup } = makeFixture();
  try {
    const code = await main(["workflow", "set", "not-a-real-event"]);
    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

// ── E10-03: human-gate transitions require --actor + --evidence ─────────────

/**
 * Read the JSONL trace for the fixture task, parsing each line.
 * @param {string} dir Fixture root.
 * @returns {Array<Record<string, unknown>>}
 */
function readFixtureTrace(dir) {
  const tracePath = join(dir, ".devmate", "state", "trace", "test-task.jsonl");
  let text;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return [];
  }
  return /** @type {Record<string, unknown>[]} */ (parseJsonl(text));
}

/**
 * Write the session spec.md the spec-approved precondition requires.
 * @param {string} dir Fixture root.
 * @returns {void}
 */
function writeSessionSpec(dir) {
  const sessionDir = join(dir, ".devmate", "session");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "spec.md"), "# Spec\n", "utf8");
}

test('gatectl main() — "workflow approve spec-approved" without --actor/--evidence → returns 1, gate unchanged', async () => {
  const { dir, cleanup } = makeFixture({ workflowGate: "spec-draft" });
  writeSessionSpec(dir);
  try {
    const code = await main(["workflow", "approve", "spec-approved"]);
    assert.equal(code, 1);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "spec-draft");
    assert.deepEqual(readFixtureTrace(dir), []);
  } finally {
    cleanup();
  }
});

test('gatectl main() — "workflow approve spec-approved" with actor + evidence → returns 0, persists gate, writes audited trace event', async () => {
  const { dir, cleanup } = makeFixture({ workflowGate: "spec-draft" });
  writeSessionSpec(dir);
  try {
    const code = await main([
      "workflow",
      "approve",
      "spec-approved",
      "--actor",
      "orchestrator",
      "--evidence",
      "yes, looks good — ship it",
    ]);
    assert.equal(code, 0);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "spec-approved");
    const events = readFixtureTrace(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0]["type"], "gate_transition");
    assert.equal(events[0]["from"], "spec-draft");
    assert.equal(events[0]["to"], "spec-approved");
    assert.equal(events[0]["actor"], "orchestrator");
    assert.equal(events[0]["evidence"], "yes, looks good — ship it");
  } finally {
    cleanup();
  }
});

test('gatectl main() — "workflow approve" rejects a non-human gate target → returns 1', async () => {
  const { cleanup } = makeFixture({ workflowGate: "plan-approved" });
  try {
    const code = await main([
      "workflow",
      "approve",
      "impl-started",
      "--actor",
      "orchestrator",
      "--evidence",
      "go",
    ]);
    assert.equal(code, 1);
  } finally {
    cleanup();
  }
});

test('gatectl main() — "workflow approve pr-ready" on an illegal edge (from spec-draft) → returns 1', async () => {
  const { dir, cleanup } = makeFixture({ workflowGate: "spec-draft" });
  try {
    const code = await main([
      "workflow",
      "approve",
      "pr-ready",
      "--actor",
      "orchestrator",
      "--evidence",
      "approved",
    ]);
    assert.equal(code, 1);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    cleanup();
  }
});

test('gatectl main() — "workflow set mark-pr-ready" without --actor/--evidence → returns 1, gate unchanged', async () => {
  const { dir, cleanup } = makeFixture({ workflowGate: "verification-passed" });
  try {
    const code = await main(["workflow", "set", "mark-pr-ready"]);
    assert.equal(code, 1);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "verification-passed");
    assert.deepEqual(readFixtureTrace(dir), []);
  } finally {
    cleanup();
  }
});

test('gatectl main() — "workflow set mark-pr-ready" with actor + evidence → returns 0 and writes audited trace event', async () => {
  const { dir, cleanup } = makeFixture({ workflowGate: "verification-passed" });
  try {
    const code = await main([
      "workflow",
      "set",
      "mark-pr-ready",
      "--actor",
      "orchestrator",
      "--evidence",
      "PR approved, merge it",
    ]);
    assert.equal(code, 0);
    const state = JSON.parse(
      readFileSync(join(dir, ".devmate", "state", "task.json"), "utf8"),
    );
    assert.equal(state.workflowGate, "pr-ready");
    const events = readFixtureTrace(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0]["type"], "gate_transition");
    assert.equal(events[0]["actor"], "orchestrator");
    assert.equal(events[0]["evidence"], "PR approved, merge it");
  } finally {
    cleanup();
  }
});
