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
import { main } from "../../scripts/chore-continue.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: "chore-99",
    lane: "chore",
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
 * Create a temp dir, write task.json, and return its state path + cleanup.
 * @param {Partial<TaskState>} [stateOverrides]
 * @returns {{ dir: string, statePath: string, transitionsPath: string, cleanup: () => void }}
 */
function makeFixture(stateOverrides) {
  const dir = mkdtempSync(join(tmpdir(), "devmate-chore-continue-"));
  const stateDir = join(dir, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "task.json");
  const transitionsPath = join(stateDir, "transitions.jsonl");
  writeFileSync(
    statePath,
    JSON.stringify(makeState(stateOverrides), null, 2),
    "utf8",
  );
  return {
    dir,
    statePath,
    transitionsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("main — exits 0 with approved-chore fixture and advances gate", async () => {
  const fx = makeFixture();
  // Anchor the transitions log inside the fixture dir.
  const prev = process.env.DEVMATE_TRANSITIONS_PATH;
  process.env.DEVMATE_TRANSITIONS_PATH = fx.transitionsPath;
  try {
    const code = await main(["--state-path", fx.statePath]);
    assert.equal(code, 0);
    const onDisk = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(onDisk.workflowGate, "impl-started");
  } finally {
    if (prev === undefined) delete process.env.DEVMATE_TRANSITIONS_PATH;
    else process.env.DEVMATE_TRANSITIONS_PATH = prev;
    fx.cleanup();
  }
});

test("main — exits 1 with executing-gate fixture (already continued)", async () => {
  const fx = makeFixture({ workflowGate: "impl-started" });
  try {
    const code = await main(["--state-path", fx.statePath]);
    assert.equal(code, 1);
    // State unchanged.
    const onDisk = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(onDisk.workflowGate, "impl-started");
  } finally {
    fx.cleanup();
  }
});

test("main — exits 1 with feature-lane fixture", async () => {
  const fx = makeFixture({ lane: "feature" });
  try {
    const code = await main(["--state-path", fx.statePath]);
    assert.equal(code, 1);
  } finally {
    fx.cleanup();
  }
});

test("main — exits 1 when TaskState file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devmate-chore-continue-missing-"));
  try {
    const code = await main(["--state-path", join(dir, "nope.json")]);
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
