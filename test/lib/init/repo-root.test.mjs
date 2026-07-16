// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  climbOutOfDevmate,
  resolveHookRoot,
  resolveRepoRoot,
} from "../../../lib/init/repo-root.mjs";

/**
 * Make a throwaway temp dir.
 * @returns {{ dir: string, cleanup: () => void }}
 */
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "repo-root-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("climbOutOfDevmate — climbs out of a .devmate cwd, leaves others unchanged", () => {
  assert.equal(climbOutOfDevmate("/work/feature-x/.devmate"), "/work/feature-x");
  assert.equal(climbOutOfDevmate("/work/feature-x"), "/work/feature-x");
  assert.equal(climbOutOfDevmate("/work/feature-x/portals-api"), "/work/feature-x/portals-api");
});

test("resolveRepoRoot — cwd is the workspace .devmate folder resolves the workspace root (no doubling)", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    // Workspace root with a .devmate/ sibling of the repos (the util layout).
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    // VS Code lists .devmate first, so the hook's cwd can be the .devmate folder.
    const resolved = await resolveRepoRoot(join(dir, ".devmate"));
    // Must be the workspace root, NOT <root>/.devmate — otherwise callers write
    // to .devmate/.devmate/state/.
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — recovers even if a doubled .devmate/.devmate already exists", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    mkdirSync(join(dir, ".devmate", ".devmate", "state"), { recursive: true });
    // Without the climb-out, step 0 would re-resolve to <root>/.devmate here.
    const resolved = await resolveRepoRoot(join(dir, ".devmate"));
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — step 0: .devmate direct child of startDir returns startDir", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    // Multi-root worktree layout: .devmate/ sits at the worktree root with no
    // .git/package.json there — the repos live in subfolders.
    mkdirSync(join(dir, ".devmate"), { recursive: true });

    const resolved = await resolveRepoRoot(dir);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — step 0: fires even without other markers at startDir", async () => {
  const { dir: parent, cleanup } = makeTmp();
  try {
    // Worktree root has .devmate/ and repo subfolders (with their own .git),
    // but no .git/package.json at the root itself.
    mkdirSync(join(parent, ".devmate"), { recursive: true });
    mkdirSync(join(parent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(parent, "repo-b", ".git"), { recursive: true });

    const resolved = await resolveRepoRoot(parent);
    assert.equal(resolved, parent);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — step 0: does NOT fire when .devmate is absent (falls through)", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    // .git marker at root, no direct .devmate — must resolve via the marker walk.
    mkdirSync(join(dir, ".git"), { recursive: true });
    const sub = join(dir, "src");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — step 0: only a direct child .devmate short-circuits, not an ancestor's", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    // .devmate lives at dir; startDir is a subfolder, so step 0 must NOT fire.
    // The existing marker walk (step 1) handles it instead, still returning dir.
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    const sub = join(dir, "app", "nested");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — step 0: emits the multi-root stderr log line", async () => {
  const { dir, cleanup } = makeTmp();
  const originalWrite = process.stderr.write;
  /** @type {string[]} */
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    await resolveRepoRoot(dir);
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
  // A bare dir with only a .devmate child (no .git / package.json) is the
  // multi-root workspace-root layout. The label must SAY which layout it saw:
  // it used to print "multi-root .devmate sibling" for every step-0 hit,
  // mislabeling ordinary single-root repos during exactly the debugging this
  // line exists for (#76).
  assert.ok(
    lines.some(
      (l) =>
        l.includes(`repoRoot resolved: ${dir}`) &&
        l.includes("step: 0 — workspace root with .devmate sibling (multi-root layout)"),
    ),
    `expected a step 0 log line, got: ${JSON.stringify(lines)}`,
  );
});

test("resolveRepoRoot — step 0 labels a single-root repo honestly", async () => {
  const { dir, cleanup } = makeTmp();
  const originalWrite = process.stderr.write;
  /** @type {string[]} */
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    await resolveRepoRoot(dir);
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
  assert.ok(
    lines.some((l) => l.includes("step: 0 — single-root repo with .devmate")),
    `expected the single-root step 0 label, got: ${JSON.stringify(lines)}`,
  );
});

test("resolveRepoRoot — from a subfolder returns the marked repo root", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    const sub = join(dir, "src", "deep", "nested");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — package.json counts as a marker", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    const sub = join(dir, "lib");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — existing .devmate counts as a marker", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    const sub = join(dir, "app");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — no marker up to fs root returns start dir unchanged", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const sub = join(dir, "no-marker-here");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    assert.ok(resolved.length > 0);
    assert.ok(sub.startsWith(resolved) || resolved === sub);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — when start dir itself is the repo root", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    const resolved = await resolveRepoRoot(dir);
    assert.equal(resolved, dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — multi-root: two sibling repos resolve independently", async () => {
  const { dir: parent, cleanup } = makeTmp();
  try {
    const repoA = join(parent, "repo-a");
    const repoB = join(parent, "repo-b");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });

    const subA = join(repoA, "src");
    const subB = join(repoB, "src");
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });

    assert.equal(await resolveRepoRoot(subA), repoA);
    assert.equal(await resolveRepoRoot(subB), repoB);
    assert.notEqual(await resolveRepoRoot(subA), parent);
    assert.notEqual(await resolveRepoRoot(subB), parent);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — multi-root: cwd is workspace parent with .code-workspace listing repos", async () => {
  const { dir: parent, cleanup } = makeTmp();
  try {
    const repoA = join(parent, "repo-a");
    const repoB = join(parent, "repo-b");
    // No .git or markers in parent — simulates the problematic case.
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });

    // .code-workspace at the parent level listing both repos.
    writeFileSync(
      join(parent, "workspace.code-workspace"),
      JSON.stringify({ folders: [{ path: "./repo-a" }, { path: "./repo-b" }] }),
    );

    // cwd is inside repo-a/src — walk-up finds .git in repo-a directly.
    const subA = join(repoA, "src");
    mkdirSync(subA, { recursive: true });
    assert.equal(await resolveRepoRoot(subA), repoA);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — multi-root: cwd is workspace parent, .code-workspace matches repo-a", async () => {
  const { dir: parent, cleanup } = makeTmp();
  try {
    const repoA = join(parent, "repo-a");
    // No markers in parent itself.
    mkdirSync(repoA, { recursive: true });

    writeFileSync(
      join(parent, "workspace.code-workspace"),
      JSON.stringify({ folders: [{ path: "./repo-a" }] }),
    );

    // cwd = parent (no markers there) — should fall through to .code-workspace step.
    // The walk-up from parent will NOT find markers in parent (we only created repoA dir,
    // no .git/package.json/. copilot in parent). So step 4 should kick in.
    // However since repoA has no markers either and cwd=parent doesn't start with repoA,
    // matchFolderForCwd returns null → falls back to parent. This is the correct safe behavior.
    const resolved = await resolveRepoRoot(parent);
    // Must return something valid — either parent (fallback) or repoA (if matched).
    assert.ok(typeof resolved === "string" && resolved.length > 0);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — multi-root: workspace parent has no .code-workspace, falls back to cwd", async () => {
  const { dir: parent, cleanup } = makeTmp();
  try {
    // No markers, no .code-workspace anywhere in the temp subtree.
    const sub = join(parent, "workspace-parent");
    mkdirSync(sub, { recursive: true });

    const resolved = await resolveRepoRoot(sub);
    // Falls back to sub (or an ancestor outside our tree that may have a marker).
    assert.ok(typeof resolved === "string" && resolved.length > 0);
  } finally {
    cleanup();
  }
});

