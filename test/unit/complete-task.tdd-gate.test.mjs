// @ts-check
import { skipUnlessNode } from "../../lib/test-utils/node-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPLETE_TASK = resolve(__dirname, "../../scripts/complete-task.mjs");
const VERIFY_TEST_FILES = resolve(__dirname, "../../scripts/verify-test-files.mjs");
const VERIFY_MODULE_URL = `file://${VERIFY_TEST_FILES.replace(/\\/g, "/")}`;

/** @returns {string} */
function makeRepo() {
  const root = join(
    tmpdir(),
    `complete-task-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  mkdirSync(join(root, ".devmate", "memory", "tasks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "verify-test-files.mjs"),
    [
      "// @ts-check",
      `import { main } from ${JSON.stringify(VERIFY_MODULE_URL)};`,
      "main(process.argv.slice(2)).then((code) => process.exit(code));",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

/**
 * @param {string} root
 * @param {unknown} state
 */
function writeState(root, state) {
  writeFileSync(
    join(root, ".devmate", "state", "task.json"),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

/**
 * @param {string} root
 * @param {string} taskId
 * @param {string[]} lines
 */
function writeTaskLedger(root, taskId, lines) {
  writeFileSync(
    join(root, ".devmate", "memory", "tasks", `${taskId}.jsonl`),
    lines.map((line) => `${line}\n`).join(""),
    "utf8",
  );
}

/**
 * @param {string} source
 * @returns {Record<string, unknown>}
 */
function fact(source) {
  return {
    event: "fact",
    source,
    tool: "write_file",
    lane: "feature",
    tags: [],
    summary: `edited ${source}`,
    confidence: 0.8,
    ts: Date.now(),
    stepId: "s1",
    firstEdit: true,
    writer: "agent-a",
  };
}

/**
 * @param {string} root
 * @param {string} taskId
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCompleteTask(root, taskId) {
  return spawnSync(process.execPath, [COMPLETE_TASK, "--task-id", taskId], {
    cwd: root,
    encoding: "utf8",
  });
}

/**
 * @param {Object} opts
 * @param {string} opts.taskId
 * @param {boolean} opts.testFileWritten
 * @param {boolean} opts.overrideGranted
 * @param {string} opts.testFile
 */
function buildState(opts) {
  return {
    taskId: opts.taskId,
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    tddGuard: {
      testFileWritten: opts.testFileWritten,
      consecutiveNonTestWrites: 0,
      overrideGranted: opts.overrideGranted,
    },
    testPlan: [
      {
        id: "TC-001",
        description: "scenario",
        tier: 1,
        testFile: opts.testFile,
        runCommand: `node --test ${opts.testFile}`,
      },
    ],
  };
}

test("complete-task blocks when no test file has been written and no override is granted", skipUnlessNode(24), () => {
  const root = makeRepo();
  const taskId = "t-complete-1";
  try {
    writeState(
      root,
      buildState({
        taskId,
        testFileWritten: false,
        overrideGranted: false,
        testFile: "test/unit/missing.test.mjs",
      }),
    );
    writeTaskLedger(root, taskId, [JSON.stringify(fact("lib/a.mjs"))]);

    const result = runCompleteTask(root, taskId);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /write-first gate blocked completion/i);
    assert.equal(
      existsSync(join(root, ".devmate", "memory", "completions.jsonl")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete-task allows override to skip hint check and continue to verifier", skipUnlessNode(24), () => {
  const root = makeRepo();
  const taskId = "t-complete-2";
  try {
    const testFile = "test/unit/present.test.mjs";
    const absTestFile = join(root, testFile);
    mkdirSync(dirname(absTestFile), { recursive: true });
    writeFileSync(absTestFile, "// test\n", "utf8");

    writeState(
      root,
      buildState({
        taskId,
        testFileWritten: false,
        overrideGranted: true,
        testFile,
      }),
    );
    writeTaskLedger(root, taskId, [JSON.stringify(fact("lib/b.mjs"))]);

    const result = runCompleteTask(root, taskId);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete-task promotes ledger when all test files exist and hint is true", skipUnlessNode(24), () => {
  const root = makeRepo();
  const taskId = "t-complete-3";
  try {
    const testFile = "test/unit/present.test.mjs";
    const absTestFile = join(root, testFile);
    mkdirSync(dirname(absTestFile), { recursive: true });
    writeFileSync(absTestFile, "// test\n", "utf8");

    writeState(
      root,
      buildState({
        taskId,
        testFileWritten: true,
        overrideGranted: false,
        testFile,
      }),
    );
    writeTaskLedger(root, taskId, [JSON.stringify(fact("lib/c.mjs"))]);

    const result = runCompleteTask(root, taskId);
    assert.equal(result.status, 0);

    const repoLedgerPath = join(root, ".devmate", "state", "repo", "repo.jsonl");
    assert.equal(existsSync(repoLedgerPath), true);
    const body = readFileSync(repoLedgerPath, "utf8");
    assert.match(body, /"source":"lib\/c\.mjs"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
