// @ts-check
/**
 * E8-3: isolated branch/worktree execution.
 *
 * Risky edits (refactors, multi-file changes, experimental branches) run on a
 * throwaway branch inside a `git worktree` so the main working tree is never
 * contaminated. This module creates the worktree, extracts a review diff
 * artifact, and tears everything down safely on completion or abort.
 *
 * All git calls use `execFile` with argv arrays — no shell string interpolation,
 * so branch names / paths can never be injected into a shell.
 *
 * Sandcastle pattern for branch-based sandboxing:
 * https://github.com/mattpocock/sandcastle/blob/main/README.md
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { ensureDir, writeTextFile } from '../fs-safe.mjs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/** @typedef {import('../types.mjs').WorktreeOpts} WorktreeOpts */
/** @typedef {import('../types.mjs').WorktreeHandle} WorktreeHandle */
/** @typedef {import('../types.mjs').WorktreeDiff} WorktreeDiff */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, two levels up from lib/worktree/. */
const REPO_ROOT = resolve(__dirname, '../..');

/** Cap diff text returned to callers at 64 KB (full diff still saved to disk). */
const DIFF_TEXT_CAP_BYTES = 64 * 1024;

/**
 * Run a git subcommand with an argv array (never a shell string).
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<string>} stdout
 */
async function git(args, opts = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd ?? REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Create a new git worktree on a throwaway branch.
 *
 * Runs `git worktree add <worktreePath> -b <branchName> <baseRef>`. On any
 * failure, attempts a force-remove of a half-created worktree before rethrowing
 * so we never leave an orphaned directory.
 * @param {WorktreeOpts} opts
 * @returns {Promise<WorktreeHandle>}
 */
export async function createIsolatedWorktree(opts) {
  const baseRef = opts.baseRef || 'HEAD';
  const { branchName, worktreePath } = opts;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;

  try {
    await git(['worktree', 'add', worktreePath, '-b', branchName, baseRef], { cwd: repoRoot });
  } catch (/** @type {unknown} */ err) {
    // Best-effort cleanup of a partial worktree, then rethrow the original error.
    try {
      await git(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
    } catch {
      // ignore — nothing to clean up
    }
    throw err;
  }

  return {
    branchName,
    worktreePath,
    baseRef,
    createdAt: new Date().toISOString(),
    active: true,
    repoRoot,
  };
}

/**
 * Remove the worktree and delete the throwaway branch. Safe to call on failure
 * paths and safe to call twice — a torn-down handle is a no-op.
 * @param {WorktreeHandle} handle
 * @returns {Promise<void>}
 */
export async function teardownWorktree(handle) {
  if (handle.active === false) return;

  const cwd = handle.repoRoot ?? REPO_ROOT;

  try {
    await git(['worktree', 'remove', '--force', handle.worktreePath], { cwd });
  } catch (/** @type {unknown} */ err) {
    process.stderr.write(
      `[worktree] remove failed for ${handle.worktreePath}: ${describeError(err)}\n`
    );
  }

  try {
    await git(['branch', '-D', handle.branchName], { cwd });
  } catch (/** @type {unknown} */ err) {
    process.stderr.write(
      `[worktree] branch delete failed for ${handle.branchName}: ${describeError(err)}\n`
    );
  }

  handle.active = false;
}

/**
 * Extract a diff between the base ref and the worktree branch. The full diff is
 * always saved to `evals/worktrees/<branchName>.diff`; the returned `diffText`
 * is capped at 64 KB.
 * @param {WorktreeHandle} handle
 * @returns {Promise<WorktreeDiff>}
 */
export async function extractDiff(handle) {
  const cwd = handle.repoRoot ?? REPO_ROOT;
  const range = `${handle.baseRef}..${handle.branchName}`;

  const statOut = await git(['diff', range, '--stat'], { cwd });
  const { filesChanged, insertions, deletions } = parseDiffStat(statOut);

  const fullDiff = await git(['diff', range], { cwd });

  const artifactDir = resolve(cwd, 'evals/worktrees');
  await ensureDir(artifactDir);
  const artifactPath = resolve(artifactDir, `${safeFileName(handle.branchName)}.diff`);
  await writeTextFile(artifactPath, fullDiff);

  const diffText = capUtf8(fullDiff, DIFF_TEXT_CAP_BYTES);

  return { diffText, artifactPath, filesChanged, insertions, deletions };
}

/**
 * Parse the trailing summary line of `git diff --stat` output, e.g.
 * ` 3 files changed, 12 insertions(+), 4 deletions(-)`.
 * @param {string} statOut
 * @returns {{ filesChanged: number, insertions: number, deletions: number }}
 */
function parseDiffStat(statOut) {
  const summary = /(\d+) files? changed/.exec(statOut);
  const ins = /(\d+) insertions?\(\+\)/.exec(statOut);
  const del = /(\d+) deletions?\(-\)/.exec(statOut);
  return {
    filesChanged: summary ? Number(summary[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multibyte sequence.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function capUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Slice on a byte boundary, then drop any trailing partial char.
  return buf.subarray(0, maxBytes).toString('utf8');
}

/**
 * Make a branch name safe to use as a flat file name (no path separators).
 * @param {string} name
 * @returns {string}
 */
function safeFileName(name) {
  return name.replace(/[/\\]/g, '-');
}

/**
 * Render an unknown thrown value as a short string for stderr logging.
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
