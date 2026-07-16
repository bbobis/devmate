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
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main } from "../../scripts/escalate-chore.mjs";

/**
 * Build a minimal valid TaskState.
 * @param {Partial<import('../../lib/types.mjs').TaskState>} [over]
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: "chore-123",
    lane: "chore",
    workflowGate: "plan-approved",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

/**
 * Create an isolated workspace, chdir into it, and write a task state file at
 * the default `.devmate/state/task.json` path. Returns a cleanup that restores
 * cwd. Tests run in separate processes, so chdir is isolated.
 * @param {import('../../lib/types.mjs').TaskState} [state]
 */
function setupCwd(state) {
  const prev = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "devmate-esc-"));
  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  if (state) {
    writeFileSync(
      resolve(root, ".devmate/state/task.json"),
      JSON.stringify(state),
      "utf8",
    );
  }
  process.chdir(root);
  return {
    root,
    cleanup: () => {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("escalate-chore main — exits 0 and escalates chore to feature", async () => {
  const ws = setupCwd(makeState());
  try {
    const code = await main(["--reason", "scope widened beyond a chore"]);
    assert.equal(code, 0);
    const onDisk = JSON.parse(readFileSync(".devmate/state/task.json", "utf8"));
    assert.equal(onDisk.lane, "feature");
    assert.equal(onDisk.workflowGate, "plan-approved");
    assert.equal(onDisk.taskId, "chore-123");
  } finally {
    ws.cleanup();
  }
});

test("escalate-chore main — exits 1 when --reason is missing", async () => {
  const ws = setupCwd(makeState());
  try {
    const code = await main([]);
    assert.equal(code, 1);
    // state must be untouched
    const onDisk = JSON.parse(readFileSync(".devmate/state/task.json", "utf8"));
    assert.equal(onDisk.lane, "chore");
  } finally {
    ws.cleanup();
  }
});

test("escalate-chore main — exits 1 when state file is missing", async () => {
  const ws = setupCwd(); // no state written
  try {
    const code = await main(["--reason", "x"]);
    assert.equal(code, 1);
  } finally {
    ws.cleanup();
  }
});

test("escalate-chore main — exits 1 when lane is not chore", async () => {
  const ws = setupCwd(makeState({ lane: "feature" }));
  try {
    const code = await main(["--reason", "x"]);
    assert.equal(code, 1);
    const onDisk = JSON.parse(readFileSync(".devmate/state/task.json", "utf8"));
    assert.equal(onDisk.lane, "feature"); // unchanged
  } finally {
    ws.cleanup();
  }
});
