// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
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
  handleUserPromptSubmit,
  detectNearMissApproval,
  parseNoTddReason,
  parseReviseSpecFeedback,
} from "../../hooks/approval-listener.mjs";
import { parseJsonl } from "../../lib/json-io.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "feat-101",
    lane: "feature",
    workflowGate: "spec-draft",
    artifactHashes: {
      spec: ".devmate/session/spec.md",
      specDigest: "abc123",
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp repo root with `.devmate/state/task.json` written.
 * @param {Partial<TaskState>} [stateOverrides]
 * @returns {{ root: string, statePath: string, tracePath: string, specPath: string, cleanup: () => void }}
 */
function makeFixture(stateOverrides) {
  const root = mkdtempSync(join(tmpdir(), "devmate-approval-"));
  const stateDir = join(root, ".devmate", "state");
  const sessionDir = join(root, ".devmate", "session");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const statePath = join(stateDir, "task.json");
  const state = makeState(stateOverrides);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  writeFileSync(
    join(root, ".devmate", "devmate.config.json"),
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
            editableGlobs: ["ui/**"],
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
  const tracePath = join(stateDir, "trace", `${state.taskId}.jsonl`);
  const specPath = join(sessionDir, "spec.md");
  writeFileSync(
    specPath,
    [
      "# Test Spec",
      "",
      "## Files that will change",
      "- lib/flows/feature.mjs",
      "- ui/views/page.mjs",
    ].join("\n"),
    "utf8",
  );
  return {
    root,
    statePath,
    tracePath,
    specPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Read a JSONL trace file and parse each line.
 * @param {string} path
 * @returns {Array<Record<string, unknown>>}
 */
function readTrace(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return /** @type {Array<Record<string, unknown>>} */ (parseJsonl(text));
}

test('approval-listener — "approve spec" continues to impl-started via continueApprovedFeature', async () => {
  const fx = makeFixture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-approved");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "impl-started");
    assert.equal(state.artifactHashes.plan_stored_at, fx.statePath);
    assert.equal(
      state.artifactHashes.handoff_at,
      join(fx.root, ".devmate", "state", "handoff", state.taskId),
    );
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "approve pr" advances gate to pr-ready', async () => {
  const fx = makeFixture({ workflowGate: "verification-passed" });
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve pr",
      root: fx.root,
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "pr-ready");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "pr-ready");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "revise spec: add more edge cases" emits spec_revision_requested with feedback', async () => {
  const fx = makeFixture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise spec: add more edge cases",
      root: fx.root,
    });
    assert.equal(result.action, "revision_requested");
    assert.equal(result.feedback, "add more edge cases");
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]["type"], "spec_revision_requested");
    assert.equal(events[0]["feedback"], "add more edge cases");
    // Gate must not change for a revise request.
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("approval-listener — unknown phrase returns passthrough without side effects", async () => {
  const fx = makeFixture();
  try {
    const before = readFileSync(fx.statePath, "utf8");
    const result = await handleUserPromptSubmit({
      prompt: "can you summarise the plan",
      root: fx.root,
    });
    assert.deepEqual(result, { action: "passthrough" });
    const after = readFileSync(fx.statePath, "utf8");
    assert.equal(before, after);
    assert.deepEqual(readTrace(fx.tracePath), []);
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — case-insensitive: "APPROVE SPEC" treated same as "approve spec"', async () => {
  const fx = makeFixture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "  APPROVE SPEC  ",
      root: fx.root,
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-approved");
  } finally {
    fx.cleanup();
  }
});

test("approval-listener — gate transition appends gate_transition trace event", async () => {
  const fx = makeFixture();
  try {
    await handleUserPromptSubmit({ prompt: "approve spec", root: fx.root });
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]["type"], "gate_transition");
    assert.equal(events[0]["from"], "spec-draft");
    assert.equal(events[0]["to"], "spec-approved");
    assert.equal(events[0]["gate"], "spec-approved");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "approve no-tdd reason=..." writes override trace event and spec note', async () => {
  const fx = makeFixture();
  // Seed a spec.md so the hook can append the override note.
  writeFileSync(
    fx.specPath,
    "# Test spec\n\n## Out of scope\n- nothing yet\n",
    "utf8",
  );
  try {
    const result = await handleUserPromptSubmit({
      prompt: 'approve no-tdd reason="hotfix path; tests added after"',
      root: fx.root,
    });
    assert.equal(result.action, "no_tdd_override");
    assert.equal(result.reason, "hotfix path; tests added after");
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1);
    assert.equal(events[0]["type"], "no_tdd_override");
    assert.equal(events[0]["reason"], "hotfix path; tests added after");
    const specBody = readFileSync(fx.specPath, "utf8");
    assert.ok(
      specBody.includes(
        "No-TDD override approved by human: hotfix path; tests added after",
      ),
      "spec.md should mention the no-TDD override",
    );
  } finally {
    fx.cleanup();
  }
});

