// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  handleSubagentStart,
  handleSubagentStop,
} from "../../hooks/subagent-budget-guard.mjs";
import { parseJsonl } from "../../lib/json-io.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "feat-176",
    lane: "feature",
    workflowGate: "impl-started",
    // HITL-1: implementation-agent dispatches now require recorded spec metadata
    // to pass the lane-gated dispatch check; the concurrency fixtures seed it so
    // each concurrency/trace test exercises the budget path, not the new gate.
    artifactHashes: { spec: ".devmate/session/spec.md", specDigest: "abc123" },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * A minimal, parseable scope.md for the fixture's lane. `parseScope` only
 * accepts `- ` bullets under `## ` headings.
 * @param {string} lane
 * @returns {string}
 */
function scopeMd(lane) {
  return [
    "---",
    `lane: ${lane}`,
    "---",
    "# Scope",
    "",
    "## Allowed paths",
    "- src/main/foo.mjs",
    "",
    "## Allowed globs",
    "- **/*.test.mjs",
    "",
  ].join("\n");
}

/**
 * Seed a tmp repo root with task.json and devmate.config.json.
 *
 * #92: every lane's implementation dispatch — feature included — now requires a
 * scope.md, so the fixture seeds one by default: without it the dispatch gate
 * denies on the missing edit boundary and the concurrency/trace assertions below
 * would never be reached. Tests whose subject IS the missing contract opt out
 * with `scope: false`.
 * @param {{ state?: Partial<TaskState>, maxConcurrentAgents?: number, writeConfig?: boolean, scope?: boolean }} [opts]
 */
function makeFixture(opts) {
  const root = mkdtempSync(join(tmpdir(), "devmate-budget-guard-"));
  const stateDir = join(root, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "task.json");
  const state = makeState(opts?.state);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  if (opts?.scope !== false) {
    const sessionDir = join(root, ".devmate", "session", state.taskId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "scope.md"), scopeMd(String(state.lane)), "utf8");
  }

  if (opts?.writeConfig !== false) {
    const configPath = join(root, ".devmate", "devmate.config.json");
    const config = {
      schemaVersion: 1,
      maxConcurrentAgents: opts?.maxConcurrentAgents ?? 3,
      personas: [
        {
          persona: "frontend",
          editableGlobs: ["src/**/*.tsx"],
        },
        {
          persona: "backend",
          editableGlobs: ["src/main/**"],
        },
      ],
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  }

  const tracePath = join(stateDir, "trace", `${state.taskId}.jsonl`);
  return {
    root,
    statePath,
    tracePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {string} path
 * @returns {Array<Record<string, unknown>>}
 */
function readTrace(path) {
  if (!existsSync(path)) return [];
  return /** @type {Array<Record<string, unknown>>} */ (
    parseJsonl(readFileSync(path, "utf8"))
  );
}

/**
 * @param {string} path
 * @returns {TaskState}
 */
function readState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("subagent-budget-guard — DEFAULT_MAX_CONCURRENT_AGENTS is 3", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_AGENTS, 3);
});

