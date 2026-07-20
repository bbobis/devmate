// @ts-check
// E4-2: just-in-time evidence packs. Evidence travels as pointers, never as
// pasted file contents (TCM-3). Budget-class caps from the OutputContract
// (E4-1) are enforced at pack-creation time so a `tiny` task can never
// accumulate more than its stage cap of evidence pointers.
import { isAbsolute, resolve } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';
import { estimateTokens } from './estimate-tokens.mjs';

/** @typedef {import('../types.mjs').EvidencePointer} EvidencePointer */
/** @typedef {import('../types.mjs').EvidencePack} EvidencePack */

/**
 * One admitted pointer plus the fidelity the packer chose for it (#30).
 * @typedef {{ pointer: EvidencePointer, form: 'summary'|'full' }} AdmittedEvidence
 */

/**
 * The result of packing candidate pointers under a budget (#30).
 * @typedef {Object} EvidencePackPlan
 * @property {AdmittedEvidence[]} admitted  Admitted pointers, highest value first, with the chosen slice form.
 * @property {number} totalTokenEstimate    Sum of the chosen forms' token estimates.
 * @property {number} dropped               Candidates that did not fit (observable, never silent — AGENTS.md).
 */

const ALLOWED_KINDS = ['file', 'url', 'trace', 'tool-output'];

// ── #30: value-ranked greedy evidence packing with elastic snippets ───────────

/**
 * Value-score weights (confidence, freshness, relevance). Equal for now.
 * TODO: calibrate — provisional equal weighting; revisit after the E14-2
 * telemetry pass shows which admitted pointers were actually cited downstream.
 */
const W_CONFIDENCE = 1;
const W_FRESHNESS = 1;
const W_RELEVANCE = 1;

/**
 * Remaining-budget fraction at or below which an admitted pointer is loaded as a
 * short SUMMARY rather than a FULL slice (elastic snippets, B3 ch6).
 * TODO: calibrate — provisional 0.2, revisit after review.
 * @type {number}
 */
export const ELASTIC_SUMMARY_TRIGGER_RATIO = 0.2;

/** Per-line token estimate for a full slice sized from its lineRange. TODO: calibrate — provisional. */
const TOKENS_PER_LINE = 12;
/** Full-slice token estimate for a whole-file pointer (lineRange null). TODO: calibrate — provisional. */
const DEFAULT_FULL_TOKENS = 400;

/**
 * Clamp a value to [0, 1]; non-numbers become 0.
 * @param {unknown} n
 * @returns {number}
 */
function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The referenced file's last-modified/retrieval epoch (ms), or 0 if unparseable.
 * @param {EvidencePointer} p
 * @returns {number}
 */
function freshnessEpoch(p) {
  const t = Date.parse(p.freshness);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Build a freshness scorer in [0, 1] by RELATIVE recency across the candidate
 * set (newest = 1). Deterministic — ranks the set against itself rather than
 * against a wall clock — so packing the same inputs is reproducible.
 * @param {EvidencePointer[]} pointers
 * @returns {(p: EvidencePointer) => number}
 */
function freshnessScorer(pointers) {
  if (pointers.length === 0) return () => 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pointers) {
    const e = freshnessEpoch(p);
    if (e < min) min = e;
    if (e > max) max = e;
  }
  const span = max - min;
  return (p) => (span === 0 ? 1 : (freshnessEpoch(p) - min) / span);
}

/**
 * Relevance score. Presence-based for now: a pointer that states WHY it is
 * relevant scores 1, else 0.
 * TODO: calibrate — swap for length-normalized keyword overlap with the step
 * goal after E14-2.
 * @param {EvidencePointer} p
 * @returns {number}
 */
function relevanceScore(p) {
  return typeof p.reason === 'string' && p.reason.trim() !== '' ? 1 : 0;
}

/**
 * The compact one-line descriptor a `summary` slice resolves to — pointer
 * metadata + reason, never file content (TCM-8).
 * @param {EvidencePointer} p
 * @returns {string}
 */
function summaryDescriptor(p) {
  const range = p.lineRange ? `:${p.lineRange[0]}-${p.lineRange[1]}` : '';
  return `[${p.kind}] ${p.path}${range} — ${p.reason}`;
}

/**
 * Estimated tokens of a pointer's FULL slice, from its line span (or a default
 * for a whole-file pointer). A pure estimate — packing does no I/O.
 * @param {EvidencePointer} p
 * @returns {number}
 */
function fullTokens(p) {
  // A whole-file pointer (null) OR a malformed one (missing/non-tuple lineRange —
  // a contract violation from an agent-authored artifact) degrades to the default
  // rather than throwing, mirroring the defensive summaryDescriptor path (#30 review).
  if (!Array.isArray(p.lineRange)) return DEFAULT_FULL_TOKENS;
  const [start, end] = p.lineRange;
  return Math.max(1, end - start + 1) * TOKENS_PER_LINE;
}

/**
 * Estimated tokens of a pointer's SUMMARY form (the compact descriptor).
 * @param {EvidencePointer} p
 * @returns {number}
 */
