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

/**
 * E10-05 lifecycle: a task at a TERMINAL gate (done/abandoned) is finished,
 * not live — nothing can transition out of it, so leaving it in place would
 * wedge the workspace forever (no new task could ever start after an
 * abandon). A fresh session bootstraps a NEW task over it; the old task's
 * artifacts stay on disk but no longer match the new taskId, so every
 * ownership-checking precondition refuses them as stale evidence.
 */
/**
 * Shared body for the two terminal-gate cases below.
 * @param {string} terminalGate
 */
async function assertTerminalTaskReplaced(terminalGate) {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: "t-finished",
        lane: "feature",
        workflowGate: terminalGate,
        currentStep: 0,
        artifactHashes: {},
        preImplStash: null,
        budget: 10,
        schemaVersion: 1,
      }),
    );

    const result = await bootstrapTaskState(root, { sessionId: "sess-next" });
    assert.equal(result.created, true);
    assert.equal(result.taskId, "s-sess-next");

    const state = readState(statePath);
    // The new task inherits NOTHING: fresh id, pre-router gate, step 0.
    assert.equal(state.taskId, "s-sess-next");
    assert.equal(state.workflowGate, "no-lane");
    assert.equal(state.currentStep, 0);
  } finally {
    cleanup();
  }
}

test("bootstrapTaskState — replaces a terminal task (abandoned) with a fresh no-lane task", async () => {
  await assertTerminalTaskReplaced("abandoned");
});

test("bootstrapTaskState — replaces a terminal task (done) with a fresh no-lane task", async () => {
  await assertTerminalTaskReplaced("done");
});

test("bootstrapTaskState — an in-flight parked task is NOT terminal and survives a fresh session", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    // parked is a steering pause, not an end: the resume pointer will return
    // it to its recorded gate. Replacing it here would destroy paused work.
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: "t-parked",
        lane: "feature",
        workflowGate: "parked",
        currentStep: 0,
        artifactHashes: {},
        preImplStash: null,
        budget: 10,
        schemaVersion: 1,
      }),
    );

    const result = await bootstrapTaskState(root, { sessionId: "sess-4" });
    assert.equal(result.created, false);
    assert.equal(result.reason, "exists");
    assert.equal(readState(statePath).taskId, "t-parked");
  } finally {
    cleanup();
  }
});

test("bootstrapTaskState — an unreadable task.json is left untouched (might be live)", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    writeFileSync(statePath, "{ not json");

    const result = await bootstrapTaskState(root, { sessionId: "sess-5" });
    assert.equal(result.created, false);
    assert.equal(result.reason, "exists");
    assert.equal(readFileSync(statePath, "utf8"), "{ not json");
  } finally {
    cleanup();
  }
});

test("bootstrapTaskState — a SAME-session resume over a terminal task keeps it (no id reuse)", async () => {
  const { root, statePath, cleanup } = makeWorkspace();
  try {
    // deriveTaskId is deterministic per session: replacing here would mint the
    // terminal task's own id, and the "new" task would then own the old trace
    // and every same-taskId artifact — inheriting, not refusing, the old
    // evidence. Same session ⇒ the finished task is preserved.
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: "s-sess-same",
        lane: "feature",
        workflowGate: "abandoned",
        currentStep: 0,
        artifactHashes: {},
        preImplStash: null,
        budget: 10,
        schemaVersion: 1,
      }),
    );

    const result = await bootstrapTaskState(root, { sessionId: "sess-same" });
    assert.equal(result.created, false);
    assert.equal(result.reason, "exists");
    assert.equal(readState(statePath).taskId, "s-sess-same");
    assert.equal(readState(statePath).workflowGate, "abandoned");
  } finally {
    cleanup();
  }
});
