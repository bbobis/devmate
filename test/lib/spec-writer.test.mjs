// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SpecWriteError, writeSpec } from "../../lib/spec-writer.mjs";

/** @returns {string} a fresh temp dir for each test */
function makeTmpRepo() {
  const dir = join(
    tmpdir(),
    `spec-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Minimal valid SpecContent for tests.
 * @returns {import('../../lib/spec-writer.mjs').SpecContent}
 */
function minimalContent() {
  return {
    title: "My Feature",
    summary: "A short summary.",
    currentBehavior: "No spec is written.",
    gap: "spec.md is missing.",
    edgeCases: ["Empty input", "Concurrent writes"],
    assumptions: ["node:crypto is available", "Disk is writable"],
    files: [
      { path: "lib/spec-writer.mjs", reason: "New module", isNew: true },
      {
        path: "test/lib/spec-writer.test.mjs",
        reason: "Test coverage",
        isNew: true,
      },
    ],
    acceptanceCriteria: ["spec.md is written", "digest is stable"],
    testPlan: [
      {
        id: "TC-001",
        description: "writes spec.md",
        tier: 1,
        testFile: "test/lib/spec-writer.test.mjs",
        runCommand: "node --test test/lib/spec-writer.test.mjs",
      },
      {
        id: "TC-002",
        description: "digest is stable",
        tier: 1,
        testFile: "test/lib/spec-writer.test.mjs",
        runCommand: "node --test test/lib/spec-writer.test.mjs",
      },
    ],
    risks: ["Concurrent writes may clobber the file"],
    outOfScope: ["spec rollback on gate transition"],
  };
}

describe("spec-writer", () => {
  it("writes all 9 required sections to spec.md", async () => {
    const repoRoot = makeTmpRepo();
    try {
      await writeSpec(repoRoot, minimalContent());
      const specPath = join(repoRoot, ".devmate", "session", "spec.md");
      const content = readFileSync(specPath, "utf8");
      const expectedSections = [
        "# Spec:",
        "## What we're building",
        "## Why (from discovery)",
        "## Edge cases surfaced during grill",
        "## Assumptions — please verify",
        "## Files that will change",
        "## Acceptance criteria",
        "## Test plan",
        "## Risks",
        "## Out of scope",
      ];
      for (const section of expectedSections) {
        assert.ok(content.includes(section), `Missing section: ${section}`);
      }
      assert.ok(content.includes("| ID | Description | Tier | Test file | How to run |"));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records specPath and specDigest in task.json", async () => {
    const repoRoot = makeTmpRepo();
    try {
      // Write a minimal task.json so writeSpec can update it
      const stateDir = join(repoRoot, ".devmate", "state");
      mkdirSync(stateDir, { recursive: true });
      const taskState = {
        taskId: "test-task",
        lane: "feature",
        workflowGate: "plan-approved",
        artifactHashes: {},
        preImplStash: null,
        currentStep: 0,
        budget: 10,
        schemaVersion: 1,
      };
      writeFileSync(
        join(stateDir, "task.json"),
        JSON.stringify(taskState, null, 2),
        "utf8",
      );

      const result = await writeSpec(repoRoot, minimalContent());

      const taskJson = JSON.parse(
        readFileSync(join(stateDir, "task.json"), "utf8"),
      );
      assert.ok(
        taskJson.artifactHashes.spec,
        "spec path should be recorded in task.json",
      );
      assert.ok(
        taskJson.artifactHashes.specDigest,
        "specDigest should be recorded in task.json",
      );
      assert.equal(taskJson.artifactHashes.spec, result.specPath);
      assert.equal(taskJson.artifactHashes.specDigest, result.specDigest);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("digest is stable (idempotent for same content)", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const r1 = await writeSpec(repoRoot, minimalContent());
      const r2 = await writeSpec(repoRoot, minimalContent());
      assert.equal(
        r1.specDigest,
        r2.specDigest,
        "digest must be the same for same content",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("digest changes when content changes", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const r1 = await writeSpec(repoRoot, minimalContent());
      const modified = minimalContent();
      modified.title = "A Different Title";
      const r2 = await writeSpec(repoRoot, modified);
      assert.notEqual(
        r1.specDigest,
        r2.specDigest,
        "digest must change when content changes",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("throws typed error when required SpecContent field is missing", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const bad = /** @type {any} */ ({
        ...minimalContent(),
        title: undefined,
      });
      await assert.rejects(
        () => writeSpec(repoRoot, bad),
        (err) => {
          assert.ok(
            err instanceof SpecWriteError,
            "should be a SpecWriteError",
          );
          assert.ok(
            /** @type {SpecWriteError} */ (err).message.includes("title"),
            "message should name the missing field",
          );
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("throws typed error when testPlan is empty", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const bad = /** @type {any} */ ({
        ...minimalContent(),
        testPlan: [],
      });
      await assert.rejects(
        () => writeSpec(repoRoot, bad),
        (err) => {
          assert.ok(
            err instanceof SpecWriteError,
            "should be a SpecWriteError",
          );
          assert.ok(
            /** @type {SpecWriteError} */ (err).message.includes("testPlan"),
            "message should name testPlan",
          );
          return true;
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates .devmate/session/ directory if it does not exist", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const sessionDir = join(repoRoot, ".devmate", "session");
      assert.ok(
        !existsSync(sessionDir),
        "session dir should not exist before writeSpec",
      );
      await writeSpec(repoRoot, minimalContent());
      assert.ok(
        existsSync(sessionDir),
        "session dir should be created by writeSpec",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not write to repo tree (path is under .devmate/session/)", async () => {
    const repoRoot = makeTmpRepo();
    try {
      const result = await writeSpec(repoRoot, minimalContent());
      assert.ok(
        result.specPath.includes(join(".devmate", "session")),
        `specPath must be under .devmate/session/, got: ${result.specPath}`,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
