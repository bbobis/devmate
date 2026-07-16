// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main } from "../../scripts/rollback.mjs";

/**
 * Run a git command synchronously in `cwd`.
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Create a temp git repo with one base commit. Optionally stage a pre-impl
 * stash so a rollback target exists. Returns paths + cwd switch helpers.
 * @param {{ withStash?: boolean }} [opts]
 */
function makeRepo(opts = {}) {
  const prev = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "devmate-rb-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "test"], root);
  writeFileSync(join(root, "a.txt"), "base\n", "utf8");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "base"], root);

  if (opts.withStash) {
    // create an uncommitted change, then stash it (the "pre-impl stash")
    writeFileSync(join(root, "a.txt"), "work in progress\n", "utf8");
    git(["stash", "push", "-q", "-m", "preimpl"], root);
  }

  mkdirSync(resolve(root, ".devmate", "state"), { recursive: true });
  process.chdir(root);
  return {
    root,
    cleanup: () => {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} root
 * @param {Partial<import('../../lib/types.mjs').TaskState>} [over]
 */
function writeState(root, over = {}) {
  /** @type {import('../../lib/types.mjs').TaskState} */
  const state = {
    taskId: "feat-1",
    lane: "feature",
    workflowGate: "impl-started",
    artifactHashes: {},
    preImplStash: "stash@{0}",
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...over,
  };
  const path = resolve(root, ".devmate/state/task.json");
  writeFileSync(path, JSON.stringify(state), "utf8");
  return path;
}

test("rollback main — --dry-run exits 0 and prints the dry summary", async () => {
  const repo = makeRepo({ withStash: true });
  try {
    const sf = writeState(repo.root);
    const code = await main(["--state-file", sf, "--dry-run"]);
    assert.equal(code, 0);
    // working tree must still hold the stash (not popped)
    assert.equal(git(["stash", "list"], repo.root).includes("preimpl"), true);
  } finally {
    repo.cleanup();
  }
});

test("rollback main — no --confirm exits 1 with confirmation message", async () => {
  const repo = makeRepo({ withStash: true });
  try {
    const sf = writeState(repo.root);
    const code = await main(["--state-file", sf]);
    assert.equal(code, 1);
    // stash untouched
    assert.equal(git(["stash", "list"], repo.root).includes("preimpl"), true);
  } finally {
    repo.cleanup();
  }
});

test("rollback main — --confirm --dry-run together: dry-run wins (no mutation)", async () => {
  const repo = makeRepo({ withStash: true });
  try {
    const sf = writeState(repo.root);
    const code = await main(["--state-file", sf, "--confirm", "--dry-run"]);
    assert.equal(code, 0);
    assert.equal(git(["stash", "list"], repo.root).includes("preimpl"), true);
  } finally {
    repo.cleanup();
  }
});

test("rollback main — --confirm with missing stash exits 1 with recovery hints", async () => {
  const repo = makeRepo({ withStash: false }); // no stash created
  try {
    const sf = writeState(repo.root, { preImplStash: "stash@{9}" });
    const code = await main(["--state-file", sf, "--confirm"]);
    assert.equal(code, 1);
  } finally {
    repo.cleanup();
  }
});

test("rollback main — --confirm with dirty tree exits 1 with dirty-state message", async () => {
  const repo = makeRepo({ withStash: true });
  try {
    const sf = writeState(repo.root);
    // dirty the tree
    writeFileSync(join(repo.root, "a.txt"), "dirty edit\n", "utf8");
    const code = await main(["--state-file", sf, "--confirm"]);
    assert.equal(code, 1);
    // stash still present — no mutation happened
    assert.equal(git(["stash", "list"], repo.root).includes("preimpl"), true);
  } finally {
    repo.cleanup();
  }
});

test("rollback main — missing preImplStash exits 1", async () => {
  const repo = makeRepo({ withStash: false });
  try {
    const sf = writeState(repo.root, { preImplStash: null });
    const code = await main(["--state-file", sf, "--confirm"]);
    assert.equal(code, 1);
  } finally {
    repo.cleanup();
  }
});
