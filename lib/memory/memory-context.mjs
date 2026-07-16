// @ts-check
/** @typedef {import('../types.mjs').MemoryMatch} MemoryMatch */

const OPEN_TAG = '<devmate-memory>';
const CLOSE_TAG = '</devmate-memory>';

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
