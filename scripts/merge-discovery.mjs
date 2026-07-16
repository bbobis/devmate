// @ts-check
/**
 * FO-5: merge-discovery — thin CLI around `mergeDiscoveryArtifacts` (FO-4),
 * the fan-in of the two-phase discovery fan-out.
 *
 * Reads every discovery worker-return artifact for the current task from
 * `.devmate/state/worker-returns/` (filter: `agentName === 'discovery'`),
 * merges them with `maxClaims` taken from the persisted output contract in
 * `.devmate/state/task.json` (`outputContract.max_context_sources`,
 * fallback: 10), writes `.devmate/state/discovery-merged.json` atomically,
 * appends a `discovery_merge` trace event, persists the merged claims as
 * recallable discovery facts in the task ledger (FO-6, soft-degrading, with
 * a per-batch `fact_write` trace event), and prints a ≤10-line digest
 * (claims kept, dups collapsed, conflicts flagged, dropped, facts written).
 *
 * Usage:
 *   node scripts/merge-discovery.mjs [--repo-root .]
 *
 * Exit: 0 on a completed merge — including when every input was invalid
 *       (the digest reports it; the orchestrator falls back to a single
 *       `@discovery` dispatch per the lane procedure). 1 only on IO/config
 *       errors (missing worker-returns directory, unwritable artifact,
 *       failed trace append).
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { pathExists } from '../lib/fs-safe.mjs';
import { readJsonFileSync, writeJsonFileAtomic } from '../lib/json-io.mjs';
import { writeDiscoveryFacts } from '../lib/memory/discovery-facts.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';
import { mergeDiscoveryArtifacts } from '../lib/workflow/agents/discovery.mjs';
import { readDiscoveryReturns } from '../lib/workflow/discovery-returns.mjs';

/** Worker-return directory, relative to `--repo-root`. */
const WORKER_RETURNS_DIR = '.devmate/state/worker-returns';

/** Merged-artifact output path, relative to `--repo-root`. */
const MERGED_ARTIFACT_PATH = '.devmate/state/discovery-merged.json';

/** Task-state path, relative to `--repo-root`. */
const TASK_STATE_PATH = '.devmate/state/task.json';

/** Fallback claim cap when no output contract is persisted. */
const DEFAULT_MAX_CLAIMS = 10;

/**
 * Parse `--flag value` / `--flag=value` pairs into an option map (mirrors
 * `scripts/discovery-scan.mjs`). A `Map` so a hostile flag name cannot
 * pollute Object.prototype. Unknown flags are ignored.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    // eslint-disable-next-line secure-coding/detect-object-injection -- numeric array index (args[i+1]), not an object property; no prototype-pollution surface.
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, '');
    }
  }
  return out;
}

/**
 * Resolve `taskId`, `lane`, and the effective `maxClaims` from the persisted
 * task state. All degrade softly: a missing/unreadable task.json (or a
 * missing output contract) yields the documented fallback, never an error.
 * @param {string} repoRoot
 * @returns {{ taskId: string|null, lane: string, maxClaims: number }}
 *          taskId is null pre-task (no task.json) — discovery legitimately runs
 *          before init-task-state, and a null taskId means the task-keyed side
 *          effects (traces, fact ledger) are SKIPPED, not filed under a
 *          sentinel id (#76).
 */
function readTaskContext(repoRoot) {
  const state = readJsonFileSync(join(repoRoot, TASK_STATE_PATH));
  const record = state !== null && typeof state === 'object'
    ? /** @type {Record<string, unknown>} */ (state)
    : {};
  const taskId = typeof record['taskId'] === 'string' && record['taskId'].trim() !== ''
    ? record['taskId']
    : null;
  const lane = typeof record['lane'] === 'string' && record['lane'].trim() !== ''
    ? record['lane']
    : 'unknown';
  const contract = record['outputContract'];
  const contractRecord = contract !== null && typeof contract === 'object'
    ? /** @type {Record<string, unknown>} */ (contract)
    : {};
  const rawMax = contractRecord['max_context_sources'];
  const maxClaims = typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 1
    ? rawMax
    : DEFAULT_MAX_CLAIMS;
  return { taskId, lane, maxClaims };
}

/**
 * Build the ≤10-line digest: claims kept, dups collapsed, conflicts
 * flagged, dropped, invalid, unreadable — every cap and skip visible,
 * never silent. The FO-6 facts line reports the memory write the same way.
 * @param {number} inputs
 * @param {import('../lib/types.mjs').MergeDiscoveryStats} stats
 * @param {number} unreadable
 * @param {string} artifactPath
 * @param {import('../lib/types.mjs').DiscoveryFactsWriteResult} factsResult
 * @returns {string}
 */
