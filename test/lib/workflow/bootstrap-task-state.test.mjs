// @ts-check
/**
 * The bootstrap exists because task.json was never created: the only writer was
 * `scripts/init-task-state.mjs`, invoked from a line in the orchestrator prompt,
 * and the orchestrator declares no `execute` tool. These tests pin the two
 * invariants that make moving it into SessionStart safe.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bootstrapTaskState,
  deriveTaskId,
} from "../../../lib/workflow/bootstrap-task-state.mjs";
import { TASK_ID_RE } from "../../../lib/memory/paths.mjs";
import { STATE_PATH } from "../../../lib/task-state.mjs";

/** @returns {{ root: string, statePath: string, cleanup: () => void }} */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-task-"));
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  return {
    root,
    statePath: join(root, STATE_PATH),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} statePath */
function readState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

test("deriveTaskId — produces a ledger-safe id from a host session id", () => {
  // Uppercase and a slash are both illegal in a ledger filename.
  const taskId = deriveTaskId("90d5b813-4F2a/4c1e");
  assert.equal(taskId, "s-90d5b813-4f2a-4c1e");
  // The id becomes .devmate/memory/tasks/<taskId>.jsonl — an id that fails this
  // regex is rejected by every downstream memory write, silently killing the
  // whole memory subsystem for the task.
  assert.match(/** @type {string} */ (taskId), TASK_ID_RE);
});

test("deriveTaskId — is deterministic, so a resumed session re-derives its own id", () => {
  assert.equal(deriveTaskId("abc-123"), deriveTaskId("abc-123"));
});

test("deriveTaskId — returns null rather than a sentinel when there is no session id", () => {
  // #76 minted the literal "unknown", producing an `unknown.jsonl` no reader
  // ever consults. Absent state is honest; fabricated state is not.
  assert.equal(deriveTaskId(""), null);
  assert.equal(deriveTaskId("---"), null);
});

test("bootstrapTaskState — creates task.json at the PRE-ROUTER gate, never plan-approved", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    const result = await bootstrapTaskState(root, { sessionId: "sess-1" });
    assert.equal(result.created, true);

    const state = readState(statePath);
    // The invariant that matters: `init-task-state` writes 'plan-approved',
    // which is what HITL hangs off. Bootstrapping that on every session start
    // would hand @fullstack an open implementation gate on a task no human has
    // ever seen.
    assert.equal(state.workflowGate, "no-lane");
    assert.notEqual(state.workflowGate, "plan-approved");
    assert.equal(state.taskId, "s-sess-1");
  } finally {
    cleanup();
  }
});

test("bootstrapTaskState — persists an OutputContract so the budget stops reporting unclassified", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    await bootstrapTaskState(root, { sessionId: "sess-2" });
    const state = readState(statePath);
    assert.ok(state.outputContract, "expected an OutputContract on the bootstrapped state");
    assert.equal(typeof state.outputContract.token_budget_class, "string");
  } finally {
    cleanup();
  }
});

test("bootstrapTaskState — never clobbers a live task", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    // A resumed session must keep its gate, its id, and its progress.
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: "t-live",
        lane: "bug",
        workflowGate: "impl-started",
        currentStep: 4,
        artifactHashes: {},
        preImplStash: null,
        budget: 6,
        schemaVersion: 1,
      }),
    );

    const result = await bootstrapTaskState(root, { sessionId: "sess-3" });
    assert.equal(result.created, false);
    assert.equal(result.reason, "exists");

    const state = readState(statePath);
    assert.equal(state.taskId, "t-live");
    assert.equal(state.workflowGate, "impl-started");
    assert.equal(state.currentStep, 4);
  } finally {
    cleanup();
  }
});

test("bootstrapTaskState — writes nothing when the host sends no session id", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    const result = await bootstrapTaskState(root, {});
    assert.equal(result.created, false);
    assert.equal(result.reason, "no_session_id");
    assert.throws(() => readFileSync(statePath, "utf8"));
  } finally {
    cleanup();
  }
});
