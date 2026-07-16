// @ts-check
// Memory-side step-completion writer (E3-6). This is distinct from the strict
// loop trace (`lib/loop/trace-writer.mjs`): it records compact `step_complete`
// events with artifact pointers into the task trace JSONL via the shared
// `appendJsonl` lock, so resume logic can skip already-finished steps.
import { readTextFile } from '../fs-safe.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { appendJsonlWithHandle } from './append-jsonl.mjs';

/** @typedef {import('../types.mjs').StepCompleteEntry} StepCompleteEntry */
/** @typedef {import('../types.mjs').WriteStepCompleteResult} WriteStepCompleteResult */
/** @typedef {import('../types.mjs').ArtifactPointer} ArtifactPointer */

const MAX_LABEL = 80;
const MAX_VERIFY_OUTPUT = 512;

/**
 * Validate an artifact pointer's path is workspace-relative and does not escape.
 * @param {ArtifactPointer} a
 * @returns {string|null} error message or null if valid
 */
function validateArtifact(a) {
  if (!a || typeof a.path !== 'string' || a.path.trim() === '') {
    return 'artifact.path must be a non-empty string';
  }
  if (a.path.startsWith('/')) {
    return `artifact.path must be workspace-relative: ${a.path}`;
  }
  // Reject path traversal in any segment.
  const segments = a.path.split(/[\\/]/);
  if (segments.includes('..')) {
    return `artifact.path must not contain '..': ${a.path}`;
  }
  return null;
}

/**
 * Cap a string to `max` chars, appending '…' when truncated.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function capString(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Write a `step_complete` entry to `tracePath` under the JSONL exclusive lock.
 * @param {StepCompleteEntry}  entry
 * @param {string}             tracePath
 * @param {{ lockOpts?: import('../types.mjs').LockOpts }} [opts]
 * @returns {Promise<WriteStepCompleteResult>}
 */
export async function writeStepComplete(entry, tracePath, opts = {}) {
  // --- Validation (before acquiring the lock) ---
  if (typeof entry.stepId !== 'string' || entry.stepId.trim() === '') {
    return { ok: false, entry, tracePath, error: 'stepId must be a non-empty string' };
  }
  if (typeof entry.label !== 'string' || entry.label.length > MAX_LABEL) {
    return {
      ok: false,
      entry,
      tracePath,
      error: `label must be a string of <= ${MAX_LABEL} chars`,
    };
  }
  const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : [];
  for (const a of artifacts) {
    const err = validateArtifact(a);
    if (err) return { ok: false, entry, tracePath, error: err };
  }

  // Normalise the entry: enforce event tag, numeric ts, capped verifyOutput.
  /** @type {StepCompleteEntry} */
  const normalised = {
    event: 'step_complete',
    stepId: entry.stepId,
    label: entry.label,
    taskId: entry.taskId,
    lane: entry.lane,
    artifacts,
    ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
  };
  if (typeof entry.verifyOutput === 'string') {
    normalised.verifyOutput = capString(entry.verifyOutput, MAX_VERIFY_OUTPUT);
  }

  // --- Idempotency scan + append under one held lock ---
  /** @type {import('../types.mjs').LockHandle | null} */
  let handle = null;
  try {
    handle = await acquireLock(tracePath, opts.lockOpts);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return { ok: false, entry: normalised, tracePath, error: 'lock_timeout' };
    }
    throw err;
  }

  try {
    if (await stepIdExists(tracePath, normalised.stepId)) {
      return { ok: false, entry: normalised, tracePath, error: 'already_complete' };
    }
    await appendJsonlWithHandle(tracePath, normalised);
    return { ok: true, entry: normalised, tracePath, error: null };
  } finally {
    await releaseLock(handle);
  }
}

/**
 * Scan the trace file for an existing `step_complete` entry with `stepId`.
 * Returns false if the file does not exist.
 * @param {string} tracePath
 * @param {string} stepId
 * @returns {Promise<boolean>}
 */
async function stepIdExists(tracePath, stepId) {
  /** @type {string} */
  let content;
  try {
    content = await readTextFile(tracePath);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o = JSON.parse(t);
      if (o && o.event === 'step_complete' && o.stepId === stepId) return true;
    } catch {
      continue;
    }
  }
  return false;
}
