// @ts-check

/** @typedef {import('../types.mjs').RunCommandResult} RunCommandResult */

import { spawn } from 'node:child_process';

/** Shell metacharacters that are unsafe in argv[0]. */
const SHELL_META_RE = /[|&;<>`$]/;

/**
 * Validate that argv[0] does not contain shell metacharacters.
 * Throws a typed Error if invalid.
 * @param {string[]} argv
 * @returns {void}
 */
export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw Object.assign(new Error('argv must be a non-empty array'), { code: 'INVALID_ARGV' });
  }
  if (SHELL_META_RE.test(argv[0])) {
    throw Object.assign(
      new Error(`argv[0] contains shell metacharacters: ${JSON.stringify(argv[0])}`),
      { code: 'SHELL_METACHAR_IN_ARGV0' }
    );
  }
}

/**
 * Spawn `argv[0]` with `argv.slice(1)` using child_process.spawn, no shell.
 * Kills the process after `timeoutMs` and sets `timedOut: true`.
 * Captures stdout and stderr as separate streams.
 * @param {string[]} argv
 * @param {{ timeoutMs?: number, cwd?: string }} [opts]
 * @returns {Promise<RunCommandResult>}
 */
export async function runCommand(argv, opts) {
  validateArgv(argv);

  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const cwd = opts?.cwd;

  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: 'pipe',
      shell: false,
      ...(cwd !== undefined ? { cwd } : {}),
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let timedOut = false;
    const startMs = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (/** @type {Buffer} */ chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => { stderrChunks.push(chunk); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        durationMs,
      });
    });
  });
}
