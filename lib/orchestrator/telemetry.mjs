// @ts-check
/**
 * E8-1: per-worker fanout telemetry.
 *
 * Appends one JSONL record per worker to `evals/telemetry/workers.jsonl` using
 * the E3-1 locked-append primitive, so concurrent fanout writes never interleave.
 * The directory is created on first write if absent (DoD).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from '../fs-safe.mjs';
import { appendJsonl } from '../memory/append-jsonl.mjs';

/** @typedef {import('../types.mjs').WorkerTelemetry} WorkerTelemetry */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default ledger path: <repo>/evals/telemetry/workers.jsonl.
 * @type {string}
 */
export const DEFAULT_TELEMETRY_PATH = resolve(__dirname, '../../evals/telemetry/workers.jsonl');

/**
 * Append a worker telemetry record under exclusive lock. Creates the parent
 * directory if it does not yet exist. Auto-compaction is disabled — telemetry is
 * an append-only ledger we do not want silently truncated mid-run.
 * @param {string} workerId
 * @param {WorkerTelemetry} telemetry
 * @param {{ ledgerPath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function recordWorkerTelemetry(workerId, telemetry, opts = {}) {
  const ledgerPath = opts.ledgerPath ?? DEFAULT_TELEMETRY_PATH;
  await ensureDir(dirname(ledgerPath));

  const entry = {
    timestamp: new Date().toISOString(),
    workerId,
    promptTokens: telemetry.promptTokens,
    completionTokens: telemetry.completionTokens,
    latencyMs: telemetry.latencyMs,
    contractValid: telemetry.contractValid,
  };

  await appendJsonl(ledgerPath, entry, { autoCompact: false });
}
