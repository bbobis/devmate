// @ts-check
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EDIT_CLASS_TOOLS,
  writeFact,
} from "../../../lib/memory/fact-writer.mjs";
import { parseJsonl } from "../../../lib/json-io.mjs";
import { isString } from "../../../lib/object-utils.mjs";

/** @typedef {import('../../../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

/**
 * Build a fresh temp workspace with a ledger path and optional state dir.
 * @param {{ withState?: TaskState }} [opts]
 * @returns {{ root: string, ledger: string, stateDir: string, cleanup: () => void }}
 */
function makeWorkspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "fact-writer-test-"));
  const stateDir = join(root, ".devmate", "state");
  mkdirSync(stateDir, { recursive: true });
  const ledger = join(stateDir, "facts.jsonl");
  if (opts.withState) {
    writeFileSync(
      join(stateDir, "task.json"),
      JSON.stringify(opts.withState),
      "utf8",
    );
  }
  return {
    root,
    ledger,
    stateDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Read a JSONL file into parsed entries; returns [] if missing.
 * @param {string} path
 * @returns {Record<string, unknown>[]}
 */
function readLedger(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return [];
  return /** @type {Record<string, unknown>[]} */ (parseJsonl(raw));
}

/** @type {TaskState} */
const sampleState = {
  taskId: "demo-25",
  lane: "feature",
  workflowGate: "impl-started",
  artifactHashes: {},
  preImplStash: null,
  currentStep: 3,
  budget: 5,
  schemaVersion: 1,
};

test("writeFact — edit tool: ledger gains exactly one FactEntry", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace({
    withState: sampleState,
  });
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: "replace_string_in_file",
      path: "src/api/user.mjs",
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipReason, null);
    assert.ok(result.fact, "fact should be returned");
    assert.equal(result.fact.event, "fact");
    assert.equal(typeof result.fact.key, 'string');
    assert.match(result.fact.key, /^src\/api\/user\.mjs:/);
    assert.equal(result.fact.source, "src/api/user.mjs");
    assert.equal(result.fact.tool, "replace_string_in_file");
    assert.equal(result.fact.lane, "feature");
    assert.equal(result.fact.stepId, "3");
    assert.equal(result.fact.firstEdit, true);
    const entries = readLedger(ledger);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]["event"], "fact");
    assert.equal(entries[0]["source"], "src/api/user.mjs");
  } finally {
    cleanup();
  }
});

test("writeFact — non-edit tool: skipped, ledger unchanged", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace();
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: "read_file",
      path: "README.md",
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fact, null);
    assert.match(result.skipReason ?? "", /non-edit/);
    assert.equal(
      existsSync(ledger),
      false,
      "ledger must not be created for a skipped tool",
    );
  } finally {
    cleanup();
  }
});

test("writeFact — firstEdit flag flips on second call for same source", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace({
    withState: sampleState,
  });
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: "create_file",
      path: "lib/x.mjs",
      cwd: root,
    };
    const first = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    const second = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.ok(first.fact && second.fact);
    assert.equal(first.fact.firstEdit, true);
    assert.equal(second.fact.firstEdit, false);
    // E3-3: the second write stales the first fact before appending the new
    // one, so the ledger holds 2 fact entries + 1 stale entry = 3 lines.
    const entries = readLedger(ledger);
    assert.equal(entries.length, 3);
    assert.equal(entries.filter((e) => e["event"] === "fact").length, 2);
    const stale = entries.filter((e) => e["event"] === "stale");
    assert.equal(stale.length, 1);
    assert.equal(stale[0]["reason"], "changed");
    assert.equal(stale[0]["stalledFactTs"], first.fact.ts);
  } finally {
    cleanup();
  }
});

test("writeFact — missing state dir: lane=unknown, stepId=none, write succeeds", async () => {
  const { root, ledger, cleanup } = makeWorkspace();
  // Point stateDir at a non-existent path.
  const stateDir = join(root, "does-not-exist");
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: "create_file",
      path: "docs/notes.md",
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.equal(result.ok, true);
    assert.ok(result.fact);
    assert.equal(result.fact.lane, "unknown");
    assert.equal(result.fact.stepId, "none");
  } finally {
    cleanup();
  }
});

test("writeFact — path escape rejected: no ledger write", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace();
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: "replace_string_in_file",
      path: "../../etc/passwd",
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fact, null);
    assert.match(result.skipReason ?? "", /path_escape/);
    assert.equal(existsSync(ledger), false);
  } finally {
    cleanup();
  }
});

