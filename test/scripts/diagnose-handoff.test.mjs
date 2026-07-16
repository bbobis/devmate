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
import { main } from "../../scripts/diagnose-handoff.mjs";

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').DiagnosisResult} DiagnosisResult */

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over) {
  return {
    taskId: "bug-77",
    lane: "bug",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {Partial<DiagnosisResult>} [over]
 * @returns {DiagnosisResult}
 */
function makeDiagnosis(over) {
  return {
    bugScope: "backend",
    suspectedLayer: "service",
    reproCommand: "npm test",
    fixerRecommendation: "guard null",
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/app.mjs'],
    allowedGlobs: [],
    taskId: "bug-77",
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {object} [o]
 * @param {Partial<TaskState>} [o.stateOver]
 * @returns {{ dir: string, statePath: string, diagPath: string, transitionsPath: string, cleanup: () => void }}
 */
function makeFixture(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), "devmate-diagnose-handoff-"));
  const stateDir = join(dir, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "task.json");
  const diagPath = join(dir, "diagnosis.json");
  const transitionsPath = join(stateDir, "transitions.jsonl");
  writeFileSync(
    statePath,
    JSON.stringify(makeState(o.stateOver), null, 2),
    "utf8",
  );
  return {
    dir,
    statePath,
    diagPath,
    transitionsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("main — exits 0 with a valid diagnosis file and updates state", async () => {
  const fx = makeFixture();
  const prev = process.env.DEVMATE_TRANSITIONS_PATH;
  process.env.DEVMATE_TRANSITIONS_PATH = fx.transitionsPath;
  try {
    writeFileSync(fx.diagPath, JSON.stringify(makeDiagnosis()), "utf8");
    const code = await main([
      "--diagnosis-file",
      fx.diagPath,
      "--state-path",
      fx.statePath,
    ]);
    assert.equal(code, 0);
    const onDisk = JSON.parse(readFileSync(fx.statePath, "utf8"));
    assert.equal(onDisk.bugScope, "backend");
    assert.equal(onDisk.fixerTarget, "@fullstack");
  } finally {
    if (prev === undefined) delete process.env.DEVMATE_TRANSITIONS_PATH;
    else process.env.DEVMATE_TRANSITIONS_PATH = prev;
    fx.cleanup();
  }
});

test("main — exits 1 with malformed JSON", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.diagPath, "{ not valid json", "utf8");
    const code = await main([
      "--diagnosis-file",
      fx.diagPath,
      "--state-path",
      fx.statePath,
    ]);
    assert.equal(code, 1);
  } finally {
    fx.cleanup();
  }
});

test("main — exits 1 with missing required fields", async () => {
  const fx = makeFixture();
  try {
    const bad = makeDiagnosis();
    // @ts-expect-error intentional removal
    delete bad.reproCommand;
    writeFileSync(fx.diagPath, JSON.stringify(bad), "utf8");
    const code = await main([
      "--diagnosis-file",
      fx.diagPath,
      "--state-path",
      fx.statePath,
    ]);
    assert.equal(code, 1);
  } finally {
    fx.cleanup();
  }
});

test("main — exits 1 when TaskState is missing", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(fx.diagPath, JSON.stringify(makeDiagnosis()), "utf8");
    const code = await main([
      "--diagnosis-file",
      fx.diagPath,
      "--state-path",
      join(fx.dir, "nope.json"),
    ]);
    assert.equal(code, 1);
  } finally {
    fx.cleanup();
  }
});
