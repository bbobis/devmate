// @ts-check
// Conflict resolution between an existing repo fact and an incoming task fact
// for the same source identity (E3-4).

/** @typedef {import('../types.mjs').FactEntry} FactEntry */
/** @typedef {import('../types.mjs').ConflictPolicy} ConflictPolicy */

/**
 * Resolve a conflict between an existing repo fact and an incoming task fact
 * for the same source identity.
 *
 *  - `keep-existing`: repo fact wins; incoming is the loser.
 *  - `keep-incoming`: task fact wins; existing is the loser.
 *  - `keep-both`:     both are kept (no loser). The caller is responsible for
 *                     writing both entries; their distinct `ts` values keep
 *                     them addressable.
 *
 * @param {FactEntry}      existing
 * @param {FactEntry}      incoming
 * @param {ConflictPolicy} policy
 * @returns {{ winner: FactEntry, loser: FactEntry | null }}
 */
export function resolveConflict(existing, incoming, policy) {
  switch (policy) {
    case 'keep-existing':
      return { winner: existing, loser: incoming };
    case 'keep-incoming':
      return { winner: incoming, loser: existing };
    case 'keep-both':
      // Both survive; signal "no loser" so the caller writes both.
      return { winner: incoming, loser: null };
    default:
      // Unknown policy falls back to the safe default: keep incoming.
      return { winner: incoming, loser: existing };
  }
}
