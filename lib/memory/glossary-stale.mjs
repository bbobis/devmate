// @ts-check
/**
 * E8-2: pure stale-marker helpers for glossary entries.
 *
 * NOTE: a separate `lib/memory/stale-marker.mjs` already exists from E3-5 with a
 * different, ledger-mutating `markStale(ledgerPath, sourceIdentity, reason)` API.
 * To avoid drift/collision, the glossary's pure helpers live here instead.
 */

/** @typedef {import('../types.mjs').GlossaryEntry} GlossaryEntry */

/**
 * Return a NEW glossary entry with `staleReason` set. Pure — the input is not
 * mutated.
 * @param {GlossaryEntry} entry
 * @param {string} reason
 * @returns {GlossaryEntry}
 */
export function markStale(entry, reason) {
  return { ...entry, staleReason: reason };
}

/**
 * True when an entry carries a non-empty `staleReason`.
 * @param {GlossaryEntry} entry
 * @returns {boolean}
 */
export function isStale(entry) {
  return Boolean(entry.staleReason);
}
