// @ts-check
/**
 * E8-3: completion signalling for isolated worktree execution.
 *
 * The agent doing risky work inside the worktree writes a sentinel file
 * (`.devmate-complete`) when it is done. `waitForCompletionSignal` polls for
 * that file on a timer — never a busy loop — and resolves either when the
 * sentinel appears or when the deadline passes.
 */

import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';

/** @typedef {import('../types.mjs').WorktreeHandle} WorktreeHandle */

/** File the agent writes inside the worktree to signal completion. */
export const SENTINEL_FILENAME = '.devmate-complete';

/** Default poll interval between sentinel checks. */
const DEFAULT_POLL_MS = 500;

/** Default deadline before giving up. */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * @typedef {Object} CompletionSignalOpts
 * @property {number} [timeoutMs] Deadline before resolving as timed out (default 60000).
 * @property {number} [pollMs]    Interval between sentinel checks (default 500).
 */

/**
 * @typedef {Object} CompletionSignalResult
 * @property {boolean}  signalReceived True when the sentinel file appeared in time.
 * @property {boolean} [timedOut]      True when the deadline passed first.
 */

/**
 * Sleep without blocking the event loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Whether the sentinel file currently exists.
 * @param {string} sentinelPath
 * @returns {Promise<boolean>}
 */
async function sentinelExists(sentinelPath) {
  try {
    await fsp.access(sentinelPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll for the completion sentinel file inside the worktree.
 *
 * Resolves `{ signalReceived: true }` as soon as the sentinel appears, or
 * `{ signalReceived: false, timedOut: true }` once the deadline passes. Polling
 * is timer-driven (`setTimeout`), so the event loop is never blocked.
 * @param {WorktreeHandle} handle
 * @param {CompletionSignalOpts} [opts]
 * @returns {Promise<CompletionSignalResult>}
 */
export async function waitForCompletionSignal(handle, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sentinelPath = resolve(handle.worktreePath, SENTINEL_FILENAME);
  const deadline = Date.now() + timeoutMs;

  // Check once immediately so an already-present sentinel resolves fast.
  if (await sentinelExists(sentinelPath)) {
    return { signalReceived: true };
  }

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollMs, remaining));
    if (await sentinelExists(sentinelPath)) {
      return { signalReceived: true };
    }
  }

  return { signalReceived: false, timedOut: true };
}
