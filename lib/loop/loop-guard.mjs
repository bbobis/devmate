// @ts-check

/** @typedef {import('../types.mjs').LoopGuardResult} LoopGuardResult */
/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */
/** @typedef {import('../types.mjs').LoopHaltEvent} LoopHaltEvent */

import { countChangedFiles, assertBelowMaxFiles } from './file-change-counter.mjs';
import { appendTraceEvent } from './trace-writer.mjs';
import { SCHEMA_VERSION, readTraceFile } from './trace-schema.mjs';
import { detectNoProgress } from './no-progress.mjs';
import { sumCumulativeCost } from './cost-tracker.mjs';

/**
 * Run all loop-guard checks for the current attempt.
 * Writes a `loop_halt` trace event via appendTraceEvent when blocked.
 *
 * INVARIANT: `attemptId` must be the ID of the attempt being evaluated.
 * Call this BEFORE writing the current attempt's trace entry so that no-progress
 * detection correctly excludes the current attempt from comparison.
 *
 * @param {{
 *   traceFile: string,
 *   taskId: string,
 *   attemptId: string,
 *   maxFiles: number,
 *   repoRoot: string,
 *   sinceRef?: string,
 *   currentDigest?: string,
 *   maxLoopTokens?: number,
 * }} opts
 * @returns {Promise<LoopGuardResult>}
 */
export async function runLoopGuard(opts) {
  const {
    traceFile,
    taskId,
    attemptId,
    maxFiles,
    repoRoot,
    sinceRef,
    currentDigest,
    maxLoopTokens,
  } = opts;

  // ---- Check 1: file-change limit ----
  const count = await countChangedFiles({ repoRoot, sinceRef });

  try {
    assertBelowMaxFiles(count, maxFiles);
  } catch (/** @type {unknown} */ err) {
    const message =
      err instanceof Error
        ? err.message
        : `MAX_FILES_CHANGED_WITHOUT_VERIFY: changed ${count} files, limit is ${maxFiles}`;

    /** @type {LoopHaltEvent} */
    const haltEvent = {
      schemaVersion: SCHEMA_VERSION,
      type: 'loop_halt',
      attemptId,
      taskId,
      ts: new Date().toISOString(),
      reason: 'MAX_FILES_CHANGED_WITHOUT_VERIFY',
      lastError: message,
      priorAttemptId: null,
    };

    await appendTraceEvent(traceFile, haltEvent);

    return {
      allowed: false,
      haltReason: 'MAX_FILES_CHANGED_WITHOUT_VERIFY',
      fileCount: count,
    };
  }

  // Load trace events once; used by both Check 2 and Check 3.
  const { events } = readTraceFile(traceFile);

  // ---- Check 2: no-progress detection ----
  if (currentDigest) {
    const result = detectNoProgress({
      currentAttemptId: attemptId,
      currentDigest,
      traceEvents: events,
    });

    if (result.noProgress) {
      const lastError =
        `NO_PROGRESS: current digest matches prior attempt ${result.matchedAttemptId ?? 'unknown'}`;

      /** @type {LoopHaltEvent} */
      const haltEvent = {
        schemaVersion: SCHEMA_VERSION,
        type: 'loop_halt',
        attemptId,
        taskId,
        ts: new Date().toISOString(),
        reason: 'NO_PROGRESS',
        lastError,
        priorAttemptId: result.matchedAttemptId,
      };

      await appendTraceEvent(traceFile, haltEvent);

      return { allowed: false, haltReason: 'NO_PROGRESS' };
    }
  }

  // ---- Check 3: cost cap (opt-in — skipped when maxLoopTokens is not set) ----
  if (maxLoopTokens != null) {
    const costSummary = sumCumulativeCost(events, { capLimit: maxLoopTokens });

    if (costSummary.capExceeded) {
      const lastError =
        `COST_CAP_EXCEEDED: cumulative estimated tokens ${costSummary.totalEstimatedTokens}` +
        ` >= cap ${maxLoopTokens}`;

      /** @type {LoopHaltEvent} */
      const haltEvent = {
        schemaVersion: SCHEMA_VERSION,
        type: 'loop_halt',
        attemptId,
        taskId,
        ts: new Date().toISOString(),
        reason: 'COST_CAP_EXCEEDED',
        lastError,
        priorAttemptId: null,
      };

      await appendTraceEvent(traceFile, haltEvent);

      return { allowed: false, haltReason: 'COST_CAP_EXCEEDED' };
    }
  }

  return { allowed: true };
}