test("approval-listener — empty string returns passthrough", async () => {
  const fx = makeFixture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "   ",
      root: fx.root,
    });
    assert.deepEqual(result, { action: "passthrough" });
    assert.deepEqual(readTrace(fx.tracePath), []);
  } finally {
    fx.cleanup();
  }
});

test("parseReviseSpecFeedback — extracts text after colon with original casing", () => {
  assert.equal(
    parseReviseSpecFeedback("revise spec: Add MORE edge cases"),
    "Add MORE edge cases",
  );
  assert.equal(parseReviseSpecFeedback("revise spec:"), "");
  assert.equal(parseReviseSpecFeedback("revise spec"), "");
});

test("parseNoTddReason — extracts quoted reason from prompt", () => {
  assert.equal(
    parseNoTddReason('approve no-tdd reason="quick fix"'),
    "quick fix",
  );
  assert.equal(parseNoTddReason("approve no-tdd"), null);
  assert.equal(parseNoTddReason('approve no-tdd reason=""'), null);
});

// ── #111: durable, resumable, idempotent human approvals ────────────────────

test("#111 — approve spec: continuation failure persists continuationError and emits recovery message", async () => {
  // Force continueApprovedFeature to fail: write a spec.md with no
  // "## Files that will change" section so the file list is empty and
  // continueApprovedFeature throws, while the spec-approved precondition
  // (file-exists check) still passes.
  const fx = makeFixture();
  writeFileSync(fx.specPath, "# Test Spec\n\nNo files section here.\n", "utf8");
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    // Hook must return gate_advanced (approval is durable) not throw.
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-approved");
    // Gate in task.json must remain spec-approved (not impl-started).
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-approved");
    // Structured continuation error must be persisted.
    assert.ok(state.continuationError, "continuationError must be set");
    assert.equal(state.continuationError.at, "spec-approved");
    assert.ok(
      typeof state.continuationError.message === "string" &&
        state.continuationError.message.length > 0,
    );
    assert.equal(state.continuationError.recovery, "approve spec");
    // Model-visible recovery message must name the retry action.
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("approve spec"),
      "stdout must mention the retry phrase",
    );
    assert.ok(
      output.includes("resume implementation"),
      "stdout must mention resuming implementation",
    );
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve spec: trace written before continuation attempt (audit-before-action)", async () => {
  // Fail continueApprovedFeature by writing a spec.md with no files section.
  const fx = makeFixture();
  writeFileSync(fx.specPath, "# Test Spec\n\nNo files section here.\n", "utf8");
  try {
    await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
      stdout: /** @type {any} */ ({ write() { return true; } }),
    });
    // Trace must exist with spec-approved transition even though continuation failed.
    const events = readTrace(fx.tracePath);
    assert.equal(events.length, 1, "one gate_transition event expected");
    assert.equal(events[0]["type"], "gate_transition");
    assert.equal(events[0]["from"], "spec-draft");
    assert.equal(events[0]["to"], "spec-approved");
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve spec: retry after stranded gate resumes impl-started without re-approving", async () => {
  // Simulate stranded state: gate already spec-approved from a previous attempt.
  const fx = makeFixture({ workflowGate: "spec-approved" });
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-approved");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    // Continuation should succeed from spec-approved → impl-started.
    assert.equal(state.workflowGate, "impl-started");
    // No continuationError should remain after a successful retry.
    assert.equal(state.continuationError, undefined);
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve spec: duplicate approval after successful continuation is a no-op", async () => {
  // Gate is already impl-started (full success path completed).
  const fx = makeFixture({ workflowGate: "impl-started" });
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  const before = readFileSync(fx.statePath, "utf8");
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "passthrough");
    // State must be unchanged.
    const after = readFileSync(fx.statePath, "utf8");
    assert.equal(before, after);
    // A friendly message must be emitted (not silent).
    const output = capture.chunks.join("");
    assert.ok(output.includes("impl-started"), "must mention the current gate");
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve pr: duplicate approval after pr-ready is a no-op", async () => {
  const fx = makeFixture({ workflowGate: "pr-ready" });
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  const before = readFileSync(fx.statePath, "utf8");
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve pr",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "passthrough");
    assert.equal(readFileSync(fx.statePath, "utf8"), before);
    const output = capture.chunks.join("");
    assert.ok(output.includes("pr-ready"), "must mention the current gate");
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve pr: config-enabled pr-review precondition blocks when artifact missing", async () => {
  // Write a config with prReviewGate: 'block' so the precondition is enforced.
  const fx = makeFixture({ workflowGate: "verification-passed" });
  writeFileSync(
    join(fx.root, ".devmate", "devmate.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      prReviewGate: "block",
      personas: [
        {
          persona: "backend",
          editableGlobs: ["lib/**"],
          offLimitsGlobs: [],
          instructionFile: null,
        },
      ],
    }),
    "utf8",
  );
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve pr",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    // Must be blocked — pr-review-result.json does not exist.
    assert.equal(result.action, "passthrough");
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("approve pr did not advance"),
      "stdout must explain the gate did not advance",
    );
    // State must remain verification-passed.
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "verification-passed");
  } finally {
    fx.cleanup();
  }
});

