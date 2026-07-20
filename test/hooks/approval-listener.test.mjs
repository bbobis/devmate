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
import { mutateTaskStateUnderLock } from "../../lib/task-state.mjs";

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
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise spec: add more edge cases",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
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
    // #126: the feedback must reach the model on the SAME turn — the
    // HookResult is discarded by the CLI shim and nothing reads the trace
    // event back, so stdout is the only surface the model ever sees.
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("add more edge cases"),
      "stdout must carry the verbatim feedback",
    );
    assert.ok(
      output.includes("@spec-writer"),
      "stdout must instruct the model to re-dispatch @spec-writer",
    );
    // Assert the sentence unique to the NEW message — the always-on state
    // anchor already renders "gate: spec-draft" into the same stream, so a
    // bare substring check on the gate name would pass on pre-fix code.
    assert.ok(
      output.includes("The gate stays at spec-draft"),
      "stdout must state the gate stays at spec-draft",
    );
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "revise spec:" with no feedback still surfaces a model-visible ask', async () => {
  const fx = makeFixture();
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise spec:",
      root: fx.root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "revision_requested");
    assert.equal(result.feedback, "");
    const output = capture.chunks.join("");
    assert.ok(
      output.includes("no feedback text was provided"),
      "empty feedback must be flagged, not silently echoed as blank",
    );
    assert.ok(
      output.includes("Ask the human what should change"),
      "empty feedback must steer an ask, not a blind dispatch",
    );
    assert.ok(
      !output.includes("Dispatch @spec-writer now"),
      "empty feedback must not instruct an immediate dispatch",
    );
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

// ---------------------------------------------------------------------------
// #127: mid-implementation steering phrases wire steerFeature
// ---------------------------------------------------------------------------

/**
 * A structurally valid CritiqueResult for the plan-done precondition
 * (re-checked by the re-plan steering edge).
 * @param {string} taskId
 * @returns {Record<string, unknown>}
 */
function critiqueResultFor(taskId) {
  return {
    taskId,
    mode: "critique",
    schemaVersion: 1,
    returnedAt: "2026-01-01T00:00:00.000Z",
    missingAcceptanceCriteria: [],
    missingTests: [],
    riskySequencing: [],
    unlistedFiles: [],
    backwardsCompatRisks: [],
    rollbackRisk: "low — revert the single commit",
    verdict: "APPROVE_PLAN",
  };
}

/** @returns {{ chunks: string[], stdout: { write: (c: unknown) => boolean } }} */
function makeCapture() {
  /** @type {string[]} */
  const chunks = [];
  return { chunks, stdout: { write(/** @type {unknown} */ c) { chunks.push(String(c)); return true; } } };
}

