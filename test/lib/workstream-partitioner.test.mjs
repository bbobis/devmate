// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkJoinCondition,
  determineDispatchMode,
  partitionWorkstreams,
} from "../../lib/workstream-partitioner.mjs";

/** @typedef {import('../../lib/types.mjs').PersonaEntry} PersonaEntry */

/** @type {PersonaEntry[]} */
const STANDARD_PERSONAS = [
  {
    persona: "backend",
    editableGlobs: ["src/main/**", "src/test/**", "lib/**"],
    offLimitsGlobs: ["src/ui/**"],
  },
  {
    persona: "frontend",
    editableGlobs: ["src/ui/**", "src/**/*.tsx", "public/**"],
    offLimitsGlobs: ["src/main/**"],
  },
];

/** @type {PersonaEntry[]} */
const OVERLAPPING_PERSONAS = [
  {
    persona: "backend",
    editableGlobs: ["src/**/*.ts", "lib/**"],
  },
  {
    persona: "frontend",
    editableGlobs: ["src/**/*.ts", "src/**/*.tsx"],
  },
];

// ---- partitionWorkstreams ----

test("partitioner - backend-only files = mode sequential-backend-first", () => {
  const result = partitionWorkstreams(
    ["src/main/java/com/example/Service.java", "lib/util.mjs"],
    STANDARD_PERSONAS,
  );
  assert.equal(result.mode, "sequential-backend-first");
  assert.deepEqual(result.backendFiles, [
    "src/main/java/com/example/Service.java",
    "lib/util.mjs",
  ]);
  assert.deepEqual(result.frontendFiles, []);
  assert.deepEqual(result.sharedFiles, []);
});

test("partitioner - frontend-only files = mode sequential-frontend-first", () => {
  const result = partitionWorkstreams(
    ["src/ui/Button.tsx", "public/icon.svg"],
    STANDARD_PERSONAS,
  );
  assert.equal(result.mode, "sequential-frontend-first");
  assert.deepEqual(result.frontendFiles, [
    "src/ui/Button.tsx",
    "public/icon.svg",
  ]);
  assert.deepEqual(result.backendFiles, []);
  assert.deepEqual(result.sharedFiles, []);
});

test("partitioner - both buckets without overlap = mode parallel", () => {
  const result = partitionWorkstreams(
    [
      "src/main/java/com/example/Service.java",
      "src/ui/Button.tsx",
      "lib/util.mjs",
    ],
    STANDARD_PERSONAS,
  );
  assert.equal(result.mode, "parallel");
  assert.ok(
    result.backendFiles.length > 0,
    "backend files should be classified",
  );
  assert.ok(
    result.frontendFiles.length > 0,
    "frontend files should be classified",
  );
  assert.deepEqual(result.sharedFiles, []);
});

test("partitioner - file matching both personas lands in sharedFiles = mode sequential-shared-first", () => {
  const result = partitionWorkstreams(
    ["src/api/types.ts", "src/component.tsx"],
    OVERLAPPING_PERSONAS,
  );
  assert.equal(result.mode, "sequential-shared-first");
  // types.ts matches both backend (src/**/*.ts) and frontend (src/**/*.ts) globs.
  assert.ok(
    result.sharedFiles.includes("src/api/types.ts"),
    "types.ts should be shared",
  );
});

test("partitioner - shared file identified correctly when both globs match", () => {
  const result = partitionWorkstreams(
    ["src/common/contract.ts"],
    OVERLAPPING_PERSONAS,
  );
  assert.deepEqual(result.sharedFiles, ["src/common/contract.ts"]);
  assert.deepEqual(result.backendFiles, []);
  assert.deepEqual(result.frontendFiles, []);
});

test("partitioner - file matching neither persona goes to sharedFiles", () => {
  const result = partitionWorkstreams(
    ["README.md", "docs/architecture.md", "CHANGELOG.md"],
    STANDARD_PERSONAS,
  );
  assert.deepEqual(result.sharedFiles, [
    "README.md",
    "docs/architecture.md",
    "CHANGELOG.md",
  ]);
  assert.equal(result.mode, "sequential-shared-first");
});

