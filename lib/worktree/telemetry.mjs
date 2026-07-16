// @ts-check
/**
 * E8-3: isolated-worktree run telemetry.
 *
 * Appends one JSONL record per worktree run to `evals/telemetry/worktrees.jsonl`
 * using the E3-1 locked-append primitive, so concurrent writes never interleave.
 * The parent directory is created on first write if absent. Auto-compaction is
 * disabled — telemetry is an append-only ledger we never want silently truncated.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from '../fs-safe.mjs';
import { appendJsonl } from '../memory/append-jsonl.mjs';

/** @typedef {import('../types.mjs').WorktreeHandle} WorktreeHandle */
/** @typedef {import('../types.mjs').WorktreeTelemetry} WorktreeTelemetry */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default ledger path: <repo>/evals/telemetry/worktrees.jsonl.
 * @type {string}
 */
export const DEFAULT_TELEMETRY_PATH = resolve(
  __dirname,
  '../../evals/telemetry/worktrees.jsonl'
);

/**
 * Append a worktree telemetry record under exclusive lock. Creates the parent
 * directory if it does not yet exist.
 * @param {WorktreeHandle} handle
 * @param {WorktreeTelemetry} metrics
 * @param {{ ledgerPath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function recordWorktreeTelemetry(handle, metrics, opts = {}) {
  const ledgerPath = opts.ledgerPath ?? DEFAULT_TELEMETRY_PATH;
  await ensureDir(dirname(ledgerPath));

  const entry = {
    timestamp: new Date().toISOString(),
    branchName: metrics.branchName,
    durationMs: metrics.durationMs,
    filesChanged: metrics.filesChanged,
    cleanedUp: metrics.cleanedUp,
  };

  await appendJsonl(ledgerPath, entry, { autoCompact: false });
}
