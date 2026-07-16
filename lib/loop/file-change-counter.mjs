// @ts-check

/** @typedef {import('../types.mjs').FileChangeOpts} FileChangeOpts */
/** @typedef {import('../types.mjs').LoopGuardResult} LoopGuardResult */
/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */

import { spawn } from 'node:child_process';
import { matchGlob } from '../gate-guard-core.mjs';

/**
 * Count files changed since the last verified checkpoint using `git diff --name-only`.
 * Never spawns a shell string; passes argv array to child_process.
 * @param {FileChangeOpts} opts
 * @param {typeof spawn} [spawnFn]  Injectable for testing.
 * @returns {Promise<number>}
 */
export async function countChangedFiles(opts, spawnFn = spawn) {
  const { repoRoot, sinceRef = 'HEAD~1', excludePatterns = [] } = opts;

  const args = ['diff', '--name-only', sinceRef];

  return new Promise((resolve, reject) => {
    const child = spawnFn('git', args, { cwd: repoRoot, stdio: 'pipe', shell: false });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        // A missing base ref (e.g. HEAD~1 in a repo with 0-1 commits) means there is
        // no prior verified checkpoint to diff against — treat that as "0 files changed"
        // rather than failing. git reports this as an "unknown revision" / "ambiguous
        // argument" on stderr with exit code 128.
        const noBaseRef =
          /unknown revision|ambiguous argument|bad revision|fatal: .*HEAD/i.test(stderr);
        if (noBaseRef) {
          resolve(0);
          return;
        }
        reject(new Error(`git diff exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');

      const filtered =
        excludePatterns.length === 0
          ? lines
          : lines.filter((filePath) => !excludePatterns.some((pat) => _matchGlob(pat, filePath)));

      resolve(filtered.length);
    });
  });
}

/**
 * Throw a typed LoopGuardError if `count >= limit`.
 * @param {number} count
 * @param {number} limit
 * @returns {void}
 */
export function assertBelowMaxFiles(count, limit) {
  if (count >= limit) {
    const err = new Error(
      `MAX_FILES_CHANGED_WITHOUT_VERIFY: changed ${count} files, limit is ${limit}`
    );
    Object.assign(err, { code: 'MAX_FILES_CHANGED_WITHOUT_VERIFY', count, limit });
    throw err;
  }
}

/**
 * Simple glob matcher supporting `**` and `*` wildcards.
 * Only used for exclude-pattern filtering; no third-party dependency.
 * @param {string} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
function _matchGlob(pattern, filePath) {
  return matchGlob(pattern, filePath);
}