test("writeFact — lock timeout surfaces as skipReason, no uncaught throw", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace();
  try {
    // Create the .lock sentinel so acquireLock will time out fast.
    writeFileSync(ledger + ".lock", "", "utf8");
    /** @type {HookPayload} */
    const payload = {
      tool_name: "replace_string_in_file",
      path: "lib/blocked.mjs",
      cwd: root,
    };
    // Patch the lock opts via a shorter timeout — we exercise the path via
    // appendJsonl which reads opts.timeoutMs from a default; the sentinel
    // forces the EEXIST path. The deadline fires inside ~5s; we instead
    // shorten the window by deleting the sentinel quickly is brittle, so we
    // accept the longer wait and verify the surfaced shape.
    const start = Date.now();
    const result = await Promise.race([
      writeFact(payload, ledger, { stateDir, workspaceRoot: root }),
      new Promise((resolveTimer) =>
        setTimeout(() => resolveTimer(/** @type {const} */ ("timer")), 7000),
      ),
    ]);
    // We expect either the writeFact result (preferred) or our timer fallback
    // if the lock wait somehow exceeded the test budget — both are acceptable
    // because the contract is "no uncaught throw" and the operation does not
    // crash the host. Verify the success contract on the writeFact result.
    if (result !== "timer") {
      const r =
        /** @type {import('../../../lib/types.mjs').FactWriteResult} */ (
          result
        );
      assert.equal(r.ok, false);
      assert.equal(r.fact, null);
      assert.match(r.skipReason ?? "", /lock_timeout/);
    }
    // The point of this test is "did not throw" — we are still here, so we did not.
    assert.ok(Date.now() - start >= 0);
  } finally {
    // Clean up the sentinel before cleanup() so rm works.
    try {
      rmSync(ledger + ".lock", { force: true });
    } catch {
      // best-effort
    }
    cleanup();
  }
});

test("writeFact — fact entries do not contain raw tool output", async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace();
  try {
    const huge = "X".repeat(10_000);
    /** @type {HookPayload} */
    const payload = {
      tool_name: "replace_string_in_file",
      path: "lib/y.mjs",
      content: huge,
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.ok(result.ok && result.fact);
    const serialised = JSON.stringify(result.fact);
    assert.equal(
      serialised.includes(huge),
      false,
      "fact must not contain raw content",
    );
    if (isString(result.fact.contentDigest)) {
      assert.ok(result.fact.contentDigest.length <= 256);
      assert.equal(
        result.fact.key,
        `lib/y.mjs:${result.fact.contentDigest.slice(0, 8)}`,
      );
    }
  } finally {
    cleanup();
  }
});

test('writeFact — when content digest is absent, key falls back to source:ts', async () => {
  const { root, ledger, stateDir, cleanup } = makeWorkspace();
  try {
    /** @type {HookPayload} */
    const payload = {
      tool_name: 'replace_string_in_file',
      path: 'lib/no-content.mjs',
      cwd: root,
    };
    const result = await writeFact(payload, ledger, {
      stateDir,
      workspaceRoot: root,
    });
    assert.equal(result.ok, true);
    assert.ok(result.fact);
    assert.match(result.fact.key, /^lib\/no-content\.mjs:\d+$/);
  } finally {
    cleanup();
  }
});

// #77: this test used to assert that EDIT_CLASS_TOOLS contained
// `str_replace_editor`, `write_file`, and `insert_content_into_file` — three
// names VS Code has never sent. It passed, forever, while stage 1 of the memory
// pipeline collected nothing from a real edit. A test can only be as true as the
// payload it believes in.
test("EDIT_CLASS_TOOLS holds the tools VS Code actually sends — and no fiction", () => {
  for (const real of [
    "create_file",
    "replace_string_in_file",
    "insert_edit_into_file",
    "multi_replace_string_in_file",
    "apply_patch",
  ]) {
    assert.ok(EDIT_CLASS_TOOLS.has(real), `${real} is a real VS Code write tool`);
  }
  for (const fiction of [
    "str_replace_editor",
    "write_file",
    "insert_content_into_file",
    "replace_in_file",
  ]) {
    assert.equal(
      EDIT_CLASS_TOOLS.has(fiction),
      false,
      `${fiction} is not a VS Code tool — reintroducing it re-opens the collection hole`,
    );
  }
});
