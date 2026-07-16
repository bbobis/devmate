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
const SCRIPT = resolve(__dirname, "../../scripts/verify-test-files.mjs");

/** @returns {string} */
function makeRepo() {
  const root = join(
    tmpdir(),
    `verify-test-files-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
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
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runScript(root) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
  });
}

/**
 * @param {unknown} testPlan
 */
function baseState(testPlan) {
  return {
    taskId: "T-verify",
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    tddGuard: {
      testFileWritten: true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    testPlan,
  };
}

test("verify-test-files exits 1 for empty testPlan", skipUnlessNode(24), () => {
  const root = makeRepo();
  try {
    writeState(root, baseState([]));
    const result = runScript(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty/i);
    assert.equal(
      existsSync(join(root, ".devmate", "state", "test-files-result.json")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify-test-files exits 1 when state file is missing", skipUnlessNode(24), () => {
  const root = makeRepo();
  try {
    const result = runScript(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /state unreadable/i);
    assert.equal(
      existsSync(join(root, ".devmate", "state", "test-files-result.json")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify-test-files exits 0 when all declared test files exist", skipUnlessNode(24), () => {
  const root = makeRepo();
  try {
    const testFile = "test/unit/existing.test.mjs";
    const absTestFile = join(root, testFile);
    mkdirSync(dirname(absTestFile), { recursive: true });
    writeFileSync(absTestFile, "// test\n", "utf8");

    writeState(
      root,
      baseState([
        {
          id: "TC-001",
          description: "existing file",
          tier: 1,
          testFile,
          runCommand: "node --test test/unit/existing.test.mjs",
        },
      ]),
    );

    const result = runScript(root);
    assert.equal(result.status, 0);

    const output = JSON.parse(
      readFileSync(
        join(root, ".devmate", "state", "test-files-result.json"),
        "utf8",
      ),
    );
    assert.equal(Array.isArray(output), true);
    assert.equal(output[0].status, "EXISTS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify-test-files exits 1 when any declared file is missing", skipUnlessNode(24), () => {
  const root = makeRepo();
  try {
    writeState(
      root,
      baseState([
        {
          id: "TC-001",
          description: "missing file",
          tier: 1,
          testFile: "test/unit/missing.test.mjs",
          runCommand: "node --test test/unit/missing.test.mjs",
        },
      ]),
    );

    const result = runScript(root);
    assert.equal(result.status, 1);

    const output = JSON.parse(
      readFileSync(
        join(root, ".devmate", "state", "test-files-result.json"),
        "utf8",
      ),
    );
    assert.equal(output[0].status, "MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify-test-files marks path traversal as PATH_VIOLATION and exits 1", skipUnlessNode(24), () => {
  const root = makeRepo();
  try {
    writeState(
      root,
      baseState([
        {
          id: "TC-001",
          description: "traversal",
          tier: 1,
          testFile: "../../outside-repo/evil.mjs",
          runCommand: "node --test ../../outside-repo/evil.mjs",
        },
      ]),
    );

    const result = runScript(root);
    assert.equal(result.status, 1);

    const output = JSON.parse(
      readFileSync(
        join(root, ".devmate", "state", "test-files-result.json"),
        "utf8",
      ),
    );
    assert.equal(output[0].status, "PATH_VIOLATION");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
