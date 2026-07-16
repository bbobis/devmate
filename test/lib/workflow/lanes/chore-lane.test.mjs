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
import { join, resolve } from "node:path";
import { test } from "node:test";

import { parseJsonl } from "../../../../lib/json-io.mjs";
import { runChoreLane } from "../../../../lib/workflow/lanes/chore.mjs";

/**
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

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "chore-driver-test-"));
  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  mkdirSync(resolve(root, ".devmate", "session"), { recursive: true });
  writeFileSync(
    resolve(root, ".devmate", "devmate.config.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        personas: [
          {
            persona: "editor",
            editableGlobs: ["docs/**", "*.md", "*.json", "scripts/**"],
            offLimitsGlobs: ["src/main/**"],
            instructionFile: null,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    root,
    statePath: resolve(root, ".devmate", "state", "task.json"),
    transitionsPath: resolve(root, ".devmate", "state", "transitions.jsonl"),
    traceFile: resolve(root, ".devmate", "state", "trace.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("runChoreLane — happy path writes scope, dispatches editor persona, verifies, and advances gate", async () => {
  const ws = makeWorkspace();
  /** @type {string[]} */
  const steps = [];
  /** @type {Array<{ agent: 'fullstack', persona: 'editor', scopePath: string, choreDescription: string }>} */
  const dispatchCalls = [];
  /** @type {Array<{ scopePath: string }>} */
  const verifyCalls = [];

  try {
    const result = await runChoreLane("Bump dependency versions", makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ["package.json", "CHANGELOG.md"],
      dispatch: async (input) => {
        const events = /** @type {any[]} */ (
          parseJsonl(readFileSync(ws.transitionsPath, "utf8"))
        ).map((entry) => entry.event);
        steps.push(
          ...events.map((event) =>
            event === "chore_scope_written" ? "scope" : "gate-advance",
          ),
        );
        steps.push("dispatch");
        dispatchCalls.push(input);
        const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
        assert.equal(onDisk.workflowGate, "impl-started");
        assert.ok(existsSync(input.scopePath));
        return {
          status: "ok",
          agentName: "fullstack",
          payload: {
            summary: "updated docs and metadata",
          },
        };
      },
      verify: async (ctx) => {
        steps.push("verify");
        verifyCalls.push({ scopePath: ctx.scopePath });
        return { passed: true, summary: "verification passed" };
      },
    });

    assert.equal(result.status, "verified");
    assert.match(result.summary, /verification passed/i);
    assert.deepEqual(steps, ["scope", "gate-advance", "dispatch", "verify"]);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(verifyCalls.length, 1);
    assert.deepEqual(dispatchCalls[0], {
      agent: "fullstack",
      persona: "editor",
      scopePath: resolve(ws.root, ".devmate", "session", "chore-123", "scope.md"),
      choreDescription: "Bump dependency versions",
    });
    const scopeText = readFileSync(dispatchCalls[0].scopePath, "utf8");
    // P06: assert unified scope.md schema (frontmatter + sectioned format).
    assert.match(scopeText, /^---/m);
    assert.match(scopeText, /lane: chore/);
    assert.match(scopeText, /## Allowed paths/);
    assert.match(scopeText, /package\.json/);
    assert.match(scopeText, /CHANGELOG\.md/);
    assert.doesNotMatch(scopeText, /## Description/);
    const stateOnDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(stateOnDisk.workflowGate, "verification-passed");
  } finally {
    ws.cleanup();
  }
});

test("runChoreLane — architectural file escalation blocks scope write and dispatch", async () => {
  const ws = makeWorkspace();
  let dispatchCount = 0;

  try {
    const result = await runChoreLane("Adjust Java implementation", makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ["src/main/java/Foo.java"],
      dispatch: async () => {
        dispatchCount += 1;
        return {
          status: "ok",
          agentName: "fullstack",
          payload: { summary: "should not happen" },
        };
      },
      verify: async () => ({ passed: true }),
    });

    assert.equal(result.status, "escalated");
    assert.equal(dispatchCount, 0);
    assert.equal(
      existsSync(resolve(ws.root, ".devmate", "session", "chore-123", "scope.md")),
      false,
    );
    const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(onDisk.lane, "feature");
    const events = /** @type {any[]} */ (
      parseJsonl(readFileSync(ws.transitionsPath, "utf8"))
    );
    assert.ok(events.some((event) => event.event === "lane_transition"));
  } finally {
    ws.cleanup();
  }
});

test("runChoreLane — regression: exactly one fullstack editor dispatch and no feature-lane improvisation", async () => {
  const ws = makeWorkspace();
  /** @type {Array<{ agent: 'fullstack', persona: 'editor', scopePath: string, choreDescription: string }>} */
  const calls = [];

  try {
    const result = await runChoreLane("Refresh documentation metadata", makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ["README.md"],
      dispatch: async (input) => {
        calls.push(input);
        return {
          status: "ok",
          agentName: "fullstack",
          payload: { summary: "doc refresh complete" },
        };
      },
      verify: async () => ({ passed: true }),
    });

    assert.equal(result.status, "verified");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, "fullstack");
    assert.equal(calls[0].persona, "editor");
    assert.equal(
      Object.prototype.hasOwnProperty.call(calls[0], "planner"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(calls[0], "specWriter"),
      false,
    );
  } finally {
    ws.cleanup();
  }
});

test("runChoreLane — returns failed summary when dispatch returns status=error", async () => {
  const ws = makeWorkspace();

  try {
    const result = await runChoreLane("Update metadata", makeState(), {
      repoRoot: ws.root,
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
      traceFile: ws.traceFile,
      proposedFiles: ["package.json"],
      dispatch: async () => ({
        status: "error",
        agentName: "fullstack",
        error: "editor dispatch crashed",
      }),
      verify: async () => ({ passed: true }),
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /editor dispatch crashed/);
  } finally {
    ws.cleanup();
  }
});