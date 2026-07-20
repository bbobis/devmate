// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  approveChoreException,
  checkChoreExceptionGuard,
  CHORE_CONTINUE_COMMAND,
  CHORE_EXECUTING,
  CHORE_PLAN_APPROVED,
  continueApprovedChore,
  escalateChoreToFeature,
  EXCEPTION_APPROVAL_PREFIX,
  guardChoreReset,
  RESET_COMMANDS,
} from "../../../../lib/workflow/lanes/chore.mjs";

/**
 * Build a minimal valid TaskState.
 * @param {Partial<import('../../../../lib/types.mjs').TaskState>} [over]
 * @returns {import('../../../../lib/types.mjs').TaskState}
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
 * @returns {{ root: string, statePath: string, transitionsPath: string, cleanup: () => void }}
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "chore-lane-test-"));
  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  return {
    root,
    statePath: resolve(root, ".devmate/state/task.json"),
    transitionsPath: resolve(root, ".devmate/state/transitions.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// guardChoreReset
// ---------------------------------------------------------------------------

test("guardChoreReset — blocks /quick-task when lane=chore, gate=plan-approved", () => {
  const msg = guardChoreReset(makeState(), "/quick-task");
  assert.equal(typeof msg, "string");
  assert.match(/** @type {string} */ (msg), /Cannot run '\/quick-task'/);
  // #130: the block message names the real runtime phrases, not the phantom
  // slash commands nothing could run.
  assert.match(/** @type {string} */ (msg), /approve plan/);
  assert.match(/** @type {string} */ (msg), /escalate chore to feature/);
});

test("guardChoreReset — blocks new-task under same conditions", () => {
  const msg = guardChoreReset(makeState(), "new-task");
  assert.equal(typeof msg, "string");
  assert.match(/** @type {string} */ (msg), /Cannot run 'new-task'/);
});

test("guardChoreReset — blocks every command in RESET_COMMANDS", () => {
  for (const cmd of RESET_COMMANDS) {
    const msg = guardChoreReset(makeState(), cmd);
    assert.equal(typeof msg, "string", `expected block for ${cmd}`);
  }
});

test("guardChoreReset — returns null for /devmate-chore-continue in same conditions", () => {
  assert.equal(guardChoreReset(makeState(), CHORE_CONTINUE_COMMAND), null);
});

test("guardChoreReset — returns null when gate is past approval (impl-started)", () => {
  assert.equal(
    guardChoreReset(makeState({ workflowGate: "impl-started" }), "/quick-task"),
    null,
  );
});

test("guardChoreReset — returns null when lane is not chore", () => {
  assert.equal(
    guardChoreReset(makeState({ lane: "feature" }), "/quick-task"),
    null,
  );
});

test("guardChoreReset — approved-chore regression: /quick-task returns non-null string", () => {
  const fixture = makeState({ lane: "chore", workflowGate: "plan-approved" });
  const msg = guardChoreReset(fixture, "/quick-task");
  assert.notEqual(msg, null);
  assert.equal(typeof msg, "string");
});

// ---------------------------------------------------------------------------
// continueApprovedChore
// ---------------------------------------------------------------------------

