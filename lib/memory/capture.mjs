// @ts-check
// Shared memory-capture step: promote the active task ledger (if any) into the
// repo ledger, then re-render .devmate/MEMORY.md from the repo ledger. Used by
// both the PreCompact path (scripts/compact-session.mjs) and the Stop path
// (scripts/session-stop.mjs) so the two triggers never drift apart.
import { resolve } from 'node:path';
import { pathExists } from '../fs-safe.mjs';
import { promoteLedger } from './promote.mjs';
import { renderMemory } from './render-memory.mjs';
import {
  memoryMdPath,
  repoLedgerPath,
  taskLedgerPath,
  validateTaskId,
} from './paths.mjs';
import { readTaskState } from '../task-state.mjs';

/** @typedef {import('../types.mjs').StateResult} StateResult */

/**
 * @typedef {Object} CaptureResult
 * @property {boolean} ok            Render succeeded.
 * @property {number}  promoted      Facts promoted from the task ledger (0 if none).
 * @property {number}  factsRendered Active facts written into MEMORY.md.
 * @property {boolean} rendered      Whether .devmate/MEMORY.md was (re)written.
 * @property {string|null} error     Render error message, or null.
 */

/**
 * Promote-then-render, best-effort. Never throws.
 *
 * Promotion is skipped (non-fatally) when there is no active task, the taskId
 * is invalid, or the task ledger does not exist. Rendering ALWAYS runs so that
 * facts already promoted into repo.jsonl by earlier tasks keep the committed
 * .devmate/MEMORY.md current even on a session with no new facts.
 *
 * Warning messages are passed to `warn` verbatim; the caller prefixes them with
 * its own hook tag. The substrings 'promote failed (non-fatal)',
 * 'promote skipped (non-fatal)' and 'memory render failed (non-fatal)' are
 * stable and asserted by tests.
 *
 * @param {string} repoRoot  Absolute repo root.
 * @param {{
 *   warn?: (msg: string) => void,
 *   readState?: (path: string) => StateResult,
 * }} [opts]
 * @returns {Promise<CaptureResult>}
 */
export async function captureMemory(repoRoot, opts = {}) {
  const warn = opts.warn ?? (() => {});
  const readState = opts.readState ?? readTaskState;
  const repoLedger = repoLedgerPath(repoRoot);
  let promoted = 0;

  // 1) Promote the active task ledger, if there is one and it is valid.
  //    A missing task.json means "no active task" — a legitimate, silent skip
  //    (e.g. a fresh session that never started a task). A task.json that
  //    exists but is unreadable/invalid IS surfaced, so a corrupted state can't
  //    strand facts silently.
  try {
    const statePath = resolve(repoRoot, '.devmate/state/task.json');
    if (pathExists(statePath)) {
      const stateResult = readState(statePath);
      if (!stateResult.ok) {
        warn('promote skipped (non-fatal): task state unreadable');
      } else {
        const taskId = stateResult.state.taskId;
        try {
          validateTaskId(taskId);
          const taskLedger = taskLedgerPath(repoRoot, taskId);
          if (pathExists(taskLedger)) {
            const result = await promoteLedger(taskLedger, repoLedger, {
              taskId,
              conflictPolicy: 'keep-incoming',
            });
            if (result.ok) {
              promoted = result.promoted;
            } else {
              warn(`promote failed (non-fatal): ${result.error ?? 'unknown error'}`);
            }
          }
        } catch (/** @type {unknown} */ err) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`promote skipped (non-fatal): ${msg}`);
        }
      }
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`promote skipped (non-fatal): ${msg}`);
  }

  // 2) Render .devmate/MEMORY.md from the repo ledger — always.
  const rendered = await renderMemory(repoLedger, memoryMdPath(repoRoot));
  if (!rendered.ok) {
    warn(`memory render failed (non-fatal): ${rendered.error ?? 'unknown error'}`);
    return {
      ok: false,
      promoted,
      factsRendered: 0,
      rendered: false,
      error: rendered.error ?? 'render_failed',
    };
  }

  return {
    ok: true,
    promoted,
    factsRendered: rendered.factsRendered ?? 0,
    rendered: true,
    error: null,
  };
}