test("partitioner - empty spec file list = mode sequential-shared-first (no-op)", () => {
  const result = partitionWorkstreams([], STANDARD_PERSONAS);
  assert.equal(result.mode, "sequential-shared-first");
  assert.deepEqual(result.backendFiles, []);
  assert.deepEqual(result.frontendFiles, []);
  assert.deepEqual(result.sharedFiles, []);
});

test("partitioner - offLimitsGlobs are honored when deciding ownership", () => {
  // Even though `src/main/Service.java` matches frontend's editable globs in some
  // contrived setup, the offLimitsGlobs on frontend should exclude it.
  /** @type {PersonaEntry[]} */
  const personas = [
    { persona: "backend", editableGlobs: ["src/main/**"] },
    {
      persona: "frontend",
      editableGlobs: ["src/**"],
      offLimitsGlobs: ["src/main/**"],
    },
  ];
  const result = partitionWorkstreams(["src/main/Service.java"], personas);
  // Backend owns it cleanly, frontend off-limits = file is backend-only.
  assert.deepEqual(result.backendFiles, ["src/main/Service.java"]);
  assert.deepEqual(result.frontendFiles, []);
  assert.equal(result.mode, "sequential-backend-first");
});

// ---- determineDispatchMode (direct unit) ----

test("determineDispatchMode - shared files always wins even when both buckets are non-empty", () => {
  const mode = determineDispatchMode({
    backendFiles: ["a.java"],
    frontendFiles: ["b.tsx"],
    sharedFiles: ["types.ts"],
  });
  assert.equal(mode, "sequential-shared-first");
});

test("determineDispatchMode - all empty defaults to sequential-shared-first", () => {
  const mode = determineDispatchMode({
    backendFiles: [],
    frontendFiles: [],
    sharedFiles: [],
  });
  assert.equal(mode, "sequential-shared-first");
});

// ---- checkJoinCondition ----

function makeStateRoot() {
  const root = mkdtempSync(join(tmpdir(), "partitioner-test-"));
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  return root;
}

test("checkJoinCondition - returns met=true when both unit-pass gates are pass", async () => {
  const root = makeStateRoot();
  try {
    const gatesPath = join(root, ".devmate", "state", "gates.json");
    writeFileSync(
      gatesPath,
      JSON.stringify({
        "backend-unit-pass": {
          name: "backend-unit-pass",
          status: "pass",
          updatedAt: "2026-06-25T00:00:00Z",
        },
        "frontend-unit-pass": {
          name: "frontend-unit-pass",
          status: "pass",
          updatedAt: "2026-06-25T00:00:00Z",
        },
      }),
      "utf8",
    );
    const result = await checkJoinCondition(gatesPath);
    assert.equal(result.backendUnitPass, true);
    assert.equal(result.frontendUnitPass, true);
    assert.equal(result.met, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkJoinCondition - returns met=false when backend-unit-pass is missing", async () => {
  const root = makeStateRoot();
  try {
    const gatesPath = join(root, ".devmate", "state", "gates.json");
    writeFileSync(
      gatesPath,
      JSON.stringify({
        "frontend-unit-pass": {
          name: "frontend-unit-pass",
          status: "pass",
          updatedAt: "2026-06-25T00:00:00Z",
        },
      }),
      "utf8",
    );
    const result = await checkJoinCondition(gatesPath);
    assert.equal(result.backendUnitPass, false);
    assert.equal(result.frontendUnitPass, true);
    assert.equal(result.met, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkJoinCondition - returns met=false when frontend-unit-pass is missing", async () => {
  const root = makeStateRoot();
  try {
    const gatesPath = join(root, ".devmate", "state", "gates.json");
    writeFileSync(
      gatesPath,
      JSON.stringify({
        "backend-unit-pass": {
          name: "backend-unit-pass",
          status: "pass",
          updatedAt: "2026-06-25T00:00:00Z",
        },
      }),
      "utf8",
    );
    const result = await checkJoinCondition(gatesPath);
    assert.equal(result.backendUnitPass, true);
    assert.equal(result.frontendUnitPass, false);
    assert.equal(result.met, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkJoinCondition - returns met=false when gates file is missing (no throw)", async () => {
  const result = await checkJoinCondition("/nonexistent/path/gates.json");
  assert.equal(result.met, false);
});
