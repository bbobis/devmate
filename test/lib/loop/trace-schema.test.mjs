// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateJsonSchema,
  readTraceFile,
  SCHEMA_VERSION,
  validateTraceEvent,
} from "../../../lib/loop/trace-schema.mjs";

/** @returns {import('../../../lib/types.mjs').LoopAttemptEvent} */
function makeAttempt() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: /** @type {'loop_attempt'} */ ("loop_attempt"),
    attemptId: "a1b2c3",
    taskId: "task-1",
    ts: new Date().toISOString(),
    tier: 1,
    command: ["npm", "test"],
    exitCode: 0,
    outputDigest: "abc123",
    fullOutputPath: ".devmate/output/run1.txt",
  };
}

/** @returns {import('../../../lib/types.mjs').LoopHaltEvent} */
function makeHalt() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: /** @type {'loop_halt'} */ ("loop_halt"),
    attemptId: "halt-1",
    taskId: "task-1",
    ts: new Date().toISOString(),
    reason: "max attempts exceeded",
    lastError: "exit code 1",
    priorAttemptId: null,
  };
}

/** @returns {import('../../../lib/types.mjs').LoopStepCompleteEvent} */
function makeStep() {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: /** @type {'step_complete'} */ ("step_complete"),
    attemptId: "step-1",
    taskId: "task-1",
    ts: new Date().toISOString(),
    stepLabel: "typecheck",
    artifactPaths: [".devmate/output/tsc.txt"],
  };
}

// --- validateTraceEvent tests ---

test("validateTraceEvent — valid loop_attempt event → { ok: true }", () => {
  const result = validateTraceEvent(makeAttempt());
  assert.equal(result.ok, true);
});

test("validateTraceEvent — valid loop_halt event including lastError and priorAttemptId: null → { ok: true }", () => {
  const result = validateTraceEvent(makeHalt());
  assert.equal(result.ok, true);
});

test("validateTraceEvent — valid step_complete event → { ok: true }", () => {
  const result = validateTraceEvent(makeStep());
  assert.equal(result.ok, true);
});

test("validateTraceEvent — missing schemaVersion → { ok: false } with error mentioning schemaVersion", () => {
  const e = /** @type {Record<string, unknown>} */ ({ ...makeAttempt() });
  delete e["schemaVersion"];
  const result = validateTraceEvent(e);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((m) => m.includes("schemaVersion")),
    `errors: ${result.errors.join(", ")}`,
  );
});

test("validateTraceEvent — wrong schemaVersion (e.g. 99) → { ok: false }", () => {
  const e = /** @type {Record<string, unknown>} */ ({
    ...makeAttempt(),
    schemaVersion: 99,
  });
  const result = validateTraceEvent(e);
  assert.equal(result.ok, false);
});

test("validateTraceEvent — unknown type → { ok: false } with error mentioning type", () => {
  const e = /** @type {Record<string, unknown>} */ ({
    ...makeAttempt(),
    type: "unknown_type",
  });
  const result = validateTraceEvent(e);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((m) => m.includes("type")),
    `errors: ${result.errors.join(", ")}`,
  );
});

test("validateTraceEvent — loop_halt missing lastError → { ok: false }", () => {
  const e = /** @type {Record<string, unknown>} */ ({ ...makeHalt() });
  delete e["lastError"];
  const result = validateTraceEvent(e);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((m) => m.includes("lastError")),
    `errors: ${result.errors.join(", ")}`,
  );
});

// --- readTraceFile tests ---

test("readTraceFile — file with two valid lines + one corrupted line → returns both valid events and one corruptedLines entry", () => {
  const base = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const filePath = join(base, "trace.jsonl");
  const traceLines = [
    JSON.stringify(makeAttempt()),
    "NOT_VALID_JSON{{{",
    JSON.stringify(makeHalt()),
  ].join("\n");
  writeFileSync(filePath, traceLines + "\n");

  const result = readTraceFile(filePath);
  assert.equal(result.events.length, 2);
  assert.equal(result.corruptedLines.length, 1);
  assert.ok(result.corruptedLines[0].lineNum >= 1);
  assert.ok(typeof result.corruptedLines[0].raw === "string");
  assert.ok(typeof result.corruptedLines[0].error === "string");

  rmSync(filePath);
});

test("readTraceFile — empty file → { events: [], corruptedLines: [] }", () => {
  const base = join(tmpdir(), `devmate-test-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const filePath = join(base, "empty.jsonl");
  writeFileSync(filePath, "");

  const result = readTraceFile(filePath);
  assert.equal(result.events.length, 0);
  assert.equal(result.corruptedLines.length, 0);

  rmSync(filePath);
});

test("readTraceFile — missing file → { events: [], corruptedLines: [] }", () => {
  const filePath = join(
    tmpdir(),
    `devmate-test-nonexistent-${Date.now()}.jsonl`,
  );
  assert.ok(!existsSync(filePath));
  const result = readTraceFile(filePath);
  assert.equal(result.events.length, 0);
  assert.equal(result.corruptedLines.length, 0);
});

// --- generateJsonSchema tests ---

test("generateJsonSchema — returns object with $schema and oneOf", () => {
  const schema = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (generateJsonSchema())
  );
  assert.ok(typeof schema === "object" && schema !== null);
  assert.ok(typeof schema["$schema"] === "string");
  assert.ok(Array.isArray(schema["oneOf"]));
  assert.equal(/** @type {unknown[]} */ (schema["oneOf"]).length, 3);
});