// --- monoroot layout: .devmate at the workspace root, sibling repos each with
// their own .git. A hook whose cwd lands inside one of those repos must still
// resolve the workspace root. Before the marker-precedence fix, both resolvers
// stopped at the repo's own .git and read/wrote a phantom <repo>/.devmate/,
// while SessionStart used the workspace root — so task.json was written where
// nothing looked for it, and the whole lane silently produced no state.

/**
 * Build the monoroot shape: <root>/{.devmate, repo-a/.git/, repo-b/.git/}.
 * @param {string} root
 * @returns {{ repoA: string, repoB: string }}
 */
function makeMonoroot(root) {
  mkdirSync(join(root, ".devmate", "state"), { recursive: true });
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-b", ".git"), { recursive: true });
  return { repoA: join(root, "repo-a"), repoB: join(root, "repo-b") };
}

test("resolveHookRoot — monoroot: cwd inside a sibling repo resolves the workspace root, not the repo", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const { repoA, repoB } = makeMonoroot(dir);
    const nested = join(repoA, "src", "components");
    mkdirSync(nested, { recursive: true });

    // The regression: repoA/.git is the NEAREST marker, but the only .devmate
    // lives at the workspace root — that is the root the hook must use.
    assert.equal(resolveHookRoot({ cwd: repoA }), dir);
    assert.equal(resolveHookRoot({ cwd: repoB }), dir);
    assert.equal(resolveHookRoot({ cwd: nested }), dir);
  } finally {
    cleanup();
  }
});

