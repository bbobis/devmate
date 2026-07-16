// @ts-check
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendTraceEvent, traceFilePath } from "../../../lib/trace/append.mjs";

/** @returns {Promise<string>} a fresh tmp root dir */
async function makeTmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "devmate-trace-"));
}

const base = {
  stepId: "step-1",
  taskId: "feat-1",
  ts: "2026-06-24T12:00:00.000Z",
  schemaVersion: 1,
};

/** @type {import('../../../lib/types.mjs').TraceEvent} */
const validEvent = {
  ...base,
  type: "action",
  actionType: "write",
  path: "src/x.mjs",
  digest: "sha256:aa",
};

test("valid event → file contains exactly one JSONL line; lineNumber is 1", async () => {
  const root = await makeTmpRoot();
  const result = await appendTraceEvent(validEvent, { root });
  assert.equal(result.ok, true);
  assert.equal(result.lineNumber, 1);

  const contents = await fsp.readFile(traceFilePath("feat-1", root), "utf8");
  const lines = contents.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), validEvent);
});

test("two sequential appends produce two lines", async () => {
  const root = await makeTmpRoot();
  const r1 = await appendTraceEvent(validEvent, { root });
  const r2 = await appendTraceEvent(
    { ...validEvent, stepId: "step-2" },
    { root },
  );
  assert.equal(r1.lineNumber, 1);
  assert.equal(r2.lineNumber, 2);

  const contents = await fsp.readFile(traceFilePath("feat-1", root), "utf8");
  const lines = contents.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
});

test("invalid event → returns ok:false, file unchanged", async () => {
  const root = await makeTmpRoot();
  // Seed one valid line first.
  await appendTraceEvent(validEvent, { root });
  const filePath = traceFilePath("feat-1", root);
  const before = await fsp.readFile(filePath, "utf8");

  // Missing required base field (stepId) → invalid. Keep taskId so path resolves.
  const bad = /** @type {any} */ ({
    type: "action",
    taskId: "feat-1",
    ts: "t",
    schemaVersion: 1,
    actionType: "w",
    path: "p",
    digest: "d",
  });
  const result = await appendTraceEvent(bad, { root });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);

  const after = await fsp.readFile(filePath, "utf8");
  assert.equal(after, before, "file must be unchanged after a rejected append");
});

test("creates the .devmate/state/trace directory if absent", async () => {
  const root = await makeTmpRoot();
  // Confirm dir does not exist yet.
  await assert.rejects(fsp.access(path.join(root, ".devmate/state/trace")));
  await appendTraceEvent(validEvent, { root });
  // Now it does.
  await fsp.access(path.join(root, ".devmate/state/trace"));
});