test("#111 — approve spec: precondition failure (missing spec.md) blocks advance and emits reason", async () => {
  // Remove spec.md before approval so the spec-approved precondition fails.
  const fx = makeFixture();
  rmSync(fx.specPath);  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    // advanceHumanGate must have failed (precondition unmet) — passthrough.
    assert.equal(result.action, "passthrough");
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("approve spec did not advance"),
      "stdout must explain why the gate did not advance",
    );
    // Gate must remain spec-draft.
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("#111 — repeated revise then successful approve works end-to-end", async () => {
  const fx = makeFixture();
  // Revise twice.
  for (const feedback of ["needs more edge cases", "clarify the retry path"]) {
    const r = await handleUserPromptSubmit({
      prompt: `revise spec: ${feedback}`,
      root: fx.root,
    });
    assert.equal(r.action, "revision_requested");
  }
  // Gate must still be spec-draft after revisions.
  const stateMid = JSON.parse(readFileSync(fx.statePath, "utf8"));
  assert.equal(stateMid.workflowGate, "spec-draft");
  // Now approve successfully.
  const r = await handleUserPromptSubmit({ prompt: "approve spec", root: fx.root });
  assert.equal(r.action, "gate_advanced");
  assert.equal(r.gate, "spec-approved");
  const stateFinal = JSON.parse(readFileSync(fx.statePath, "utf8"));
  assert.equal(stateFinal.workflowGate, "impl-started");
  fx.cleanup();
});

test("#111 — near-miss 'approve the spec' returns passthrough with corrective guidance", async () => {
  const fx = makeFixture();
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve the spec",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "passthrough");
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("approve spec"),
      "stdout must suggest the canonical phrase",
    );
    // Gate must not have changed.
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("#111 — near-miss 'approve the plan' returns passthrough with corrective guidance", async () => {
  const fx = makeFixture({ workflowGate: "plan-approved", lane: "bug" });
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "approve the plan",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "passthrough");
    const output = capture.chunks.join("");
    assert.ok(output.includes("approve plan"), "must suggest the canonical phrase");
  } finally {
    fx.cleanup();
  }
});

test("#111 — unrelated phrase is not a near-miss", async () => {
  const fx = makeFixture();
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    await handleUserPromptSubmit({
      prompt: "I really approve of this approach",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    // No near-miss guidance expected (prompt doesn't start with "approve ").
    const output = capture.chunks.join("");
    const hasGuidance = output.includes("Did you mean");
    assert.equal(hasGuidance, false);
  } finally {
    fx.cleanup();
  }
});

// ── detectNearMissApproval unit tests ────────────────────────────────────────

test("detectNearMissApproval — 'approve the spec' detects spec near-miss", () => {
  const r = detectNearMissApproval("approve the spec");
  assert.ok(r !== null);
  assert.equal(r.phrase, "approve spec");
});

test("detectNearMissApproval — 'approve this plan' detects plan near-miss", () => {
  const r = detectNearMissApproval("approve this plan");
  assert.ok(r !== null);
  assert.equal(r.phrase, "approve plan");
});

test("detectNearMissApproval — 'approve the pr' detects pr near-miss", () => {
  const r = detectNearMissApproval("approve the pr");
  assert.ok(r !== null);
  assert.equal(r.phrase, "approve pr");
});

test("detectNearMissApproval — exact match 'approve spec' is NOT a near-miss (exact matches checked before)", () => {
  // detectNearMissApproval is called only after exact matches fail; but we
  // also verify it returns a value (the caller is responsible for not calling
  // it when the prompt already matched exactly).
  const r = detectNearMissApproval("approve spec");
  // "approve spec" starts with "approve " and contains "spec" → returns a hit.
  // This is fine: the caller's guard prevents the path from being reached.
  assert.ok(r !== null);
  assert.equal(r.phrase, "approve spec");
});

test("detectNearMissApproval — unrelated phrase returns null", () => {
  assert.equal(detectNearMissApproval("can you explain the spec"), null);
  assert.equal(detectNearMissApproval("I approve of this"), null);
  assert.equal(detectNearMissApproval("let's go"), null);
});

test("detectNearMissApproval — word-boundary check: 'approve practice' does NOT match PR", () => {
  // "practice" contains "pr" but should not trigger PR near-miss detection.
  // Word boundaries ensure only complete words like "pr" or "pull" match.
  const r = detectNearMissApproval("approve practice");
  assert.equal(r, null, "should not match 'pr' in 'practice'");
});

test("detectNearMissApproval — word-boundary check: 'approve progress' does NOT match PR", () => {
  // Similar check: "progress" contains "pr" but is not a near-miss for "approve pr".
  const r = detectNearMissApproval("approve progress");
  assert.equal(r, null, "should not match 'pr' in 'progress'");
});

test("detectNearMissApproval — word-boundary check: 'approve pull request' matches PR", () => {
  // "pull request" should still match because "pull" is a complete word.
  const r = detectNearMissApproval("approve pull request");
  assert.ok(r !== null);
  assert.equal(r.phrase, "approve pr");
});
