// @ts-check
// Character-trigram token similarity — deterministic, dependency-free morphology
// robustness. Unifies inflected forms (fails/failing, tests/testing,
// vulnerability/vulnerabilities) that a suffix stripper cannot, while a
// start-boundary guard rejects unrelated words that merely share an interior
// substring (test vs latest, bug vs debug). No stemmer, no network, no LLM.

/**
 * The set of padded character trigrams of a token. Padding with a leading and
 * trailing space anchors the word boundaries, so the first trigram encodes the
 * start of the word and the last encodes the end.
 * @param {string} token
 * @returns {Set<string>}
 */
export function trigrams(token) {
  const padded = ` ${token} `;
  /** @type {Set<string>} */
  const set = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

/**
 * Sørensen–Dice similarity of two tokens' trigram sets, in [0, 1].
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function trigramSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) shared += 1;
  }
  return (2 * shared) / (ta.size + tb.size);
}

/** Two tokens must share this leading window to be eligible for a fuzzy match. */
const START_WINDOW = 3; // the first padded trigram: leading space + first 2 chars

/**
 * Minimum Dice similarity for a fuzzy (morphological) token match. Calibrated
 * against the skill-matching eval: 0.65 keeps true inflections (tests~test 0.67,
 * throws~throw 0.73, vulnerabilities~vulnerability 0.82) while rejecting
 * spurious near-collisions (readme~read 0.60). TODO: recalibrate via the weight
 * harness as the labelled corpus grows — provisional.
 */
export const TRIGRAM_MATCH_THRESHOLD = 0.65;

/**
 * True when `a` and `b` are the same word up to inflection: they share the
 * start-of-word window AND clear the similarity threshold. The start-boundary
 * guard is what separates fails/failing (shared ` fa`) from test/latest
 * (` te` vs ` la`) and bug/debug (` bu` vs ` de`).
 * @param {string} a
 * @param {string} b
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function morphologicallyMatches(a, b, threshold = TRIGRAM_MATCH_THRESHOLD) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false; // too short to judge by trigrams
  const pa = ` ${a} `.slice(0, START_WINDOW);
  const pb = ` ${b} `.slice(0, START_WINDOW);
  if (pa !== pb) return false;
  return trigramSimilarity(a, b) >= threshold;
}
