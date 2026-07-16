// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { Writable } from "node:stream";
import { test } from "node:test";
import { handleUserPromptSubmit } from "../../hooks/approval-listener.mjs";
import {
  handlePostToolUse,
  isSpecPath,
  SPEC_REL_PATH,
} from "../../hooks/spec-integrity-guard.mjs";
import { parseJsonl } from "../../lib/json-io.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

const SPEC_BODY_ORIGINAL = [
  "# Spec",
  "",
  "This is the approved spec.",
  "",
  "## Files that will change",
  "- lib/feature/flow.mjs",
  "- ui/feature/page.mjs",
].join("\n");
const SPEC_BODY_EDITED = [
  "# Spec",
  "",
  "This is the approved spec — but edited.",
  "",
  "## Files that will change",
  "- lib/feature/flow.mjs",
  "- ui/feature/page.mjs",
].join("\n");

/**
 * Compute SHA-256 of a UTF-8 string the same way spec-writer does on disk.
 * @param {string} content
 * @returns {string}
 */
function sha256(content) {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "feat-200",
    lane: "feature",
    workflowGate: "spec-approved",
    artifactHashes: {
      spec: ".devmate/session/spec.md",
      specDigest: sha256(SPEC_BODY_ORIGINAL),
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Build a temp repo root with task.json + spec.md seeded.
 * @param {{ state?: Partial<TaskState>, specBody?: string, writeSpec?: boolean }} [opts]
 */
function makeFixture(opts) {
  const root = mkdtempSync(join(tmpdir(), "devmate-spec-guard-"));
  const stateDir = join(root, ".devmate", "state");
  const sessionDir = join(root, ".devmate", "session");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const statePath = join(stateDir, "task.json");
  const state = makeState(opts?.state);
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
  const specPath = join(sessionDir, "spec.md");
  if (opts?.writeSpec !== false) {
    writeFileSync(specPath, opts?.specBody ?? SPEC_BODY_ORIGINAL, "utf8");
  }
  const tracePath = join(stateDir, "trace", `${state.taskId}.jsonl`);
  return {
    root,
    statePath,
    specPath,
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
 * Build a Writable that captures everything written to it as a UTF-8 string.
 * @returns {{ stream: NodeJS.WritableStream, get: () => string }}
 */
function captureStdout() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
      );
      cb();
    },
  });
  return { stream, get: () => chunks.join("") };
}

test("spec-integrity-guard — isSpecPath matches both absolute and relative spec paths", () => {
  assert.equal(isSpecPath(`/abs/repo/${SPEC_REL_PATH}`), true);
  assert.equal(isSpecPath(SPEC_REL_PATH), true);
  assert.equal(isSpecPath(".devmate\\session\\spec.md"), true);
  assert.equal(isSpecPath(".devmate/session/other.md"), false);
  assert.equal(isSpecPath("docs/spec.md"), false);
  assert.equal(isSpecPath(undefined), false);
});

test("spec-integrity-guard — spec.md edited after spec-approved rolls gate back to spec-draft", async () => {
  const fx = makeFixture();
  try {
    // Simulate an external write that changed spec content.
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    const result = await handlePostToolUse({
      filePath: fx.specPath,
      repoRoot: fx.root,
    });
    assert.equal(result.action, "rollback");
    assert.equal(result.from, "spec-approved");
    assert.equal(result.to, "spec-draft");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — rollback emits spec_invalidated and gate_transition trace events", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    await handlePostToolUse({ filePath: fx.specPath, repoRoot: fx.root });
    const events = readTrace(fx.tracePath);
    const invalidated = events.find((e) => e["type"] === "spec_invalidated");
    const transition = events.find((e) => e["type"] === "gate_transition");
    assert.ok(invalidated, "expected a spec_invalidated event");
    assert.equal(invalidated?.["reason"], "post-approval edit detected");
    assert.ok(transition, "expected a gate_transition event");
    assert.equal(transition?.["from"], "spec-approved");
    assert.equal(transition?.["to"], "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — rollback updates specDigest in task.json to the new content", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    await handlePostToolUse({ filePath: fx.specPath, repoRoot: fx.root });
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.artifactHashes.specDigest, sha256(SPEC_BODY_EDITED));
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — rollback prints a warning to stdout", async () => {
  const fx = makeFixture();
  const cap = captureStdout();
  try {
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    await handlePostToolUse(
      { filePath: fx.specPath, repoRoot: fx.root },
      { stdout: cap.stream },
    );
    const output = cap.get();
    assert.ok(output.includes("spec.md changed after approval"), output);
    assert.ok(output.includes("approve spec"), output);
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — no action when spec is edited while gate is spec-draft", async () => {
  const fx = makeFixture({ state: { workflowGate: "spec-draft" } });
  try {
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    const result = await handlePostToolUse({
      filePath: fx.specPath,
      repoRoot: fx.root,
    });
    assert.deepEqual(result, { action: "no_action" });
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-draft");
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — no action when a non-spec file is written", async () => {
  const fx = makeFixture();
  try {
    const result = await handlePostToolUse({
      filePath: join(fx.root, "src/foo.mjs"),
      repoRoot: fx.root,
    });
    assert.deepEqual(result, { action: "no_action" });
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-approved");
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — no action when digest is unchanged (idempotent write)", async () => {
  const fx = makeFixture();
  try {
    // spec.md still matches the recorded digest.
    const result = await handlePostToolUse({
      filePath: fx.specPath,
      repoRoot: fx.root,
    });
    assert.deepEqual(result, { action: "no_action" });
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "spec-approved");
    assert.deepEqual(readTrace(fx.tracePath), []);
  } finally {
    fx.cleanup();
  }
});

test("spec-integrity-guard — re-approval works after rollback", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.specPath, SPEC_BODY_EDITED, "utf8");
    const first = await handlePostToolUse({
      filePath: fx.specPath,
      repoRoot: fx.root,
    });
    assert.equal(first.action, "rollback");

    // Human reviews the edited spec and re-approves.
    const reapprove = await handleUserPromptSubmit({
      prompt: "approve spec",
      root: fx.root,
    });
    assert.equal(reapprove.action, "gate_advanced");
    assert.equal(reapprove.gate, "spec-approved");
    const state = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(state.workflowGate, "impl-started");
  } finally {
    fx.cleanup();
  }
});
