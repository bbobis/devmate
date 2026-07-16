// @ts-check
import { resolve } from 'node:path';
import { pathExists } from '../fs-safe.mjs';
import { readTaskState } from '../task-state.mjs';
import { validateTaskId } from '../memory/paths.mjs';
import { TRACE_DIR } from '../trace/append.mjs';
import { HANDOFF_DIR, writeHandoff } from './write-handoff.mjs';
import { buildHandoffInput } from './build-handoff-input.mjs';

/** @typedef {import('../types.mjs').StateResult} StateResult */

/**
 * @typedef {Object} CaptureHandoffResult
 * @property {boolean} ok       Nothing failed (a legitimate skip is still ok).
 * @property {boolean} written  A handoff artifact was written.
 * @property {string} [path]    The written handoff.json path.
 * @property {string} [skipped] Why nothing was written: no_task | complete | unreadable_state | error.
 */

/**
 * Write a resume handoff for the active task on session end — the mirror of the
 * PreCompact path's compaction artifact, so the existing resume reader
 * (`buildResumePlan` -> `readHandoff`) always has a brief to consume.
 *
 * Best-effort — never throws. A missing task.json means "no active task" (a
 * legitimate silent skip); a completed task (`workflowGate === 'done'`) needs no
 * resume brief; a present-but-unreadable task.json is surfaced via `warn` so a
 * corrupted state can't strand a handoff silently.
 *
 * @param {string} repoRoot
 * @param {{
 *   reason?: string,
 *   warn?: (msg: string) => void,
 *   readState?: (path: string) => StateResult,
 * }} [opts]
 * @returns {Promise<CaptureHandoffResult>}
 */
export async function captureHandoff(repoRoot, opts = {}) {
  const reason = opts.reason ?? 'session_end';
  const warn = opts.warn ?? (() => {});
  const readState = opts.readState ?? readTaskState;

  try {
    const statePath = resolve(repoRoot, '.devmate/state/task.json');
    if (!pathExists(statePath)) {
      return { ok: true, written: false, skipped: 'no_task' };
    }

    const stateResult = readState(statePath);
    if (!stateResult.ok) {
      warn('handoff skipped (non-fatal): task state unreadable');
      return { ok: false, written: false, skipped: 'unreadable_state' };
    }

    const state = stateResult.state;
    // A completed task needs no resume brief.
    if (state.workflowGate === 'done') {
      return { ok: true, written: false, skipped: 'complete' };
    }

    const taskId = state.taskId;
    validateTaskId(taskId);

    const input = await buildHandoffInput(taskId, {
      reason,
      traceDir: resolve(repoRoot, TRACE_DIR),
    });
    const { jsonPath } = await writeHandoff(input, {
      handoffDir: resolve(repoRoot, HANDOFF_DIR),
    });

    return { ok: true, written: true, path: jsonPath };
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`handoff skipped (non-fatal): ${msg}`);
    return { ok: false, written: false, skipped: 'error' };
  }
}