function summaryTokens(p) {
  return Math.max(1, estimateTokens(summaryDescriptor(p)));
}

/**
 * Rank pointers by descending value, deterministically (value desc, then path
 * asc, then original index) so the same inputs always pack the same way.
 * @param {EvidencePointer[]} pointers
 * @returns {Array<{ pointer: EvidencePointer, index: number, value: number }>}
 */
function rankByValue(pointers) {
  const scoreFreshness = freshnessScorer(pointers);
  return pointers
    .map((pointer, index) => ({
      pointer,
      index,
      value:
        W_CONFIDENCE * clamp01(pointer.confidence) +
        W_FRESHNESS * scoreFreshness(pointer) +
        W_RELEVANCE * relevanceScore(pointer),
    }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        // `?? ''` keeps the tiebreak crash-safe if a pointer lacks a path (a
        // contract violation from an agent artifact) — the whole packer degrades
        // rather than throwing on one malformed entry (#30 review).
        (a.pointer.path ?? '').localeCompare(b.pointer.path ?? '') ||
        a.index - b.index,
    );
}

/**
 * Additive greedy: admit by descending value, choosing a summary form once the
 * remaining budget is tight (else full), and downgrading a full that won't fit
 * to a summary before dropping it.
 * @param {Array<{ pointer: EvidencePointer }>} ranked
 * @param {number} maxTokens
 * @param {number} maxSources
 * @param {number} total
 * @returns {EvidencePackPlan}
 */
function packAdditive(ranked, maxTokens, maxSources, total) {
  /** @type {AdmittedEvidence[]} */
  const admitted = [];
  let used = 0;
  for (const { pointer } of ranked) {
    if (admitted.length >= maxSources) break;
    const remaining = maxTokens - used;
    if (remaining <= 0) break;
    const tight = remaining <= ELASTIC_SUMMARY_TRIGGER_RATIO * maxTokens;
    /** @type {'summary'|'full'} */
    let form = tight ? 'summary' : 'full';
    let cost = form === 'full' ? fullTokens(pointer) : summaryTokens(pointer);
    if (form === 'full' && cost > remaining) {
      form = 'summary';
      cost = summaryTokens(pointer);
    }
    if (cost > remaining) continue; // even the summary won't fit — try the next, smaller-value item
    admitted.push({ pointer, form });
    used += cost;
  }
  return { admitted, totalTokenEstimate: used, dropped: total - admitted.length };
}

/**
 * Subtractive greedy (the `large` class): start from the top-value `maxSources`
 * as full slices, then drop the lowest-value until the token budget is met —
 * reduction (TCM-6) precedes packing.
 * @param {Array<{ pointer: EvidencePointer }>} ranked
 * @param {number} maxTokens
 * @param {number} maxSources
 * @param {number} total
 * @returns {EvidencePackPlan}
 */
function packSubtractive(ranked, maxTokens, maxSources, total) {
  const kept = ranked.slice(0, maxSources); // ranked is value-desc — keep the best
  let used = kept.reduce((sum, r) => sum + fullTokens(r.pointer), 0);
  while (kept.length > 0 && used > maxTokens) {
    const removed = kept.pop(); // lowest value (tail)
    if (removed) used -= fullTokens(removed.pointer);
  }
  const admitted = kept.map((r) => /** @type {AdmittedEvidence} */ ({ pointer: r.pointer, form: 'full' }));
  return { admitted, totalTokenEstimate: used, dropped: total - admitted.length };
}

/**
 * Greedily admit evidence pointers by descending value under a token + source
 * budget, choosing a summary or full slice form per item based on remaining
 * budget (elastic snippets). Pure and deterministic — no I/O, no wall clock.
 *
 * `mode: 'subtractive'` (for the `large` class) starts full and drops the
 * lowest-value until it fits; the default additive mode adds by descending value
 * until the budget is exhausted. `dropped` makes truncation observable, never
 * silent (AGENTS.md: no silent caps).
 * @param {EvidencePointer[]} pointers
 * @param {{ maxTokens: number, maxSources: number, mode?: 'additive'|'subtractive' }} budget
 * @returns {EvidencePackPlan}
 */
export function packEvidence(pointers, budget) {
  const list = Array.isArray(pointers) ? pointers : [];
  const maxTokens = Number.isFinite(budget?.maxTokens) ? Math.max(0, budget.maxTokens) : 0;
  const maxSources = Number.isFinite(budget?.maxSources) ? Math.max(0, budget.maxSources) : 0;
  const ranked = rankByValue(list);
  return budget?.mode === 'subtractive'
    ? packSubtractive(ranked, maxTokens, maxSources, list.length)
    : packAdditive(ranked, maxTokens, maxSources, list.length);
}

/**
 * Elastic slice loader (#30): honor the form the packer chose — return the
 * compact summary descriptor (no file read) for `summary`, or the full slice
 * content for `full`.
 * @param {EvidencePointer} pointer
 * @param {'summary'|'full'} form
 * @returns {Promise<string>}
 */
export async function loadElasticSlice(pointer, form) {
  if (form === 'summary') return summaryDescriptor(pointer);
  return loadSlice(pointer);
}

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
