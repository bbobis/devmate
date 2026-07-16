// @ts-check
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../../scripts/view-trace.mjs";

/** @returns {Promise<string>} a fresh tmp root dir */
async function makeTmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "devmate-viewtrace-"));
}

const base = {
  stepId: "step",
  taskId: "feat-1",
  ts: "2026-06-24T12:00:00.000Z",
  schemaVersion: 1,
};

const SAMPLES = {
  action: {
    ...base,
    type: "action",
    actionType: "write",
    path: "p",
    digest: "d",
  },
  gate_transition: {
    ...base,
    type: "gate_transition",
    from: "a",
    to: "b",
    gate: "b",
  },
  loop_attempt: {
    ...base,
    type: "loop_attempt",
    attempt: 1,
    command: ["npm", "test"],
    exitCode: 0,
    digest: "d",
  },
  loop_halt: {
    ...base,
    type: "loop_halt",
    reason: "r",
    attempt: 3,
    last_error: "e",
  },
  step_complete: {
    ...base,
    type: "step_complete",
    label: "l",
    artifactPaths: ["a"],
  },
  fact_write: {
    ...base,
    type: "fact_write",
    factKey: "k",
    scope: "s",
    sourcePointer: "p",
  },
  compaction: {
    ...base,
    type: "compaction",
    artifactPath: "p",
    entriesBefore: 9,
    entriesAfter: 4,
  },
  budget_warning: {
    ...base,
    type: "budget_warning",
    field: "tokens",
    current: 9,
    limit: 10,
  },
};

/**
 * Write a trace file made of the provided raw JSONL lines.
 * @param {string} root
 * @param {string} taskId
 * @param {string[]} lines
 */
async function writeTrace(root, taskId, lines) {
  const dir = path.join(root, ".devmate/state/trace");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${taskId}.jsonl`),
    lines.join("\n") + "\n",
    "utf8",
  );
}

/**
 * Capture stdout while running `fn`.
 * @param {() => Promise<number>} fn
 * @returns {Promise<{ code: number, out: string }>}
 */
async function capture(fn) {
  /** @type {string[]} */
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  /** @type {typeof process.stdout.write} */
  const stub = (/** @type {any} */ chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stdout.write = stub;
  try {
    const code = await fn();
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

test("all eight types, no halts → exit 0, output has type counts", async () => {
  const root = await makeTmpRoot();
  const lines = Object.values(SAMPLES)
    .filter((e) => e.type !== "loop_halt")
    .map((e, i) => JSON.stringify({ ...e, stepId: `step-${i}` }));
  await writeTrace(root, "feat-1", lines);

  const { code, out } = await capture(() =>
    main(["--task", "feat-1", "--root", root]),
  );
  assert.equal(code, 0);
  assert.match(out, /Counts by type:/);
  assert.match(out, /action: 1/);
  assert.match(out, /gate_transition: 1/);
});

test("trace with one loop_halt → exit 1", async () => {
  const root = await makeTmpRoot();
  const lines = [
    JSON.stringify({ ...SAMPLES.action, stepId: "s0" }),
    JSON.stringify({ ...SAMPLES.loop_halt, stepId: "s1" }),
  ];
  await writeTrace(root, "feat-1", lines);

  const { code, out } = await capture(() =>
    main(["--task", "feat-1", "--root", root]),
  );
  assert.equal(code, 1);
  assert.match(out, /loop_halt/);
});

test("2 malformed lines out of 10 (>5%) → exit 1", async () => {
  const root = await makeTmpRoot();
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < 8; i++)
    lines.push(JSON.stringify({ ...SAMPLES.action, stepId: `s${i}` }));
  lines.push("not json at all");
  lines.push('{ "type": "action" }'); // valid JSON but schema-invalid
  await writeTrace(root, "feat-1", lines);

  const { code, out } = await capture(() =>
    main(["--task", "feat-1", "--root", root]),
  );
  assert.equal(code, 1);
  assert.match(out, /malformed/);
});

test("--last 3 on a 10-line trace → exactly 3 event summaries", async () => {
  const root = await makeTmpRoot();
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(JSON.stringify({ ...SAMPLES.action, stepId: `s${i}` }));
  }
  await writeTrace(root, "feat-1", lines);

  const { code, out } = await capture(() =>
    main(["--task", "feat-1", "--last", "3", "--root", root]),
  );
  assert.equal(code, 0);
  // Count lines beginning the per-event summary block (after "Last 3 event(s):").
  const idx = out.indexOf("Last 3 event(s):");
  assert.ok(idx !== -1, 'should print "Last 3 event(s):"');
  const tail = out.slice(idx).split("\n").slice(1); // lines after the header
  const summaries = tail.filter((l) => /^\s{2}\S+\s+\S+\s+action$/.test(l));
  assert.equal(summaries.length, 3);
});

test("missing trace file → exit 1", async () => {
  const root = await makeTmpRoot();
  const { code, out } = await capture(() =>
    main(["--task", "nope", "--root", root]),
  );
  assert.equal(code, 1);
  assert.match(out, /No trace file/);
});
