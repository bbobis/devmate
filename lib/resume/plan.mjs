// @ts-check

/**
 * E6-5: Build a resume plan that never repeats completed work.
 *
 * `buildResumePlan` reads the canonical trace (E6-2) plus the optional handoff
 * artifact (E6-3) and decides what the resume CLI should do next:
 *   - blocked_halt    a step is halted; needs a deliberate strategy change.
 *   - already_complete every step is done; nothing to resume.
 *   - confirm_needed  the trace has malformed lines; needs --confirm.
 *   - proceed         safe to resume from the next uncompleted step.
 *
 * It never re-emits a completed step's stepId as `nextStepId`.
 */

import { readTrace } from '../trace/read-trace.mjs';
import { readHandoff } from '../handoff/read-handoff.mjs';
import {
  canResumeFromCompaction,
  loadCompactionArtifact,
} from '../context/compaction.mjs';
import { completedAcNumbers, summarizeImplProgress } from '../spec-progress.mjs';

/** @typedef {import('../types.mjs').ResumePlan} ResumePlan */
/** @typedef {import('../types.mjs').ResumeAction} ResumeAction */
/** @typedef {import('../types.mjs').ResumeSummary} ResumeSummary */
/** @typedef {import('../types.mjs').HandoffArtifact} HandoffArtifact */
/** @typedef {import('../types.mjs').CompactionArtifact} CompactionArtifact */
/** @typedef {import('../types.mjs').TraceStep} TraceStep */
/** @typedef {import('../types.mjs').ReadTraceResult} ReadTraceResult */

/**
 * Best-effort handoff load. A missing handoff is normal (returns null); any
 * other read error is also treated as "no handoff" so a resume is never
 * blocked by a corrupt brief — the trace is the source of truth.
 * @param {string} taskId
 * @param {{ handoffDir?: string }} opts
 * @returns {Promise<HandoffArtifact|null>}
 */
async function tryReadHandoff(taskId, opts) {
  try {
    return await readHandoff(taskId, opts);
  } catch {
    return null;
  }
}

/**
 * Best-effort load of the newest compaction artifact. Returns null when no
 * `compactionDir` is given, none exist, or the read fails — the trace remains
 * the source of truth for the resume decision.
 * @param {string|undefined} compactionDir
 * @returns {Promise<CompactionArtifact|null>}
 */
async function tryLoadCompaction(compactionDir) {
  if (!compactionDir) return null;
  try {
    return await loadCompactionArtifact(compactionDir);
  } catch {
    return null;
  }
}

/**
 * Pick the next step to dispatch: the first step (in trace order) that is not
 * yet completed. Returns null when every step is completed.
 * @param {TraceStep[]} steps
 * @returns {TraceStep|null}
 */
function firstIncompleteStep(steps) {
  for (const s of steps) {
    if (!s.completed) return s;
  }
  return null;
}

/** @typedef {import('../types.mjs').ImplProgress} ImplProgress */

/**
 * Build a resume plan for a task.
 * @param {string} taskId
 * @param {{ traceDir?: string, handoffDir?: string, compactionDir?: string, acceptanceCriteria?: string[] }} [opts]
 * @returns {Promise<ResumePlan>}
 */
export async function buildResumePlan(taskId, opts = {}) {
  /** @type {ReadTraceResult} */
  const { steps, summary } = await readTrace(taskId, { traceDir: opts.traceDir });
  const handoff = await tryReadHandoff(taskId, { handoffDir: opts.handoffDir });
  const handoffAvailable = handoff !== null;

  // A self-sufficient compaction artifact (written by the PreCompact hook) is a
  // richer resume brief than the trace alone — surface it so a post-compaction
  // session can pick it up.
  const compaction = await tryLoadCompaction(opts.compactionDir);
  const compactionAvailable =
    compaction !== null && canResumeFromCompaction(compaction).ok;

  // The next uncompleted step (never a completed one). For a blocked task this
  // is the blocked step itself, so --strategy-change can target it.
  const nextStep = summary.currentBlocked ?? firstIncompleteStep(steps);
  /** @type {string|null} */
  let nextStepId = nextStep ? nextStep.stepId : null;
  /** @type {string|null} */
  let nextStepLabel = nextStep ? nextStep.label : null;

  // "Already complete" means every recorded step is completed (and nothing is
  // blocked). We derive this from the steps directly rather than from
  // readTrace's nextLegalAction, which collapses to null as soon as ANY step
  // completes — that would wrongly skip later uncompleted steps.
  const allComplete = steps.length > 0 && steps.every((s) => s.completed);

  /** @type {ResumeAction} */
  let action;
  /** @type {string} */
  let message;

  if (summary.currentBlocked != null) {
    action = 'blocked_halt';
    message =
      `Step ${summary.currentBlocked.stepId} (${summary.currentBlocked.label}) is halted. ` +
      'Set --strategy-change to retry with a new approach.';
  } else if (allComplete || nextStep === null) {
    action = 'already_complete';
    message = 'All steps complete. Nothing to resume.';
  } else if (summary.malformedCount > 0) {
    action = 'confirm_needed';
    message =
      `Trace has ${summary.malformedCount} malformed line(s). ` +
      'Confirm with --confirm to proceed.';
  } else {
    action = 'proceed';
    message = `Resuming from step ${nextStepLabel} (${nextStepId}).`;
  }

  // Per-AC implementation progress from the canonical trace, joined against the
  // persisted acceptance-criteria list, so a resumed feature session knows which
  // ACs are done and which to implement next. Present only when the caller
  // supplied the AC list or the trace already carries `impl-AC{n}` completions.
  const completedAc = completedAcNumbers(steps);
  /** @type {ImplProgress|undefined} */
  let implProgress;
  if (Array.isArray(opts.acceptanceCriteria) || completedAc.length > 0) {
    implProgress = summarizeImplProgress(completedAc, opts.acceptanceCriteria);
  }

  // AC completions are authoritative over the coarse trace-step view for a
  // feature build: if acceptance criteria remain, the task is NOT complete even
  // when every recorded trace step is (the completed `impl-AC{n}` events create
  // no incomplete step). Correct an `already_complete` verdict to `proceed` and
  // point resume at the next criterion so nothing programmatic reads the task as
  // finished while ACs are outstanding. A halted or malformed trace still wins —
  // those need a deliberate strategy change / confirm first.
  if (
    implProgress &&
    implProgress.total > 0 &&
    implProgress.nextId !== null &&
    action === 'already_complete'
  ) {
    action = 'proceed';
    nextStepId = `impl-AC${implProgress.nextId}`;
    nextStepLabel = implProgress.nextLabel;
    message = `Resuming implementation from AC${implProgress.nextId} (${implProgress.nextLabel}).`;
  }

  // Point a resuming agent at the richer brief when one exists, without
  // changing the trace-driven action.
  if (compactionAvailable) {
    message += ' A compaction resume-brief is available (goal + next action captured).';
  }

  if (implProgress) {
    if (implProgress.total > 0) {
      message +=
        ` Implementation: ${implProgress.done}/${implProgress.total} ACs complete` +
        (implProgress.nextId !== null
          ? `, next AC${implProgress.nextId}: ${implProgress.nextLabel}.`
          : ' — all ACs complete.');
    } else if (implProgress.done > 0) {
      message += ` Implementation: ${implProgress.done} AC(s) recorded complete.`;
    }
  }

  return {
    taskId,
    action,
    message,
    nextStepId,
    nextStepLabel,
    handoffAvailable,
    compactionAvailable,
    traceSummary: summary,
    handoff,
    compaction,
    ...(implProgress ? { implProgress } : {}),
  };
}
