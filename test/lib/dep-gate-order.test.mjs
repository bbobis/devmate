// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkPrerequisites,
  DEP_GATE_PREREQUISITES,
  OrderViolationError,
  setDependencyGate,
} from "../../lib/dependency-gates.mjs";

/** @typedef {import('../../lib/types.mjs').DepGateEntry} DepGateEntry */

/**
 * Build a minimal gates object with a set of gates all set to 'pass'.
 * @param {string[]} names
 * @returns {Record<string, DepGateEntry>}
 */
function makePassGates(names) {
  const now = new Date().toISOString();
  /** @type {Record<string, DepGateEntry>} */
  const gates = {};
  for (const name of names) {
    gates[name] = {
      name: /** @type {any} */ (name),
      status: "pass",
      updatedAt: now,
    };
  }
  return gates;
}

// ─── checkPrerequisites pure-function tests ───────────────────────────────────

test("checkPrerequisites: backend-unit-pass has no prereqs → ok=true", () => {
  const result = checkPrerequisites("backend-unit-pass", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("checkPrerequisites: frontend-unit-pass has no prereqs → ok=true", () => {
  const result = checkPrerequisites("frontend-unit-pass", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("checkPrerequisites: backend-ready with backend-unit-pass absent → missing=[backend-unit-pass]", () => {
  const result = checkPrerequisites("backend-ready", {});
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["backend-unit-pass"]);
});

test("checkPrerequisites: backend-ready with backend-unit-pass pass → ok=true", () => {
  const gates = makePassGates(["backend-unit-pass"]);
  const result = checkPrerequisites("backend-ready", gates);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("checkPrerequisites: all-tests-pass with all prereqs missing → missing has all three", () => {
  const result = checkPrerequisites("all-tests-pass", {});
  assert.equal(result.ok, false);
  // must include all three prereqs
  assert.ok(result.missing.includes("backend-unit-pass"));
  assert.ok(result.missing.includes("frontend-unit-pass"));
  assert.ok(result.missing.includes("backend-ready"));
});

test("checkPrerequisites: all-tests-pass with only frontend-unit-pass missing → missing=[frontend-unit-pass]", () => {
  const gates = makePassGates(["backend-unit-pass", "backend-ready"]);
  const result = checkPrerequisites("all-tests-pass", gates);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["frontend-unit-pass"]);
});

test("checkPrerequisites: all-tests-pass with all prereqs pass → ok=true", () => {
  const gates = makePassGates([
    "backend-unit-pass",
    "frontend-unit-pass",
    "backend-ready",
  ]);
  const result = checkPrerequisites("all-tests-pass", gates);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

// ─── DEP_GATE_PREREQUISITES export ───────────────────────────────────────────

test("DEP_GATE_PREREQUISITES exported and has correct shapes", () => {
  assert.ok(typeof DEP_GATE_PREREQUISITES === "object");
  assert.deepEqual(DEP_GATE_PREREQUISITES["backend-unit-pass"], []);
  assert.deepEqual(DEP_GATE_PREREQUISITES["backend-ready"], [
    "backend-unit-pass",
  ]);
  assert.deepEqual(DEP_GATE_PREREQUISITES["frontend-unit-pass"], []);
  assert.ok(
    DEP_GATE_PREREQUISITES["all-tests-pass"].includes("backend-unit-pass"),
  );
  assert.ok(
    DEP_GATE_PREREQUISITES["all-tests-pass"].includes("frontend-unit-pass"),
  );
  assert.ok(DEP_GATE_PREREQUISITES["all-tests-pass"].includes("backend-ready"));
});

// ─── OrderViolationError class ────────────────────────────────────────────────

test("OrderViolationError message includes gate name and missing prereqs", () => {
  const err = new OrderViolationError({
    gate: "backend-ready",
    missing: ["backend-unit-pass"],
  });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OrderViolationError);
  assert.ok(err.message.includes("backend-ready"));
  assert.ok(err.message.includes("backend-unit-pass"));
  assert.equal(err.name, "OrderViolationError");
});

// ─── setDependencyGate integration tests ─────────────────────────────────────

/**
 * Create a temp dir with a gates.json path (but don't create the file yet).
 * Returns the statePath and a cleanup function.
 * @returns {{ dir: string, statePath: string, violationsPath: string, cleanup: () => void }}
 */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "devmate-test-"));
  const stateDir = join(dir, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "gates.json");
  const violationsPath = join(stateDir, "gate-violations.jsonl");
  return {
    dir,
    statePath,
    violationsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("setDependencyGate: backend-unit-pass (no prereqs) can always be set to pass", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-unit-pass", "pass", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-unit-pass"].status, "pass");
  } finally {
    cleanup();
  }
});

test("setDependencyGate: backend-ready to pass without prereq → throws OrderViolationError", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await assert.rejects(
      () => setDependencyGate("backend-ready", "pass", statePath),
      (err) => {
        assert.ok(
          err instanceof OrderViolationError,
          `expected OrderViolationError, got ${String(err)}`,
        );
        assert.ok(err.message.includes("backend-unit-pass"));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("setDependencyGate: backend-ready to fail (not pass) without prereq → succeeds", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-ready", "fail", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-ready"].status, "fail");
  } finally {
    cleanup();
  }
});

test("setDependencyGate: all-tests-pass to pass with all prereqs → succeeds", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-unit-pass", "pass", statePath);
    await setDependencyGate("frontend-unit-pass", "pass", statePath);
    await setDependencyGate("backend-ready", "pass", statePath);
    await setDependencyGate("all-tests-pass", "pass", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["all-tests-pass"].status, "pass");
  } finally {
    cleanup();
  }
});

