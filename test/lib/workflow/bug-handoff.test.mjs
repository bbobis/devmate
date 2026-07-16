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
  assertDiagnosisResult,
  dispatchFixer,
  FIXER_TARGET,
  selectFixer,
  UNKNOWN_SCOPE,
  validateDiagnosisResult,
} from "../../../lib/workflow/bug-handoff.mjs";

/** @typedef {import('../../../lib/types.mjs').DiagnosisResult} DiagnosisResult */
/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

/**
 * @param {Partial<DiagnosisResult>} [over]
 * @returns {DiagnosisResult}
 */
function makeDiagnosis(over = {}) {
  return {
    bugScope: "backend",
    suspectedLayer: "Service layer null-check",
    reproCommand: "npm test -- --grep order-total",
    fixerRecommendation: "Add null guard before sum.",
    // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
    // @diagnose has no edit tool and never could write the scope.md its own
    // prompt asked it for.
    allowedPaths: ['src/app.mjs'],
    allowedGlobs: [],
    taskId: "bug-42",
    schemaVersion: 1,
    ...over,
  };
}

/**
 * @param {Partial<TaskState>} [over]
 * @returns {TaskState}
 */
function makeState(over = {}) {
  return {
    taskId: "bug-42",
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

/** @returns {{ statePath: string, transitionsPath: string, cleanup: () => void }} */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "bug-handoff-test-"));
  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  return {
    statePath: resolve(root, ".devmate/state/task.json"),
    transitionsPath: resolve(root, ".devmate/state/transitions.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// validateDiagnosisResult
// ---------------------------------------------------------------------------

test("validateDiagnosisResult — reports missing bugScope", () => {
  const d = makeDiagnosis();
  // @ts-expect-error intentional removal
  delete d.bugScope;
  const result = validateDiagnosisResult(d);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /bugScope/);
});

test("validateDiagnosisResult — reports missing reproCommand", () => {
  const d = makeDiagnosis();
  // @ts-expect-error intentional removal
  delete d.reproCommand;
  const result = validateDiagnosisResult(d);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /reproCommand/);
});

test("validateDiagnosisResult — passes on fully populated object", () => {
  const d = validateDiagnosisResult(makeDiagnosis());
  assert.equal(d.ok, true);
  assert.deepEqual(d.errors, []);
});

test("assertDiagnosisResult — throws on invalid diagnosis", () => {
  const d = makeDiagnosis();
  // @ts-expect-error intentional removal
  delete d.reproCommand;
  assert.throws(() => assertDiagnosisResult(d), /reproCommand/);
});

// ---------------------------------------------------------------------------
// selectFixer (E10: one generic agent + persona)
// ---------------------------------------------------------------------------

test("selectFixer — backend persona routes to @fullstack carrying persona", () => {
  const sel = selectFixer(makeDiagnosis({ bugScope: "backend" }));
  assert.equal(sel.target, FIXER_TARGET);
  assert.equal(sel.target, "@fullstack");
  assert.equal(sel.persona, "backend");
});

test("selectFixer — frontend persona routes to @fullstack carrying persona", () => {
  const sel = selectFixer(makeDiagnosis({ bugScope: "frontend" }));
  assert.equal(sel.target, "@fullstack");
  assert.equal(sel.persona, "frontend");
});

test("selectFixer — arbitrary config persona is honored (open list)", () => {
  const sel = selectFixer(makeDiagnosis({ bugScope: "data-platform" }));
  assert.equal(sel.target, "@fullstack");
  assert.equal(sel.persona, "data-platform");
});

test("selectFixer — unknown scope routes to @fullstack with warning reason", () => {
  const sel = selectFixer(makeDiagnosis({ bugScope: UNKNOWN_SCOPE }));
  assert.equal(sel.target, "@fullstack");
  assert.equal(sel.persona, UNKNOWN_SCOPE);
  assert.match(sel.reason, /confirm/i);
});

// ---------------------------------------------------------------------------
// dispatchFixer
// ---------------------------------------------------------------------------

test("dispatchFixer — happy path persists scope to state and writes trace", async () => {
  const ws = makeWorkspace();
  try {
    const res = await dispatchFixer(makeDiagnosis(), makeState(), {
      statePath: ws.statePath,
      transitionsPath: ws.transitionsPath,
    });
    assert.equal(res.target, "@fullstack");
    assert.equal(res.persona, "backend");
    assert.equal(res.stateUpdated, true);

    const onDisk = JSON.parse(readFileSync(ws.statePath, "utf8"));
    assert.equal(onDisk.bugScope, "backend");
    assert.equal(onDisk.fixerTarget, "@fullstack");

    assert.ok(existsSync(ws.transitionsPath));
    const lines = readFileSync(ws.transitionsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.equal(evt.event, "bug_handoff");
    assert.equal(evt.target, "@fullstack");
    assert.equal(evt.persona, "backend");
    assert.equal(evt.taskId, "bug-42");
  } finally {
    ws.cleanup();
  }
});

test("dispatchFixer — rejects invalid diagnosis object", async () => {
  const ws = makeWorkspace();
  try {
    const bad = makeDiagnosis();
    // @ts-expect-error intentional removal
    delete bad.reproCommand;
    await assert.rejects(
      () =>
        dispatchFixer(bad, makeState(), {
          statePath: ws.statePath,
          transitionsPath: ws.transitionsPath,
        }),
      /reproCommand/,
    );
  } finally {
    ws.cleanup();
  }
});