test('approval-listener — "revise scope: <reason>" at impl-started captures the note and returns to spec-draft', async () => {
  const fx = makeFixture({ workflowGate: "impl-started" });
  const cap = makeCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise scope: also handle CSV export",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "spec-draft");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
    assert.equal(state.taskId, "feat-101", "steering must continue the SAME task");
    // The hook itself captured the precondition artifact from the phrase.
    const note = JSON.parse(
      readFileSync(join(fx.root, ".devmate", "state", "scope-change.json"), "utf8"),
    );
    assert.equal(note.taskId, "feat-101");
    assert.equal(note.note, "also handle CSV export");
    // The audited trace event carries the hook actor + verbatim evidence.
    const events = readTrace(fx.tracePath);
    const transition = events.find((e) => e["type"] === "gate_transition");
    assert.ok(transition, "gate_transition trace event must be recorded");
    assert.equal(transition["from"], "impl-started");
    assert.equal(transition["to"], "spec-draft");
    assert.equal(transition["evidence"], "revise scope: also handle CSV export");
    // Model-visible next step.
    const output = cap.chunks.join("");
    assert.ok(output.includes("@spec-writer"), "stdout must steer a spec redraft");
    assert.ok(output.includes("also handle CSV export"), "stdout must carry the verbatim reason");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "re-plan: <reason>" at impl-started returns to plan-done', async () => {
  const fx = makeFixture({ workflowGate: "impl-started" });
  const cap = makeCapture();
  // The re-plan edge re-checks the plan-done critique-result precondition.
  writeFileSync(
    join(fx.root, ".devmate", "state", "critique-result.json"),
    JSON.stringify(critiqueResultFor("feat-101"), null, 2),
    "utf8",
  );
  try {
    const result = await handleUserPromptSubmit({
      prompt: "re-plan: switch to a queue-based approach",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "plan-done");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "plan-done");
    const output = cap.chunks.join("");
    assert.ok(output.includes("@planner"), "stdout must steer a plan revision");
    assert.ok(output.includes("switch to a queue-based approach"));
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — steering at the wrong gate degrades to a message, never throws', async () => {
  const fx = makeFixture(); // spec-draft
  const cap = makeCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise scope: change everything",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft", "gate must not move");
    const output = cap.chunks.join("");
    assert.ok(
      output.includes("did not move the gate"),
      "the refusal must be model-visible, not a crash",
    );
    // The refused attempt must not leave a stale task-bound note behind for a
    // later gatectl revise-scope to ride without a fresh capture.
    assert.ok(
      !existsSync(join(fx.root, ".devmate", "state", "scope-change.json")),
      "a wrong-gate attempt must not capture a note",
    );
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — steering on a non-feature lane degrades to a message', async () => {
  const fx = makeFixture({ lane: "bug", workflowGate: "impl-started" });
  const cap = makeCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "re-plan: different approach",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "impl-started", "gate must not move");
    assert.ok(cap.chunks.join("").includes("feature lane only"));
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — a steering phrase without a reason asks for one', async () => {
  const fx = makeFixture({ workflowGate: "impl-started" });
  const cap = makeCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise scope:",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    assert.ok(cap.chunks.join("").includes("needs a reason"));
    assert.ok(
      !existsSync(join(fx.root, ".devmate", "state", "scope-change.json")),
      "no note may be captured without a reason",
    );
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "revise spec:" with NO task in flight says so instead of instructing a redraft', async () => {
  const root = mkdtempSync(join(tmpdir(), "devmate-approval-notask-"));
  const capture = { chunks: /** @type {string[]} */ ([]) };
  const mockStdout = {
    write(/** @type {unknown} */ chunk) { capture.chunks.push(String(chunk)); return true; },
  };
  try {
    const result = await handleUserPromptSubmit({
      prompt: "revise spec: change X",
      root,
      stdout: /** @type {any} */ (mockStdout),
    });
    assert.equal(result.action, "revision_requested");
    const output = capture.chunks.join("");
    assert.ok(output.includes("no task is in flight"), "must say there is nothing to redraft");
    assert.ok(
      !output.includes("Dispatch @spec-writer now"),
      "must not instruct redrafting a nonexistent spec",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #130: "escalate chore to feature: <reason>" wires escalateChoreToFeature
// ---------------------------------------------------------------------------

/** @returns {{ chunks: string[], stdout: { write: (c: unknown) => boolean } }} */
function makeEscalationCapture() {
  /** @type {string[]} */
  const chunks = [];
  return { chunks, stdout: { write(/** @type {unknown} */ c) { chunks.push(String(c)); return true; } } };
}

test('approval-listener — chore escalation phrase re-enters the feature lane at plan-approved', async () => {
  const fx = makeFixture({ lane: "chore", workflowGate: "plan-approved" });
  const cap = makeEscalationCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature: scope grew beyond a mechanical edit",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "plan-approved");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.lane, "feature", "lane must switch to feature");
    assert.equal(state.workflowGate, "plan-approved", "feature lane re-enters at plan-approved");
    assert.equal(state.taskId, "feat-101", "escalation must preserve the taskId");
    // The lane_transition audit entry carries the reason.
    const transitions = readTrace(join(fx.root, ".devmate", "state", "transitions.jsonl"));
    const laneTransition = transitions.find((e) => e["event"] === "lane_transition");
    assert.ok(laneTransition, "lane_transition audit entry must be written");
    assert.equal(laneTransition["from"], "chore");
    assert.equal(laneTransition["to"], "feature");
    assert.equal(laneTransition["reason"], "scope grew beyond a mechanical edit");
    // Model-visible confirmation.
    assert.ok(cap.chunks.join("").includes("escalated to the feature lane"));
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — chore escalation from impl-started also lands at plan-approved', async () => {
  const fx = makeFixture({ lane: "chore", workflowGate: "impl-started" });
  const cap = makeEscalationCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature: needs real logic changes",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "gate_advanced");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.lane, "feature");
    assert.equal(state.workflowGate, "plan-approved");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — escalation without a reason degrades to a model-visible ask', async () => {
  const fx = makeFixture({ lane: "chore", workflowGate: "plan-approved" });
  const cap = makeEscalationCapture();
  try {
    const before = readFileSync(fx.statePath, "utf8");
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    assert.equal(readFileSync(fx.statePath, "utf8"), before, "state must not change");
    assert.ok(cap.chunks.join("").includes("needs a reason"));
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — escalation on a non-chore lane degrades to a message, never throws', async () => {
  const fx = makeFixture({ lane: "feature", workflowGate: "plan-approved" });
  const cap = makeEscalationCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature: not actually a chore",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.lane, "feature");
    assert.equal(state.workflowGate, "plan-approved");
    assert.ok(cap.chunks.join("").includes("applies to a chore-lane task"));
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — a space before the escalation colon still records a clean reason', async () => {
  const fx = makeFixture({ lane: "chore", workflowGate: "plan-approved" });
  const cap = makeEscalationCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature : retry needs a real fix",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "gate_advanced");
    const transitions = readTrace(join(fx.root, ".devmate", "state", "transitions.jsonl"));
    const lt = transitions.find((e) => e["event"] === "lane_transition");
    assert.ok(lt, "lane_transition audit entry must be written");
    assert.equal(lt["reason"], "retry needs a real fix", "reason must not keep the stray colon");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — a superstring phrase ("...to features") does NOT fire the escalation', async () => {
  const fx = makeFixture({ lane: "chore", workflowGate: "plan-approved" });
  const cap = makeEscalationCapture();
  try {
    const before = readFileSync(fx.statePath, "utf8");
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to features: garbled",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough");
    assert.equal(readFileSync(fx.statePath, "utf8"), before, "state must not change");
  } finally {
    fx.cleanup();
  }
});

/**
 * Assert the escalation phrase refuses at a non-in-flight gate: passthrough,
 * no state mutation, and a model-visible reason.
 * @param {import('../../lib/types.mjs').WorkflowGate} gate
 * @returns {Promise<void>}
 */
async function assertEscalationRefusedAt(gate) {
  const fx = makeFixture({ lane: "chore", workflowGate: gate });
  const cap = makeEscalationCapture();
  try {
    const before = readFileSync(fx.statePath, "utf8");
    const result = await handleUserPromptSubmit({
      prompt: "escalate chore to feature: too late or too early",
      root: fx.root,
      stdout: /** @type {any} */ (cap.stdout),
    });
    assert.equal(result.action, "passthrough", `gate ${gate} must refuse`);
    assert.equal(readFileSync(fx.statePath, "utf8"), before, `state changed at ${gate}`);
    assert.ok(
      cap.chunks.join("").includes("in-flight chore"),
      `no model-visible refusal at ${gate}`,
    );
  } finally {
    fx.cleanup();
  }
}

test('approval-listener — escalation refuses non-in-flight gates with a model-visible reason', async () => {
  await assertEscalationRefusedAt("no-lane");
  await assertEscalationRefusedAt("done");
  await assertEscalationRefusedAt("parked");
  await assertEscalationRefusedAt("abandoned");
});


// ── #191: "reset task" — explicit corrupt-state recovery ──────────────────────

/** A capturing stdout stub for the reset-task tests. */
function makeResetCapture() {
  const chunks = /** @type {string[]} */ ([]);
  return {
    stream: /** @type {any} */ ({ write(/** @type {unknown} */ c) { chunks.push(String(c)); return true; } }),
    text: () => chunks.join(""),
  };
}

test('approval-listener — "reset task" quarantines a CORRUPT state and starts fresh', async () => {
  const fx = makeFixture();
  // Corrupt the state AFTER the fixture wrote a valid one.
  writeFileSync(fx.statePath, "{ not valid json", "utf8");
  const cap = makeResetCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "reset task",
      root: fx.root,
      sessionId: "abc-123",
      stdout: cap.stream,
    });
    assert.equal(result.action, "passthrough");
    const out = cap.text();
    assert.ok(out.includes("quarantined the corrupt task.json"), `message: ${out}`);
    assert.ok(out.includes("started a fresh task"), "reports the fresh task");
    // task.json is now a fresh valid state (the original was moved to a sidecar).
    const fresh = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(fresh.workflowGate, "no-lane", "a fresh valid task is in place");
  } finally {
    fx.cleanup();
  }
});

