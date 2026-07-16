// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { main } from "../../scripts/complete-ac.mjs";
import { readTaskState } from "../../lib/task-state.mjs";
import { readTrace } from "../../lib/trace/read-trace.mjs";
import {
  completedAcNumbers,
  renderCheckedSpec,
} from "../../lib/spec-progress.mjs";

const SPEC = [
  "# Spec: demo",
  "",
  "## Acceptance criteria",
  "- [ ] AC1: first criterion",
  "- [ ] AC2: second criterion",
  "- [ ] AC3: third criterion",
  "",
].join("\n");

/**
 * Build a temp repo with a valid impl-started task and an unchecked spec.
 * @param {string} taskId
 * @returns {Promise<{ repo: string, specPath: string, statePath: string, traceDir: string }>}
 */
async function makeRepo(taskId) {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "devmate-completeac-"));
  const stateDir = path.join(repo, ".devmate", "state");
  const sessionDir = path.join(repo, ".devmate", "session");
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(sessionDir, { recursive: true });
  const specPath = path.join(sessionDir, "spec.md");
  await fsp.writeFile(specPath, SPEC, "utf8");
  const statePath = path.join(stateDir, "task.json");
  const oldDigest = createHash("sha256").update(SPEC, "utf8").digest("hex");
  const state = {
    taskId,
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: { spec: specPath, specDigest: oldDigest },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    acceptanceCriteria: ["first criterion", "second criterion", "third criterion"],
    schemaVersion: 1,
  };
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return { repo, specPath, statePath, traceDir: path.join(stateDir, "trace") };
}

/** Silence the script's single-line JSON stdout during the test. */
function muteStdout() {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = /** @type {any} */ (() => true);
  return () => {
    process.stdout.write = orig;
  };
}

test("complete-ac: records canonical impl-AC events visible to readTrace", async () => {
  const t = "feat-ac";
  const { repo, traceDir } = await makeRepo(t);
  const restore = muteStdout();
  try {
    const code = await main(["--repo-root", repo, "--ac", "1", "--ac", "2"]);
    assert.equal(code, 0);
  } finally {
    restore();
  }
  const { steps } = await readTrace(t, { traceDir });
  assert.deepEqual(completedAcNumbers(steps), [1, 2]);
});

test("complete-ac: syncs spec.md checkboxes and refreshes specDigest", async () => {
  const t = "feat-sync";
  const { repo, specPath, statePath } = await makeRepo(t);
  const restore = muteStdout();
  try {
    await main(["--repo-root", repo, "--ac", "1", "--ac", "2"]);
  } finally {
    restore();
  }
  const md = await fsp.readFile(specPath, "utf8");
  assert.match(md, /- \[x\] AC1: first criterion/);
  assert.match(md, /- \[x\] AC2: second criterion/);
  assert.match(md, /- \[ \] AC3: third criterion/);

  const expectedDigest = createHash("sha256")
    .update(renderCheckedSpec(SPEC, new Set([1, 2])), "utf8")
    .digest("hex");
  const state = readTaskState(statePath);
  assert.ok(state.ok);
  assert.equal(state.state.artifactHashes.specDigest, expectedDigest);
  // Gate must remain impl-started — this never advances the workflow.
  assert.equal(state.state.workflowGate, "impl-started");
});

test("complete-ac: is idempotent — re-completing an AC is a no-op", async () => {
  const t = "feat-idem";
  const { repo, specPath, traceDir } = await makeRepo(t);
  const restore = muteStdout();
  try {
    await main(["--repo-root", repo, "--ac", "1"]);
    const before = await fsp.readFile(specPath, "utf8");
    const code = await main(["--repo-root", repo, "--ac", "1"]);
    assert.equal(code, 0);
    const after = await fsp.readFile(specPath, "utf8");
    assert.equal(before, after, "spec unchanged on re-complete");
  } finally {
    restore();
  }
  // Trace dedups by stepId, so exactly one AC1 completion is seen.
  const { steps } = await readTrace(t, { traceDir });
  assert.deepEqual(completedAcNumbers(steps), [1]);
});

test("complete-ac: fails cleanly when no AC ids are given", async () => {
  const t = "feat-noac";
  const { repo } = await makeRepo(t);
  const restore = muteStdout();
  try {
    const code = await main(["--repo-root", repo]);
    assert.equal(code, 1);
  } finally {
    restore();
  }
});