test("continueApprovedChore — transitions plan-approved -> impl-started and persists", async () => {
  const ws = makeWorkspace();
  try {
    const next = await continueApprovedChore(makeState(), {
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.equal(next.workflowGate, CHORE_EXECUTING);
    assert.equal(CHORE_EXECUTING, "impl-started");
    // State persisted to disk.
    assert.ok(existsSync(ws.statePath));
    const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(onDisk.workflowGate, "impl-started");
  } finally {
    ws.cleanup();
  }
});

test("continueApprovedChore — appends a gate_transition trace event", async () => {
  const ws = makeWorkspace();
  try {
    await continueApprovedChore(makeState(), {
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.ok(existsSync(ws.transitionsPath));
    const lines = readFileSync(ws.transitionsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.equal(evt.event, "gate_transition");
    assert.equal(evt.from, "plan-approved");
    assert.equal(evt.to, "impl-started");
    assert.equal(evt.lane, "chore");
    assert.equal(evt.taskId, "chore-123");
  } finally {
    ws.cleanup();
  }
});

test("continueApprovedChore — throws when gate is not plan-approved (no re-advance)", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () =>
        continueApprovedChore(makeState({ workflowGate: "impl-started" }), {
          statePath: ws.statePath,
          transitionsPath: ws.transitionsPath,
        }),
      /gate must be 'plan-approved'/,
    );
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RESET_COMMANDS single source of truth
// ---------------------------------------------------------------------------

test("RESET_COMMANDS — is exported and contains the documented reset commands", () => {
  assert.ok(Array.isArray(RESET_COMMANDS));
  for (const cmd of [
    "/quick-task",
    "new-task",
    "/devmate-new",
    "reset-state",
  ]) {
    assert.ok(RESET_COMMANDS.includes(cmd), `missing ${cmd}`);
  }
});

test("CHORE_PLAN_APPROVED — equals the live gate name", () => {
  assert.equal(CHORE_PLAN_APPROVED, "plan-approved");
});

// ---------------------------------------------------------------------------
// E5-3: escalateChoreToFeature
// ---------------------------------------------------------------------------

test("escalateChoreToFeature — lane chore->feature, gate->plan-approved, taskId preserved", async () => {
  const ws = makeWorkspace();
  try {
    const next = await escalateChoreToFeature(makeState(), {
      reason: "needs application-logic change beyond a chore",
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.equal(next.lane, "feature");
    assert.equal(next.workflowGate, "plan-approved");
    assert.equal(next.taskId, "chore-123");
    const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(onDisk.lane, "feature");
    assert.equal(onDisk.workflowGate, "plan-approved");
  } finally {
    ws.cleanup();
  }
});

test("escalateChoreToFeature — appends a lane_transition trace event", async () => {
  const ws = makeWorkspace();
  try {
    await escalateChoreToFeature(makeState(), {
      reason: "scope widened",
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.ok(existsSync(ws.transitionsPath));
    const lines = readFileSync(ws.transitionsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.equal(evt.event, "lane_transition");
    assert.equal(evt.from, "chore");
    assert.equal(evt.to, "feature");
    assert.equal(evt.reason, "scope widened");
    assert.equal(evt.taskId, "chore-123");
  } finally {
    ws.cleanup();
  }
});

test("escalateChoreToFeature — throws when lane is not chore", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () =>
        escalateChoreToFeature(makeState({ lane: "feature" }), {
          reason: "x",
          statePath: ws.statePath,
          transitionsPath: ws.transitionsPath,
        }),
      /lane must be 'chore'/,
    );
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// E5-3: approveChoreException
// ---------------------------------------------------------------------------

/** @returns {import('../../../../lib/types.mjs').ChoreException} */
function makeException(over = {}) {
  return {
    path: "src/app/logic.mjs",
    description: "fix off-by-one in retry counter",
    approvedBy:
      "approved exception: fix off-by-one in retry counter for src/app/logic.mjs",
    grantedAt: new Date().toISOString(),
    ...over,
  };
}

test("approveChoreException — appends a valid exception and writes state", async () => {
  const ws = makeWorkspace();
  try {
    const next = await approveChoreException(makeState(), makeException(), {
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.ok(next.approvedExceptions);
    assert.equal(next.approvedExceptions.length, 1);
    assert.equal(next.approvedExceptions[0].path, "src/app/logic.mjs");
    const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(onDisk.approvedExceptions.length, 1);
  } finally {
    ws.cleanup();
  }
});

test("approveChoreException — appends an exception_granted trace event", async () => {
  const ws = makeWorkspace();
  try {
    await approveChoreException(makeState(), makeException(), {
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    const lines = readFileSync(ws.transitionsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.equal(evt.event, "exception_granted");
    assert.equal(evt.path, "src/app/logic.mjs");
    assert.equal(evt.taskId, "chore-123");
  } finally {
    ws.cleanup();
  }
});

test("approveChoreException — rejects approvedBy missing the required prefix", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () =>
        approveChoreException(
          makeState(),
          makeException({ approvedBy: "sure go ahead" }),
          {
            statePath: ws.statePath,
            transitionsPath: ws.transitionsPath,
          },
        ),
      /approvedBy must start with/,
    );
  } finally {
    ws.cleanup();
  }
});

test("approveChoreException — rejects empty path", async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () =>
        approveChoreException(makeState(), makeException({ path: "   " }), {
          statePath: ws.statePath,
          transitionsPath: ws.transitionsPath,
        }),
      /path must be a non-empty string/,
    );
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// E5-3: checkChoreExceptionGuard
// ---------------------------------------------------------------------------

test("checkChoreExceptionGuard — returns null (allow) for non-chore lane", () => {
  const result = checkChoreExceptionGuard(
    makeState({ lane: "feature" }),
    "src/app/logic.mjs",
  );
  assert.equal(result, null);
});

test("checkChoreExceptionGuard — blocks an unknown source path in chore lane", () => {
  const result = checkChoreExceptionGuard(makeState(), "src/app/logic.mjs");
  assert.ok(typeof result === "string");
  assert.match(result, /cannot make source-code logic changes/);
});

test("checkChoreExceptionGuard — allows an exact-match approved exception", () => {
  const state = makeState({
    approvedExceptions: [makeException({ path: "src/app/logic.mjs" })],
  });
  assert.equal(checkChoreExceptionGuard(state, "src/app/logic.mjs"), null);
});

test("checkChoreExceptionGuard — allows a path under an approved prefix", () => {
  const state = makeState({
    approvedExceptions: [makeException({ path: "src/app" })],
  });
  assert.equal(checkChoreExceptionGuard(state, "src/app/logic.mjs"), null);
});

test("checkChoreExceptionGuard — blocks a path outside the approved prefix", () => {
  const state = makeState({
    approvedExceptions: [makeException({ path: "src/app" })],
  });
  assert.ok(
    typeof checkChoreExceptionGuard(state, "src/other/logic.mjs") === "string",
  );
});

test("EXCEPTION_APPROVAL_PREFIX — is the documented phrase", () => {
  assert.equal(EXCEPTION_APPROVAL_PREFIX, "approved exception:");
});