test("setDependencyGate: all-tests-pass without frontend-unit-pass → throws with missing=[frontend-unit-pass]", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-unit-pass", "pass", statePath);
    await setDependencyGate("backend-ready", "pass", statePath);
    await assert.rejects(
      () => setDependencyGate("all-tests-pass", "pass", statePath),
      (err) => {
        assert.ok(err instanceof OrderViolationError);
        assert.ok(err.message.includes("frontend-unit-pass"));
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("setDependencyGate: force=true bypasses check and appends violation entry", async () => {
  const { statePath, violationsPath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-ready", "pass", statePath, {
      force: true,
      violationsPath,
    });
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-ready"].status, "pass");
    const lines = readFileSync(violationsPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.gate, "backend-ready");
    assert.ok(entry.missing.includes("backend-unit-pass"));
    assert.equal(entry.forced, true);
    assert.ok(typeof entry.timestamp === "string");
  } finally {
    cleanup();
  }
});

test("setDependencyGate: full chain in order → all succeed, no violations", async () => {
  const { statePath, violationsPath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-unit-pass", "pass", statePath);
    await setDependencyGate("frontend-unit-pass", "pass", statePath);
    await setDependencyGate("backend-ready", "pass", statePath);
    await setDependencyGate("all-tests-pass", "pass", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-unit-pass"].status, "pass");
    assert.equal(data["frontend-unit-pass"].status, "pass");
    assert.equal(data["backend-ready"].status, "pass");
    assert.equal(data["all-tests-pass"].status, "pass");
    // No violations file should exist
    let violationsExist = false;
    try {
      readFileSync(violationsPath, "utf8");
      violationsExist = true;
    } catch (_) {
      violationsExist = false;
    }
    assert.equal(violationsExist, false);
  } finally {
    cleanup();
  }
});

test("setDependencyGate: gatectl dependency set backend-ready pass without prereq → error message has OrderViolation", async () => {
  const { statePath, cleanup } = makeTempDir();
  let caught = null;
  try {
    await setDependencyGate("backend-ready", "pass", statePath);
  } catch (/** @type {unknown} */ err) {
    caught = err;
  } finally {
    cleanup();
  }
  assert.ok(caught instanceof OrderViolationError);
  assert.ok(/** @type {Error} */ (caught).message.includes("Order violation"));
});

test("setDependencyGate: setting backend-ready to pending without prereq → succeeds (only pass is blocked)", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-ready", "pending", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-ready"].status, "pending");
  } finally {
    cleanup();
  }
});

test("setDependencyGate: setting backend-ready to skipped without prereq → succeeds (only pass is blocked)", async () => {
  const { statePath, cleanup } = makeTempDir();
  try {
    await setDependencyGate("backend-ready", "skipped", statePath);
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(data["backend-ready"].status, "skipped");
  } finally {
    cleanup();
  }
});

test("checkPrerequisites: backend-ready with backend-unit-pass=fail (not pass) → missing=[backend-unit-pass]", () => {
  const now = new Date().toISOString();
  const gates = {
    "backend-unit-pass": {
      name: /** @type {any} */ ("backend-unit-pass"),
      status: /** @type {any} */ ("fail"),
      updatedAt: now,
    },
  };
  const result = checkPrerequisites("backend-ready", gates);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("backend-unit-pass"));
});

test("violations file absent when no force used on gate with prereqs unsatisfied (throws instead)", async () => {
  const { statePath, violationsPath, cleanup } = makeTempDir();
  try {
    try {
      await setDependencyGate("backend-ready", "pass", statePath);
    } catch (_) {
      // expected
    }
    let violationsExist = false;
    try {
      readFileSync(violationsPath, "utf8");
      violationsExist = true;
    } catch (_) {
      violationsExist = false;
    }
    assert.equal(
      violationsExist,
      false,
      "violations file must not be created when force=false",
    );
  } finally {
    cleanup();
  }
});
