// @ts-check
// E4-3: ContextReducer MapReduce. When a `large`-budget task accumulates more
// evidence than its stage cap (TCM-1, TCM-6), this pipeline reduces the
// EvidencePack to a compact ReducedPack WITHOUT losing critical facts or
// citations. Every chunk summary links back to its originating pointers so
// later stages can reload exact slices rather than trusting summary text.
import { loadSlice, SliceReadError } from './evidence-pack.mjs';

/** @typedef {import('../types.mjs').EvidencePointer} EvidencePointer */
/** @typedef {import('../types.mjs').EvidencePack} EvidencePack */
/** @typedef {import('../types.mjs').ChunkSummary} ChunkSummary */
/** @typedef {import('../types.mjs').ReducedPack} ReducedPack */

/** Default pointers per chunk in the Map phase. */
const DEFAULT_CHUNK_SIZE = 5;
/** Max characters in a single ChunkSummary.summary. */
const SUMMARY_CAP = 300;
/** Max characters in the merged narrative. */
const MERGE_SUMMARY_CAP = 800;
/** Max preserved facts captured per chunk. */
const MAX_FACTS_PER_CHUNK = 5;

/**
 * Truncate a string to a maximum length without throwing on short input.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Extract the first sentence of a text slice. Falls back to the first line, then
 * the whole trimmed string, so a fact is always produced for non-empty input.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const match = trimmed.match(/^.*?[.!?](\s|$)/s);
  if (match) return match[0].trim();
  const firstLine = trimmed.split('\n')[0];
  return firstLine.trim();
}

/**
 * Split an EvidencePack into chunks of at most chunkSize pointers each.
 * Pure, no I/O.
 * @param {EvidencePack} pack
 * @param {number} [chunkSize=5]
 * @returns {EvidencePointer[][]}
 */
export function mapChunks(pack, chunkSize = DEFAULT_CHUNK_SIZE) {
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
  const pointers = Array.isArray(pack.pointers) ? pack.pointers : [];
  /** @type {EvidencePointer[][]} */
  const chunks = [];
  for (let i = 0; i < pointers.length; i += size) {
    chunks.push(pointers.slice(i, i + size));
  }
  return chunks;
}

/**
 * Summarize one chunk of EvidencePointers into a ChunkSummary. Loads each
 * pointer's slice; an unreadable slice is recorded as a preserved fact marker
 * and does NOT abort the pipeline. The original chunk is always returned as
 * sourcePointers so back-references are never lost.
 * @param {EvidencePointer[]} chunk
 * @param {number} chunkIndex
 * @param {{ summarize?: (text: string, pointers: EvidencePointer[]) => string }} [opts]
 * @returns {Promise<ChunkSummary>}
 */
export async function reduceChunk(chunk, chunkIndex, opts = {}) {
  /** @type {string[]} */
  const sliceTexts = [];
  /** @type {string[]} */
  const preservedFacts = [];

  for (const pointer of chunk) {
    /** @type {string} */
    let text;
    try {
      text = await loadSlice(pointer);
    } catch (/** @type {unknown} */ err) {
      if (err instanceof SliceReadError) {
        preservedFacts.push(`[SLICE_UNREADABLE] ${pointer.path}`);
        continue;
      }
      throw err;
    }
    sliceTexts.push(text);
    const fact = firstSentence(text);
    if (fact !== '' && preservedFacts.length < MAX_FACTS_PER_CHUNK) {
      preservedFacts.push(fact);
    }
  }

  const joined = sliceTexts.join('\n');
  /** @type {string} */
  let summary;
  if (typeof opts.summarize === 'function') {
    summary = truncate(opts.summarize(joined, chunk), SUMMARY_CAP);
  } else {
    summary = truncate(
      preservedFacts.filter((f) => !f.startsWith('[SLICE_UNREADABLE]')).join(' '),
      SUMMARY_CAP,
    );
  }

  return {
    chunkIndex,
    summary,
    sourcePointers: chunk,
    preservedFacts: preservedFacts.slice(0, MAX_FACTS_PER_CHUNK),
  };
}

/**
 * Merge all ChunkSummaries into a ReducedPack. Deduplicates pointers by
 * path + line range so a pointer appearing in multiple chunks is listed once.
 * @param {ChunkSummary[]} summaries
 * @param {{ taskId: string, stage: string, originalCount: number }} meta
 * @returns {ReducedPack}
 */
export function mergeChunks(summaries, meta) {
  const mergeSummary = truncate(
    summaries.map((s) => s.summary).filter((s) => s !== '').join('; '),
    MERGE_SUMMARY_CAP,
  );

  /** @type {Map<string, EvidencePointer>} */
  const seen = new Map();
  for (const s of summaries) {
    for (const p of s.sourcePointers) {
      const key = `${p.path}::${JSON.stringify(p.lineRange)}`;
      if (!seen.has(key)) seen.set(key, p);
    }
  }

  return {
    taskId: meta.taskId,
    stage: meta.stage,
    mergeSummary,
    chunks: summaries,
    allPointers: [...seen.values()],
    originalCount: meta.originalCount,
    reducedAt: new Date().toISOString(),
  };
}

/**
 * Full MapReduce pipeline: split, reduce (in parallel), merge. Returns null
 * when the pack is within its maxSources budget (no reduction needed). A
 * `large`-budget task MUST call this before synthesis; callers enforce that —
 * this module does not hard-block.
 * @param {EvidencePack} pack
 * @param {{ chunkSize?: number, summarize?: (text: string, pointers: EvidencePointer[]) => string }} [opts]
 * @returns {Promise<ReducedPack|null>}
 */
export async function reduceEvidencePack(pack, opts = {}) {
  const pointers = Array.isArray(pack.pointers) ? pack.pointers : [];
  if (pointers.length <= pack.maxSources) return null;

  const chunks = mapChunks(pack, opts.chunkSize);
  const summaries = await Promise.all(
    chunks.map((chunk, i) => reduceChunk(chunk, i, { summarize: opts.summarize })),
  );

  return mergeChunks(summaries, {
    taskId: pack.taskId,
    stage: pack.stage,
    originalCount: pointers.length,
  });
}
