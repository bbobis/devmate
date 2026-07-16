// @ts-check
// E5-6: scoped pattern authoring. Writes are restricted to `.devmate/patterns/`
// and gated by an explicit `approve pattern: <id>` approval. No write can occur
// without a prior approval (validated here AND staged via approvePattern).

import { promises as fsp } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import {
  ensureDir,
  listDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { validatePatternApproval, PATTERN_APPROVAL_PREFIX } from './learn.mjs';

/** @typedef {import('../types.mjs').Pattern} Pattern */
/** @typedef {import('../types.mjs').PatternApproval} PatternApproval */

/** The only directory pattern files may be written under (repo-relative). */
export const PATTERNS_DIR = '.devmate/patterns';

/**
 * Resolve and verify a pattern path is inside `<root>/.devmate/patterns/`.
 * Throws on any path that escapes the patterns directory.
 * @param {string} filePath
 * @param {string} root  Repo root the path is resolved against.
 * @returns {string}     The absolute, verified path.
 */
function resolveSafePatternPath(filePath, root) {
  const base = resolve(root, PATTERNS_DIR) + sep;
  const abs = resolve(root, filePath);
  if (abs !== base.slice(0, -1) && !abs.startsWith(base)) {
    throw new Error('Pattern path must be under .devmate/patterns/');
  }
  return abs;
}

/**
 * Write a Pattern to disk after validating approval. Atomic (tmp + rename).
 * @param {Pattern} pattern
 * @param {PatternApproval[]} approvals
 * @param {{ root?: string }} [opts]  root defaults to process.cwd().
 * @returns {Promise<{ written: boolean, filePath: string }>}
 */
export async function writePattern(pattern, approvals, opts = {}) {
  const root = opts.root ?? process.cwd();
  const abs = resolveSafePatternPath(pattern.filePath, root);

  const rejection = validatePatternApproval(pattern, approvals);
  if (rejection) throw new Error(rejection);

  await ensureDir(dirname(abs));
  const tmp = abs + '.tmp';
  await writeTextFile(tmp, pattern.body);
  await renamePath(tmp, abs);
  return { written: true, filePath: pattern.filePath };
}

/**
 * Register an approval for a staged (pending) pattern. Appends to a sidecar
 * `<patternId>.approvals.json` next to the pending file.
 * @param {PatternApproval} approval
 * @param {string} pendingDir  Directory where `<patternId>.pending.json` lives.
 * @returns {Promise<void>}
 */
export async function approvePattern(approval, pendingDir) {
  if (
    typeof approval.approvedBy !== 'string' ||
    !approval.approvedBy.toLowerCase().startsWith(PATTERN_APPROVAL_PREFIX)
  ) {
    throw new Error(`approvePattern: approvedBy must start with '${PATTERN_APPROVAL_PREFIX}'.`);
  }
  const pendingPath = resolve(pendingDir, `${approval.patternId}.pending.json`);
  try {
    await fsp.access(pendingPath);
  } catch {
    throw new Error(`approvePattern: no pending pattern at ${pendingPath}.`);
  }
  const sidecar = resolve(pendingDir, `${approval.patternId}.approvals.json`);
  /** @type {PatternApproval[]} */
  let existing = [];
  try {
    existing = JSON.parse(await readTextFile(sidecar));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }
  existing.push(approval);
  const tmp = sidecar + '.tmp';
  await writeTextFile(tmp, JSON.stringify(existing, null, 2));
  await renamePath(tmp, sidecar);
}

/**
 * List pending pattern IDs staged in `pendingDir`.
 * @param {string} pendingDir
 * @returns {Promise<string[]>}
 */
export async function listPendingPatterns(pendingDir) {
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await listDir(pendingDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.pending.json'))
    .map((f) => f.replace(/\.pending\.json$/, ''));
}
