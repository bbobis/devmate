// @ts-check
import { FACTS_START, FACTS_END } from './render-memory.mjs';

/** @typedef {import('../types.mjs').MemoryMatch} MemoryMatch */

const OPEN_TAG = '<devmate-memory>';
const CLOSE_TAG = '</devmate-memory>';

// The committed memory file wraps its rendered facts in these sentinels (the
// single source of truth is lib/memory/render-memory.mjs). The fresh-clone
// fallback reads only inside them.

/**
 * Default line bound for the fresh-clone fallback block (#149). The committed
 * memory file can grow to the render soft cap (~200 lines); startup recall must
 * stay a bounded hint, never an unbounded dump, so the fallback is clipped here.
 * @type {number}
 */
export const MEMORY_FALLBACK_MAX_LINES = 40;

/**
 * Per-line character bound for the fresh-clone fallback block (#149 review). The
 * line cap alone bounds line COUNT; a hand-edited committed memory file (the seed
 * invites editing) could still smuggle one very long line past the filter and
 * blow the byte budget. Each injected line is clamped to this length so the block
 * is bounded in bytes too, not just in lines.
 * @type {number}
 */
export const MEMORY_FALLBACK_MAX_LINE_LEN = 200;

/**
 * Render recalled memory matches as a compact, model-visible context block.
 * Returns '' when there are no matches (nothing to inject).
 *
 * Token-disciplined by design: one bounded line per match (pointer + short
 * summary + lane/confidence), never raw file contents (TCM-8). The header nudges
 * the agent to verify a fact against live code before relying on it — recalled
 * memory is a hint, not ground truth (the verify-before-use principle).
 *
 * @param {MemoryMatch[]} matches   Already scored + bounded (see queryMemory).
 * @param {{ label?: string }} [opts]  label — optional scope tag (e.g. repo name).
 * @returns {string}  A `<devmate-memory>…</devmate-memory>` block, or ''.
 */
export function buildMemoryContext(matches, opts = {}) {
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const scope = opts.label ? ` (${opts.label})` : '';
  /** @type {string[]} */
  const lines = [
    OPEN_TAG,
    `Recalled facts${scope} — top ${matches.length} by relevance. ` +
      `Verify against current code before relying on them.`,
  ];
  for (const match of matches) {
    const conf =
      typeof match.confidence === 'number' ? match.confidence.toFixed(2) : '?';
    const lane = match.lane && match.lane !== 'unknown' ? match.lane : '-';
    const summary = match.summary && match.summary.trim() !== '' ? match.summary : '(no summary)';
    lines.push(`- ${match.source} — ${summary} [lane: ${lane}, conf: ${conf}]`);
  }
  lines.push(CLOSE_TAG);
  return lines.join('\n');
}

/**
 * Fresh-clone fallback recall (#149). The structured repo ledger is git-ignored,
 * so a fresh checkout has no scored recall — but the committed memory file IS
 * present. This renders the committed FACTS as a bounded `<devmate-memory>` block
 * so recall survives a clone. Only the marker-bounded facts block is read, and
 * only actual fact content (source headers `## …` and bullets `- …`) is kept —
 * a template/preamble with no facts yields '' (nothing to recall). Content is
 * clipped to `maxLines` with a truncation marker, never dumped whole
 * (TCM-8/TCM-9 — startup recall stays a bounded hint).
 *
 * @param {string} memoryMd  Raw contents of the committed memory file.
 * @param {{ maxLines?: number }} [opts]
 * @returns {string}  A `<devmate-memory>…</devmate-memory>` block, or ''.
 */
export function buildMemoryFallbackContext(memoryMd, opts = {}) {
  if (typeof memoryMd !== 'string' || memoryMd.trim() === '') return '';
  const maxLines =
    typeof opts.maxLines === 'number' && opts.maxLines > 0
      ? opts.maxLines
      : MEMORY_FALLBACK_MAX_LINES;

  // Read only inside the facts sentinels when present; otherwise scan the whole
  // file (an older or hand-written committed memory file with no markers).
  const startIdx = memoryMd.indexOf(FACTS_START);
  const endIdx = memoryMd.indexOf(FACTS_END);
  const region =
    startIdx !== -1 && endIdx !== -1 && startIdx < endIdx
      ? memoryMd.slice(startIdx + FACTS_START.length, endIdx)
      : memoryMd;

  // Keep only real fact content — source headers and bullets. This excludes a
  // template preamble ("# Memory", "> Canonical …"), so a freshly-initialised
  // repo with no promoted facts injects nothing.
  const content = region
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      const t = line.trim();
      return t.startsWith('## ') || t.startsWith('- ');
    });
  if (content.length === 0) return '';

  // Clamp line COUNT and per-line LENGTH — the block is bounded in both
  // dimensions so a single hand-edited long line can't defeat the cap by bytes.
  const shown = content.slice(0, maxLines).map((line) =>
    line.length > MEMORY_FALLBACK_MAX_LINE_LEN
      ? `${line.slice(0, MEMORY_FALLBACK_MAX_LINE_LEN)}…`
      : line,
  );
  /** @type {string[]} */
  const lines = [
    OPEN_TAG,
    'Recalled from committed memory (fresh checkout — no local ledger yet). ' +
      'Verify against current code before relying on them.',
    ...shown,
  ];
  if (content.length > maxLines) {
    lines.push(`… (${content.length - maxLines} more line(s) in the committed memory file)`);
  }
  lines.push(CLOSE_TAG);
  return lines.join('\n');
}