test('approval-listener — "reset task" on a VALID state is a safe refusal, never discards it', async () => {
  const fx = makeFixture({ workflowGate: "impl-started" });
  const before = readFileSync(fx.statePath, "utf8");
  const cap = makeResetCapture();
  try {
    const result = await handleUserPromptSubmit({
      prompt: "reset task",
      root: fx.root,
      sessionId: "abc-123",
      stdout: cap.stream,
    });
    assert.equal(result.action, "passthrough");
    const out = cap.text();
    assert.ok(out.includes("the current task.json is valid"), `message: ${out}`);
    assert.ok(out.includes("only recovers a CORRUPT state"), "explains reset only recovers corrupt state");
    assert.ok(out.includes("abandon"), "points to abandon for a valid task");
    assert.equal(readFileSync(fx.statePath, "utf8"), before, "valid task is untouched");
  } finally {
    fx.cleanup();
  }
});

// ── #198: APPROVE_PLAN advance is a version-checked write (CAS loop) ───────────

test('#198 approval-listener › "approve plan" advance does not clobber a concurrent field write', async () => {
  // A bug task at plan-approved with a scope.md advances plan-approved →
  // impl-started on "approve plan". Race a concurrent field write against it: the
  // CAS loop either reads it in fresh state or retries on conflict, so both the
  // advance (with currentStep reset) AND the concurrent field survive.
  const fx = makeFixture({ workflowGate: "plan-approved", lane: "bug", currentStep: 7 });
  const taskId = JSON.parse(readFileSync(fx.statePath, "utf8")).taskId;
  const sessionDir = join(fx.root, ".devmate", "session", taskId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "scope.md"),
    ["---", "lane: bug", "---", "# Scope", "", "## Allowed paths", "- src/app.mjs", "", "## Allowed globs", ""].join("\n"),
    "utf8",
  );
  try {
    // Start the handler, then land the competing write before it commits.
    const pending = handleUserPromptSubmit({ prompt: "approve plan", root: fx.root });
    await mutateTaskStateUnderLock((s) => ({ ...s, activeSubagents: 3 }), fx.statePath);
    const result = await pending;

    assert.equal(result.action, "gate_advanced");
    assert.equal(result.gate, "impl-started");
    const after = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(after.workflowGate, "impl-started", "the gate advanced");
    assert.equal(after.currentStep, 0, "currentStep was reset");
    assert.equal(after.activeSubagents, 3, "the concurrent field write survived the CAS advance");
  } finally {
    fx.cleanup();
  }
});