function buildDigest(inputs, stats, unreadable, artifactPath, factsResult) {
  // Error text is collapsed to one bounded line so a multi-line or oversized
  // message can never break the ≤10-line digest contract.
  const reason = String(factsResult.error).replace(/\s+/g, ' ').slice(0, 200);
  const factsLine = factsResult.ok
    ? `facts: ${factsResult.facts.length} written to task ledger, ${factsResult.staledPrior} prior staled, ` +
      `skipped: ${factsResult.skippedNeedsReview} needs-review, ${factsResult.skippedMissingSource} missing source, ` +
      `${factsResult.skippedInvalid} invalid`
    : `facts: not written (${reason})`;
  return [
    `[merge-discovery] ${inputs} input(s), ${stats.mergedClaims} claim(s) kept, ` +
      `${stats.exactDups + stats.nearDups} dup(s) collapsed, ${stats.needsReview} conflict(s) flagged, ` +
      `${stats.dropped} dropped, ${stats.invalidInputs} invalid input(s), ${unreadable} unreadable file(s)`,
    factsLine,
    `artifact: ${artifactPath}`,
  ].join('\n');
}

/**
 * Main entrypoint.
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  const opts = parseArgs(args);
  const repoRoot = resolve(opts.get('repo-root') ?? process.cwd());

  const returnsDir = join(repoRoot, WORKER_RETURNS_DIR);
  if (!pathExists(returnsDir)) {
    process.stderr.write(
      `[merge-discovery] FAIL — worker-returns directory not found at ${returnsDir}; ` +
      'dispatch the Phase-2 discovery workers before merging\n',
    );
    return 1;
  }

  /** @type {{ artifacts: unknown[], workerIds: string[], unreadable: number }} */
  let inputs;
  try {
    inputs = readDiscoveryReturns(returnsDir);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[merge-discovery] FAIL — could not read worker returns: ${msg}\n`);
    return 1;
  }

  const { taskId, lane, maxClaims } = readTaskContext(repoRoot);
  const { merged, stats } = mergeDiscoveryArtifacts(inputs.artifacts, {
    maxClaims,
    workerIds: inputs.workerIds,
  });

  const artifactPath = join(repoRoot, MERGED_ARTIFACT_PATH);
  try {
    await writeJsonFileAtomic(artifactPath, merged);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[merge-discovery] FAIL — could not write merged artifact: ${msg}\n`);
    return 1;
  }

  try {
    const traced = taskId === null
      ? /** @type {{ ok: boolean, lineNumber: number, errors?: string[] }} */ ({ ok: true, lineNumber: 0 })
      : await appendTraceEvent(
      {
        type: 'discovery_merge',
        taskId,
        stepId: 'merge-discovery',
        ts: new Date().toISOString(),
        schemaVersion: 1,
        inputs: inputs.artifacts.length,
        merged: stats.mergedClaims,
        dropped: stats.dropped,
        conflicts: stats.needsReview,
      },
      { root: repoRoot },
    );
    if (!traced.ok) {
      process.stderr.write(
        `[merge-discovery] FAIL — discovery_merge trace event rejected: ${(traced.errors ?? []).join('; ')}\n`,
      );
      return 1;
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[merge-discovery] FAIL — could not append trace event: ${msg}\n`);
    return 1;
  }

  // FO-6: persist the merged claims as recallable discovery facts. Memory is
  // an enhancement, not a gate — unlike the load-bearing discovery_merge
  // event above, a failed fact write degrades softly (reported in the digest,
  // exit stays 0) so it can never sink a completed merge.
  /** @type {import('../lib/types.mjs').DiscoveryFactsWriteResult} */
  let factsResult;
  try {
    factsResult = taskId === null
      ? { ok: true, facts: [], staledPrior: 0, skippedNeedsReview: 0, skippedMissingSource: 0, skippedInvalid: 0, ledgerPath: '', error: null }
      : await writeDiscoveryFacts({ taskId, lane, mergedArtifact: merged, repoRoot });
  } catch (/** @type {unknown} */ err) {
    // Defense in depth: writeDiscoveryFacts is result-object by contract, but
    // an unexpected throw must still degrade softly, never sink the merge.
    const msg = err instanceof Error ? err.message : String(err);
    factsResult = {
      ok: false,
      facts: [],
      staledPrior: 0,
      skippedNeedsReview: 0,
      skippedMissingSource: 0,
      skippedInvalid: 0,
      ledgerPath: '',
      error: `unexpected: ${msg}`,
    };
  }
  if (taskId !== null && factsResult.ok && factsResult.facts.length > 0) {
    // One fact_write trace event per batch (type registered in the trace
    // schema; best-effort like the PostToolUse emitter, never blocks).
    try {
      const traced = await appendTraceEvent(
        {
          type: 'fact_write',
          taskId,
          stepId: 'merge-discovery',
          ts: new Date().toISOString(),
          schemaVersion: 1,
          factKey: `discovery-merge:${taskId}`,
          scope: lane,
          sourcePointer: MERGED_ARTIFACT_PATH,
        },
        { root: repoRoot },
      );
      if (!traced.ok) {
        process.stderr.write(
          `[merge-discovery] fact_write trace skipped (non-fatal): ${(traced.errors ?? []).join('; ')}\n`,
        );
      }
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[merge-discovery] fact_write trace skipped (non-fatal): ${msg}\n`);
    }
  }

  process.stdout.write(
    buildDigest(inputs.artifacts.length, stats, inputs.unreadable, artifactPath, factsResult) + '\n',
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
