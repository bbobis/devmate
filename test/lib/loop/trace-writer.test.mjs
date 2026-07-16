// @ts-check
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../../../lib/loop/trace-schema.mjs";
import { appendTraceEvent } from "../../../lib/loop/trace-writer.mjs";

/**
 * @param {Partial<import('../../../lib/types.mjs').LoopAttemptEvent>} [overrides]
 * @returns {import('../../../lib/types.mjs').LoopAttemptEvent}
 */
function makeAttempt(overrides = {}) {
  return Object.assign(
    /** @type {import('../../../lib/types.mjs').LoopAttemptEvent} */ ({
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
    }),
    overrides,
  );
}

test("appendTraceEvent — valid event appended → file grows by exactly one JSONL line that round-trips through JSON.parse", async () => {
  const base = join(tmpdir(), `devmate-trace-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const filePath = join(base, "trace.jsonl");

  await appendTraceEvent(filePath, makeAttempt());

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "loop_attempt");
  assert.equal(parsed.attemptId, "a1b2c3");

  rmSync(filePath);
});

test("appendTraceEvent — appending twice produces two lines", async () => {
  const base = join(tmpdir(), `devmate-trace2-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const filePath = join(base, "trace.jsonl");

  await appendTraceEvent(filePath, makeAttempt({ attemptId: "first" }));
  await appendTraceEvent(filePath, makeAttempt({ attemptId: "second" }));

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).attemptId, "first");
  assert.equal(JSON.parse(lines[1]).attemptId, "second");

  rmSync(filePath);
});

test("appendTraceEvent — invalid event → throws without writing", async () => {
  const filePath = join(tmpdir(), `devmate-trace-invalid-${Date.now()}.jsonl`);

  await assert.rejects(
    () =>
      appendTraceEvent(
        filePath,
        /** @type {any} */ ({ type: "bad_type", taskId: "x" }),
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Invalid"), `message: ${err.message}`);
      return true;
    },
  );

  assert.ok(
    !existsSync(filePath),
    "file should not be created for invalid event",
  );
});

test("appendTraceEvent — creates parent directories if they do not exist", async () => {
  const baseDir = join(tmpdir(), `devmate-mkdir-${Date.now()}`);
  const filePath = join(baseDir, "nested", "sub", "trace.jsonl");

  await appendTraceEvent(filePath, makeAttempt());
  assert.ok(existsSync(filePath));

  rmSync(baseDir, { recursive: true });
});
