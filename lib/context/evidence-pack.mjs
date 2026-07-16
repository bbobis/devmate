// @ts-check
// E4-2: just-in-time evidence packs. Evidence travels as pointers, never as
// pasted file contents (TCM-3). Budget-class caps from the OutputContract
// (E4-1) are enforced at pack-creation time so a `tiny` task can never
// accumulate more than its stage cap of evidence pointers.
import { isAbsolute, resolve } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').EvidencePointer} EvidencePointer */
/** @typedef {import('../types.mjs').EvidencePack} EvidencePack */

const ALLOWED_KINDS = ['file', 'url', 'trace', 'tool-output'];

/**
 * Thrown when adding a pointer would exceed the pack's maxSources cap.
 */
export class BudgetExceededError extends Error {
  /**
   * @param {number} maxSources
   * @param {string} stage
   */
  constructor(maxSources, stage) {
    super(`EvidencePack budget exceeded: maxSources=${maxSources} for stage '${stage}'`);
    this.name = 'BudgetExceededError';
    this.code = 'EVIDENCE_BUDGET_EXCEEDED';
  }
}

/**
 * Thrown when a slice cannot be read (missing file or out-of-bounds range).
 */
export class SliceReadError extends Error {
  /**
   * @param {string} path
   * @param {string} detail
   */
  constructor(path, detail) {
    super(`Cannot read slice from ${path}: ${detail}`);
    this.name = 'SliceReadError';
    this.code = 'EVIDENCE_SLICE_READ';
    this.path = path;
  }
}

/**
 * Create an empty EvidencePack bound to a task and stage. Pure, no I/O.
 * @param {{ taskId: string, stage: string, maxSources: number }} opts
 * @returns {EvidencePack}
 */
export function createPack(opts) {
  if (!Number.isFinite(opts.maxSources) || opts.maxSources < 1) {
    throw new Error(`createPack: maxSources must be >= 1 (got ${opts.maxSources})`);
  }
  return {
    taskId: opts.taskId,
    stage: opts.stage,
    pointers: [],
    maxSources: opts.maxSources,
    created_at: new Date().toISOString(),
  };
}

/**
 * Validate a pointer's required fields. Returns an error message or null.
 * @param {EvidencePointer} p
 * @returns {string|null}
 */
function validatePointer(p) {
  if (!p || typeof p.path !== 'string' || p.path.trim() === '') {
    return 'path must be a non-empty string';
  }
  if (typeof p.reason !== 'string' || p.reason.trim() === '') {
    return 'reason must be a non-empty string';
  }
  if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
    return 'confidence must be a number in [0, 1]';
  }
  if (typeof p.freshness !== 'string' || Number.isNaN(Date.parse(p.freshness))) {
    return 'freshness must be a valid ISO-8601 timestamp';
  }
  if (!ALLOWED_KINDS.includes(p.kind)) {
    return `kind must be one of: ${ALLOWED_KINDS.join(', ')}`;
  }
  if (
    p.lineRange !== null &&
    !(
      Array.isArray(p.lineRange) &&
      p.lineRange.length === 2 &&
      p.lineRange.every((n) => Number.isInteger(n))
    )
  ) {
    return 'lineRange must be [startLine, endLine] or null';
  }
  return null;
}

/**
 * Add a pointer to the pack (immutable update). Throws BudgetExceededError when
 * the pack is already at maxSources.
 * @param {EvidencePack} pack
 * @param {EvidencePointer} pointer
 * @returns {EvidencePack}
 */
export function addPointer(pack, pointer) {
  const err = validatePointer(pointer);
  if (err) throw new Error(`Invalid EvidencePointer: ${err}`);
  if (pack.pointers.length >= pack.maxSources) {
    throw new BudgetExceededError(pack.maxSources, pack.stage);
  }
  return {
    ...pack,
    pointers: [...pack.pointers, pointer],
  };
}

/**
 * Load the exact file excerpt described by a pointer.
 * @param {EvidencePointer} pointer
 * @returns {Promise<string>}
 */
export async function loadSlice(pointer) {
  const filePath = isAbsolute(pointer.path)
    ? pointer.path
    : resolve(process.cwd(), pointer.path);

  /** @type {string} */
  let content;
  try {
    content = await readTextFile(filePath);
  } catch (/** @type {unknown} */ err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SliceReadError(pointer.path, detail);
  }

  if (pointer.lineRange === null) return content;

  const [startLine, endLine] = pointer.lineRange;
  const lines = content.split('\n');
  if (
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw new SliceReadError(
      pointer.path,
      `line range ${startLine}-${endLine} out of bounds (file has ${lines.length} lines)`,
    );
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Verify a pointer resolves to a real, in-range slice (read-before-assert).
 * @param {import('../types.mjs').EvidencePointer} pointer
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function verifyPointer(pointer) {
  try {
    await loadSlice(pointer);
    return { ok: true };
  } catch (/** @type {unknown} */ err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Serialize a pack to a compact JSON string (no pretty-print).
 * @param {EvidencePack} pack
 * @returns {string}
 */
export function serializePack(pack) {
  return JSON.stringify(pack);
}