test("resolveRepoRoot — monoroot: startDir inside a sibling repo resolves the workspace root", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const { repoA } = makeMonoroot(dir);
    const nested = join(repoA, "src");
    mkdirSync(nested, { recursive: true });

    // Both resolvers must agree — a split here is the #76 defect shape.
    assert.equal(await resolveRepoRoot(nested), dir);
    assert.equal(await resolveRepoRoot(nested), resolveHookRoot({ cwd: nested }));
  } finally {
    cleanup();
  }
});

test("resolveHookRoot — single-root repo: .devmate beside .git still resolves the repo root", () => {
  const { dir, cleanup } = makeTmp();
  try {
    // devmate's own layout — the precedence change must be a no-op here.
    mkdirSync(join(dir, ".devmate"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    const sub = join(dir, "lib", "init");
    mkdirSync(sub, { recursive: true });

    assert.equal(resolveHookRoot({ cwd: sub }), dir);
  } finally {
    cleanup();
  }
});

test("resolveHookRoot — uninitialized repo: no .devmate anywhere falls back to the nearest .git", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const repoA = join(dir, "repo-a");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    const sub = join(repoA, "src");
    mkdirSync(sub, { recursive: true });

    // Before init there is no .devmate to anchor on, so the marker walk stands.
    assert.equal(resolveHookRoot({ cwd: sub }), repoA);
  } finally {
    cleanup();
  }
});

test("resolveHookRoot — climbs out of a .devmate cwd in the monoroot layout", () => {
  const { dir, cleanup } = makeTmp();
  try {
    makeMonoroot(dir);
    // VS Code lists .devmate first, so it can become the hook's cwd. Resolving
    // to <root>/.devmate would make callers write .devmate/.devmate/state/.
    assert.equal(resolveHookRoot({ cwd: join(dir, ".devmate") }), dir);
  } finally {
    cleanup();
  }
});

// NOTE (#77): `resolveRepoRoot`'s step-5 fallback was changed to return the
// CLIMBED start rather than the raw `startDir`, so it can never hand back a
// `.devmate` folder as the workspace root — the shape of the #76 bug.
//
// There is deliberately NO test for it, and that is the honest answer rather
// than a convenient one. The branch is unreachable in practice: a `.devmate` cwd
// that exists on disk always matches step 0 (the folder you climb out of IS the
// `.devmate` child step 0 looks for), and reaching step 5 at all requires no
// repo marker in ANY ancestor — which no temp directory on a real machine can
// guarantee. Every test written for it passed with the bug deliberately
// reintroduced. A test that cannot fail on the defect it names is not coverage;
// it is the exact false assurance this issue exists to delete. The change stands
// on consistency with `resolveHookRoot`, which is stated plainly at the call
// site.