test("subagent-budget-guard — first start → allowed, activeCount=1", async () => {
  const fx = makeFixture();
  try {
    const result = await handleSubagentStart({
      agentName: "frontend.agent",
      persona: "frontend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "allowed");
    assert.equal(result.activeCount, 1);
    assert.equal(readState(fx.statePath).activeSubagents, 1);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — second start → allowed, activeCount=2", async () => {
  const fx = makeFixture({ state: { activeSubagents: 1 } });
  try {
    const result = await handleSubagentStart({
      agentName: "backend.agent",
      persona: "backend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "allowed");
    assert.equal(result.activeCount, 2);
    assert.equal(readState(fx.statePath).activeSubagents, 2);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — third start at maxConcurrentAgents=3 → allowed, activeCount=3", async () => {
  const fx = makeFixture({
    state: { activeSubagents: 2 },
    maxConcurrentAgents: 3,
  });
  try {
    const result = await handleSubagentStart({
      agentName: "editor.agent",
      persona: "editor",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "allowed");
    assert.equal(result.activeCount, 3);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — fourth start at maxConcurrentAgents=3 → denied", async () => {
  const fx = makeFixture({
    state: { activeSubagents: 3 },
    maxConcurrentAgents: 3,
  });
  try {
    const result = await handleSubagentStart({
      agentName: "frontend.agent",
      persona: "frontend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.equal(result.activeCount, 3);
    assert.match(String(result.reason), /maxConcurrentAgents \(3\) reached/);
    // State should be unchanged on deny.
    assert.equal(readState(fx.statePath).activeSubagents, 3);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — stop decrements count, activeCount=2 after first stop", async () => {
  const fx = makeFixture({ state: { activeSubagents: 3 } });
  try {
    const result = await handleSubagentStop({
      agentName: "frontend.agent",
      persona: "frontend",
      durationMs: 1500,
      repoRoot: fx.root,
    });
    assert.equal(result.activeCount, 2);
    assert.equal(readState(fx.statePath).activeSubagents, 2);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — stop when activeCount=0 does not go negative", async () => {
  const fx = makeFixture({ state: { activeSubagents: 0 } });
  try {
    const result = await handleSubagentStop({
      agentName: "frontend.agent",
      persona: "frontend",
      durationMs: 500,
      repoRoot: fx.root,
    });
    assert.equal(result.activeCount, 0);
    assert.equal(readState(fx.statePath).activeSubagents, 0);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — start appends subagent_start trace event", async () => {
  const fx = makeFixture();
  try {
    await handleSubagentStart({
      agentName: "frontend.agent",
      persona: "frontend",
      repoRoot: fx.root,
    });
    const trace = readTrace(fx.tracePath);
    assert.equal(trace.length, 1);
    assert.equal(trace[0]["type"], "subagent_start");
    assert.equal(trace[0]["agentName"], "frontend.agent");
    assert.equal(trace[0]["persona"], "frontend");
    assert.equal(trace[0]["activeCount"], 1);
    assert.equal(trace[0]["taskId"], "feat-176");
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — stop appends subagent_complete trace event with durationMs", async () => {
  const fx = makeFixture({ state: { activeSubagents: 2 } });
  try {
    await handleSubagentStop({
      agentName: "backend.agent",
      persona: "backend",
      durationMs: 4200,
      repoRoot: fx.root,
    });
    const trace = readTrace(fx.tracePath);
    assert.equal(trace.length, 1);
    assert.equal(trace[0]["type"], "subagent_complete");
    assert.equal(trace[0]["agentName"], "backend.agent");
    assert.equal(trace[0]["persona"], "backend");
    assert.equal(trace[0]["durationMs"], 4200);
    assert.equal(trace[0]["activeCount"], 1);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — consumer override maxConcurrentAgents=1 → second start denied", async () => {
  const fx = makeFixture({
    state: { activeSubagents: 1 },
    maxConcurrentAgents: 1,
  });
  try {
    const result = await handleSubagentStart({
      agentName: "backend.agent",
      persona: "backend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /maxConcurrentAgents \(1\) reached/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — missing devmate.config.json falls back to default cap 3", async () => {
  const fx = makeFixture({ state: { activeSubagents: 3 }, writeConfig: false });
  try {
    // With default cap 3 and current 3, a fourth start should be denied.
    const result = await handleSubagentStart({
      agentName: "frontend.agent",
      persona: "frontend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /maxConcurrentAgents \(3\) reached/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — missing task.json fails OPEN (pre-spec) at count 0", async () => {
  // The pre-spec analysis phase (discovery -> tech-design -> grill -> plan)
  // runs before init-task-state creates task.json. Denying here forced that
  // work inline; the guard must fail open so delegation can happen.
  const root = mkdtempSync(join(tmpdir(), "devmate-budget-guard-open-"));
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  try {
    const result = await handleSubagentStart({
      agentName: "discovery.agent",
      persona: "discovery",
      repoRoot: root,
    });
    assert.equal(result.decision, "allowed");
    assert.equal(result.activeCount, 0);
    // No trace event pre-task. There is no real taskId to file it under — the
    // old code minted "unknown" (in production; this test used to inject an id
    // no host sends), creating a junk file no reader consults. The dispatch
    // floor reads the REAL task's trace via an explicit --trace path, so it
    // never saw these events anyway; it fails closed on a missing file.
    const traceDir = join(root, ".devmate", "state", "trace");
    const written = existsSync(traceDir) ? readdirSync(traceDir) : [];
    assert.deepEqual(written, [], "pre-task dispatch must write no trace file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent-budget-guard — malformed task.json still fails CLOSED (denied)", async () => {
  const root = mkdtempSync(join(tmpdir(), "devmate-budget-guard-bad-"));
  const stateDir = join(root, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "task.json"), "{ not valid json", "utf8");
  try {
    const result = await handleSubagentStart({
      agentName: "discovery.agent",
      persona: "discovery",
      repoRoot: root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /task\.json unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HITL-1: lane-gated implementation dispatch (SubagentStart layer).
// ---------------------------------------------------------------------------

/**
 * Write a scope.md for a task under a repo root.
 * @param {string} root
 * @param {string} taskId
 * @param {string} content
 */
function seedScope(root, taskId, content) {
  const dir = join(root, ".devmate", "session", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scope.md"), content, "utf8");
}

/**
 * Write a diagnosis.json under a repo root.
 * @param {string} root
 * @param {unknown} obj
 */
function seedDiagnosis(root, obj) {
  writeFileSync(
    join(root, ".devmate", "state", "diagnosis.json"),
    JSON.stringify(obj),
    "utf8",
  );
}

const VALID_SCOPE = "---\nlane: bug\n---\n# Scope\n\n## Allowed paths\n- src/main/foo.mjs\n";
const VALID_DIAGNOSIS = {
  bugScope: "backend",
  suspectedLayer: "service",
  reproCommand: "npm test",
  fixerRecommendation: "fix null check",
  // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
  // @diagnose has no edit tool and never could write the scope.md its own
  // prompt asked it for. A diagnosis without it is invalid, and an invalid
  // diagnosis is treated exactly like a missing one (fail-closed).
  allowedPaths: ["src/main/foo.mjs"],
  allowedGlobs: [],
  taskId: "feat-176",
  schemaVersion: 1,
};

test("subagent-budget-guard — fullstack denied when task.json missing (init-task-state)", async () => {
  const root = mkdtempSync(join(tmpdir(), "devmate-budget-guard-impl-"));
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "frontend",
      repoRoot: root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /init-task-state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent-budget-guard — persona wrappers (backend/frontend/editor) gated like fullstack on missing task.json", async () => {
  for (const [agentName, persona] of [
    ["backend.agent", "backend"],
    ["frontend.agent", "frontend"],
    ["editor.agent", "editor"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "devmate-budget-guard-impl-"));
    mkdirSync(join(root, ".devmate", "state"), { recursive: true });
    try {
      const result = await handleSubagentStart({ agentName, persona, repoRoot: root });
      assert.equal(result.decision, "denied", `${agentName} should be denied`);
      assert.match(String(result.reason), /init-task-state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("subagent-budget-guard — fullstack denied when gate is not impl-started", async () => {
  const fx = makeFixture({ state: { workflowGate: "plan-approved" } });
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "frontend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /impl-started/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — feature fullstack denied without spec metadata", async () => {
  const fx = makeFixture({ state: { artifactHashes: {} } });
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "frontend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /spec artifact metadata/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — bug fullstack denied without diagnosis.json", async () => {
  const fx = makeFixture({ state: { lane: "bug", artifactHashes: {} } });
  seedScope(fx.root, "feat-176", VALID_SCOPE);
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "backend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /diagnosis\.json/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — bug fullstack denied without scope.md", async () => {
  // The missing edit boundary IS the subject here, so opt out of the fixture's
  // default scope.md.
  const fx = makeFixture({ state: { lane: "bug", artifactHashes: {} }, scope: false });
  seedDiagnosis(fx.root, VALID_DIAGNOSIS);
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "backend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "denied");
    assert.match(String(result.reason), /scope\.md/);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — bug fullstack allowed with valid diagnosis and scope", async () => {
  const fx = makeFixture({ state: { lane: "bug", artifactHashes: {} } });
  seedScope(fx.root, "feat-176", VALID_SCOPE);
  seedDiagnosis(fx.root, VALID_DIAGNOSIS);
  try {
    const result = await handleSubagentStart({
      agentName: "fullstack",
      persona: "backend",
      repoRoot: fx.root,
    });
    assert.equal(result.decision, "allowed");
    assert.equal(result.activeCount, 1);
  } finally {
    fx.cleanup();
  }
});

test("subagent-budget-guard — chore editor denied without scope.md, allowed with it", async () => {
  // The missing edit boundary IS the subject of the first half, so opt out of
  // the fixture's default scope.md.
  const denied = makeFixture({ state: { lane: "chore", artifactHashes: {} }, scope: false });
  try {
    const r1 = await handleSubagentStart({
      agentName: "editor.agent",
      persona: "editor",
      repoRoot: denied.root,
    });
    assert.equal(r1.decision, "denied");
    assert.match(String(r1.reason), /scope\.md/);
  } finally {
    denied.cleanup();
  }

  const allowed = makeFixture({ state: { lane: "chore", artifactHashes: {} } });
  seedScope(allowed.root, "feat-176", VALID_SCOPE);
  try {
    const r2 = await handleSubagentStart({
      agentName: "editor.agent",
      persona: "editor",
      repoRoot: allowed.root,
    });
    assert.equal(r2.decision, "allowed");
  } finally {
    allowed.cleanup();
  }
});
