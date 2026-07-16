// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../../scripts/assert-ac-coverage.mjs";
import { appendTraceEvent } from "../../lib/trace/append.mjs";

const SPEC = [
  "# Spec: demo",
  "",
  "## Acceptance criteria",
  "- [ ] AC1: first criterion",
  "- [ ] AC2: second criterion",
  "- [ ] AC3: third criterion",
  "",
].join("\n");

/** A spec whose AC heading is malformed — parses to zero criteria. */
const MALFORMED_SPEC = [
  "# Spec: demo",
  "",
  "## Acceptance Criterias",
  "- [ ] AC1: first criterion",
  "",
].join("\n");

/**
 * Build a temp repo with a `task.json` + `spec.md` fixture.
 * @param {{ taskId: string, lane?: string, spec?: string, withState?: boolean }} opts
 * @returns {Promise<{ repo: string, specPath: string, statePath: string }>}
 */
async function makeRepo({ taskId, lane = "feature", spec = SPEC, withState = true }) {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "devmate-accoverage-"));
  const stateDir = path.join(repo, ".devmate", "state");
  const sessionDir = path.join(repo, ".devmate", "session");
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(sessionDir, { recursive: true });
  const specPath = path.join(sessionDir, "spec.md");
  await fsp.writeFile(specPath, spec, "utf8");
  const statePath = path.join(stateDir, "task.json");
  if (withState) {
    const state = {
      taskId,
      lane,
      workflowGate: "impl-started",
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    };
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }
  return { repo, specPath, statePath };
}

/**
 * Record an `impl-AC{n}` `step_complete` event in the given repo's trace.
 * @param {string} repo
 * @param {string} taskId
 * @param {number} n
 * @returns {Promise<void>}
 */
async function completeAc(repo, taskId, n) {
  const append = await appendTraceEvent(
    {
      type: "step_complete",
      stepId: `impl-AC${n}`,
      taskId,
      ts: new Date().toISOString(),
      schemaVersion: 1,
      label: `AC${n}`,
      artifactPaths: [],
    },
    { root: repo },
  );
  assert.ok(append.ok, `failed to seed impl-AC${n}: ${(append.errors || []).join("; ")}`);
}

/** Capture the script's single-line JSON stdout during the test. */
function captureStdout() {
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = /** @type {any} */ (
    (/** @type {string} */ chunk) => {
      captured += chunk;
      return true;
    }
  );
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => captured,
  };
}

test("assert-ac-coverage: partial completion reports missing AC, exit 1", async () => {
  const t = "feat-partial";
  const { repo } = await makeRepo({ taskId: t });
  await completeAc(repo, t, 1);
  await completeAc(repo, t, 3);

  const capture = captureStdout();
  let code;
  try {
    code = await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }
  assert.equal(code, 1);

  const printed = JSON.parse(capture.text().trim());
  assert.equal(printed.ok, false);
  assert.equal(printed.total, 3);
  assert.equal(printed.completed, 2);
  assert.equal(printed.coveragePercent, 66);
  assert.deepEqual(printed.missing, [{ id: 2, text: "second criterion" }]);
});

test("assert-ac-coverage: all ACs complete is ok, exit 0", async () => {
  const t = "feat-complete";
  const { repo } = await makeRepo({ taskId: t });
  await completeAc(repo, t, 1);
  await completeAc(repo, t, 2);
  await completeAc(repo, t, 3);

  const capture = captureStdout();
  let code;
  try {
    code = await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }
  assert.equal(code, 0);

  const printed = JSON.parse(capture.text().trim());
  assert.equal(printed.ok, true);
  assert.equal(printed.total, 3);
  assert.equal(printed.completed, 3);
  assert.equal(printed.coveragePercent, 100);
  assert.deepEqual(printed.missing, []);
});

test("assert-ac-coverage: feature lane with zero parsed ACs fails closed, exit 1", async () => {
  const t = "feat-zero";
  const { repo } = await makeRepo({ taskId: t, spec: MALFORMED_SPEC });

  const capture = captureStdout();
  let code;
  try {
    code = await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }
  assert.equal(code, 1);

  const printed = JSON.parse(capture.text().trim());
  assert.equal(printed.ok, false);
  assert.equal(printed.total, 0);
  assert.match(
    printed.error,
    /no acceptance criteria parsed from spec\.md \(feature lane requires at least one\)/,
  );
});

test("assert-ac-coverage: chore lane with zero parsed ACs passes vacuously, exit 0", async () => {
  const t = "chore-zero";
  const { repo } = await makeRepo({ taskId: t, lane: "chore", spec: MALFORMED_SPEC });

  const capture = captureStdout();
  let code;
  try {
    code = await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }
  assert.equal(code, 0);

  const printed = JSON.parse(capture.text().trim());
  assert.equal(printed.ok, true);
  assert.equal(printed.total, 0);
  assert.equal(printed.error, null);
});

test("assert-ac-coverage: unresolved taskId fails cleanly, exit 1", async () => {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "devmate-accoverage-"));

  const capture = captureStdout();
  let code;
  try {
    code = await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }
  assert.equal(code, 1);

  const printed = JSON.parse(capture.text().trim());
  assert.equal(printed.ok, false);
  assert.match(printed.error, /task id unresolved/);
});

test("assert-ac-coverage: result file matches the printed JSON line byte-for-byte", async () => {
  const t = "feat-parity";
  const { repo } = await makeRepo({ taskId: t });
  await completeAc(repo, t, 1);

  const capture = captureStdout();
  try {
    await main(["--repo-root", repo]);
  } finally {
    capture.restore();
  }

  const printedLine = capture.text().trim();
  const resultRaw = await fsp.readFile(
    path.join(repo, ".devmate", "state", "assert-ac-coverage-result.json"),
    "utf8",
  );
  assert.equal(resultRaw, printedLine);
});
