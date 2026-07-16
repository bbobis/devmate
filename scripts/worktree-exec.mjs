// @ts-check
/**
 * E8-3: guarded entrypoint for isolated worktree execution.
 *
 * Creates a throwaway worktree, signals readiness, awaits the agent's
 * completion sentinel, extracts a diff artifact, records telemetry, and tears
 * the worktree down. On ANY error the worktree is still torn down — we never
 * leave orphaned worktrees behind.
 *
 * Usage:
 *   node scripts/worktree-exec.mjs \
 *     --branch <name> --base-ref <ref> --worktree-path <abs-path> [--timeout <ms>]
 */

import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import {
  createIsolatedWorktree,
  teardownWorktree,
  extractDiff,
} from '../lib/worktree/isolation.mjs';
import { waitForCompletionSignal } from '../lib/worktree/signals.mjs';
import { recordWorktreeTelemetry } from '../lib/worktree/telemetry.mjs';

/** @typedef {import('../lib/types.mjs').WorktreeHandle} WorktreeHandle */

/**
 * Parse `--flag value` pairs from argv.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = args.at(i + 1);
      if (val !== undefined && !val.startsWith('--')) {
        out.set(key, val);
        i += 1;
      } else {
        out.set(key, 'true');
      }
    }
  }
  return out;
}

/**
 * @typedef {Object} WorktreeExecDeps
 * @property {typeof createIsolatedWorktree} [createIsolatedWorktree]
 * @property {typeof teardownWorktree}       [teardownWorktree]
 * @property {typeof extractDiff}            [extractDiff]
 * @property {typeof waitForCompletionSignal} [waitForCompletionSignal]
 * @property {typeof recordWorktreeTelemetry} [recordWorktreeTelemetry]
 */

/**
 * Run one isolated worktree execution end to end. Dependencies are injectable so
 * tests can simulate failures on any step and assert teardown still runs.
 * @param {string[]} args
 * @param {WorktreeExecDeps} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(args, deps = {}) {
  const create = deps.createIsolatedWorktree ?? createIsolatedWorktree;
  const teardown = deps.teardownWorktree ?? teardownWorktree;
  const diff = deps.extractDiff ?? extractDiff;
  const waitSignal = deps.waitForCompletionSignal ?? waitForCompletionSignal;
  const recordTelemetry = deps.recordWorktreeTelemetry ?? recordWorktreeTelemetry;

  const parsed = parseArgs(args);
  const branchName = parsed.get('branch');
  const baseRef = parsed.get('base-ref') || 'HEAD';
  const worktreePath = parsed.get('worktree-path');
  const timeout = parsed.get('timeout');
  const timeoutMs = timeout ? Number(timeout) : 60000;

  if (!branchName || !worktreePath) {
    process.stderr.write(
      'usage: worktree-exec --branch [name] --worktree-path [abs-path] [--base-ref [ref]] [--timeout [ms]]\n'
    );
    return 1;
  }

  /** @type {WorktreeHandle | null} */
  let handle = null;
  const startedAt = Date.now();

  try {
    handle = await create({ baseRef, branchName, worktreePath, timeoutMs });
    process.stdout.write(`[worktree-exec] created ${branchName} at ${worktreePath}\n`);

    const signal = await waitSignal(handle, { timeoutMs });
    if (signal.timedOut) {
      process.stderr.write(`[worktree-exec] timed out waiting for completion signal\n`);
    }

    const result = await diff(handle);
    process.stdout.write(
      `[worktree-exec] diff: ${result.filesChanged} file(s), ` +
        `+${result.insertions}/-${result.deletions} → ${result.artifactPath}\n`
    );

    await recordTelemetry(handle, {
      branchName: handle.branchName,
      durationMs: Date.now() - startedAt,
      filesChanged: result.filesChanged,
      cleanedUp: true,
    });

    return signal.timedOut ? 2 : 0;
  } catch (/** @type {unknown} */ err) {
    process.stderr.write(
      `[worktree-exec] error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  } finally {
    if (handle) {
      await teardown(handle);
    }
  }
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
