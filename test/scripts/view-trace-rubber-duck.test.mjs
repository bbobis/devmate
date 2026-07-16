// @ts-check

/**
 * E11-3: `view-trace` rubber-duck section rendering.
 *
 * Covers:
 *   - 🦆 Grill section appears with edge cases and blocking questions
 *   - 🦆 Critique section appears with verdict and iteration number
 *   - 🔄 Plan Revised section appears with revision number and reason
 *   - When no rubber-duck events exist, none of the three sections appear
 *     (no empty headers)
 */

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../../scripts/view-trace.mjs";

/** @returns {Promise<string>} fresh tmp root */
async function makeTmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "devmate-vtrd-"));
}

/**
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

const base = {
  stepId: "s-rd",
  taskId: "feat-rd",
  ts: "2026-06-24T12:00:00.000Z",
  schemaVersion: 1,
};

const GRILL_LINE = JSON.stringify({
  ...base,
  stepId: "g1",
  type: "grill_complete",
  assumptions: ["users always sign in first"],
  edgeCases: ["empty payload", "unicode names"],
  cornerCases: ["concurrent writes"],
  blockingQuestions: ["What is the auth scheme?"],
});

const CRITIQUE_APPROVE_LINE = JSON.stringify({
  ...base,
  stepId: "c1",
  type: "critique_complete",
  verdict: "APPROVE_PLAN",
  missingTests: [],
  risks: [],
  iterationNumber: 1,
});

const CRITIQUE_REVISION_LINE = JSON.stringify({
  ...base,
  stepId: "c2",
  type: "critique_complete",
  verdict: "REQUEST_REVISION:Missing edge case for empty input",
  missingTests: ["empty input rejection"],
  risks: ["unbounded memory"],
  iterationNumber: 1,
});

const PLAN_REVISED_LINE = JSON.stringify({
  ...base,
  stepId: "p1",
  type: "plan_revised",
  revision: 1,
  reason: "Missing edge case for empty input",
});

const ACTION_LINE = JSON.stringify({
  ...base,
  stepId: "a1",
  type: "action",
  actionType: "write",
  path: "p",
  digest: "d",
});

test("session summary includes Grill section with edge cases and blocking questions", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [GRILL_LINE]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  assert.match(out, /Grill:/);
  assert.match(out, /edgeCases=2/);
  assert.match(out, /blockingQuestions=1/);
  assert.match(out, /edge: empty payload/);
  assert.match(out, /blocking: What is the auth scheme\?/);
});

test("session summary includes Critique section with APPROVE_PLAN verdict and iteration number", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [CRITIQUE_APPROVE_LINE]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  assert.match(out, /Critique:/);
  assert.match(out, /verdict=APPROVE_PLAN/);
  assert.match(out, /iteration=1/);
});

test("session summary includes Critique REQUEST_REVISION with missing tests and risks", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [CRITIQUE_REVISION_LINE]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  assert.match(out, /Critique:/);
  assert.match(out, /verdict=REQUEST_REVISION:/);
  assert.match(out, /missing-test: empty input rejection/);
  assert.match(out, /risk: unbounded memory/);
});

test("session summary includes Plan Revised entry with revision number and reason", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [PLAN_REVISED_LINE]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  assert.match(out, /Plan Revised:/);
  assert.match(out, /revision=1/);
  assert.match(out, /reason=Missing edge case for empty input/);
});

test("session with no rubber-duck events shows no Grill / Critique / Plan Revised sections", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [ACTION_LINE]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  // None of the three section headers should appear when their event bucket is empty.
  assert.doesNotMatch(out, /Grill:/);
  assert.doesNotMatch(out, /Critique:/);
  assert.doesNotMatch(out, /Plan Revised:/);
});

test("session with all three rubber-duck event kinds renders all three sections in order", async () => {
  const root = await makeTmpRoot();
  await writeTrace(root, "feat-rd", [
    GRILL_LINE,
    CRITIQUE_REVISION_LINE,
    PLAN_REVISED_LINE,
  ]);

  const { code, out } = await capture(() =>
    main(["--task", "feat-rd", "--root", root]),
  );
  assert.equal(code, 0);
  const grillIdx = out.indexOf("Grill:");
  const critiqueIdx = out.indexOf("Critique:");
  const revisedIdx = out.indexOf("Plan Revised:");
  assert.ok(grillIdx >= 0 && critiqueIdx >= 0 && revisedIdx >= 0);
  assert.ok(grillIdx < critiqueIdx, "Grill renders before Critique");
  assert.ok(critiqueIdx < revisedIdx, "Critique renders before Plan Revised");
});
