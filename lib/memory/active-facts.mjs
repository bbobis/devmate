// @ts-check

/** @typedef {import('../types.mjs').FactEntry} FactEntry */

/**
 * From a list of ledger entries, return active `fact` entries (those whose
 * `ts` is not invalidated by a later `stale` entry for the same source).
 *
 * @param {Record<string, unknown>[]} entries
 * @returns {{ active: FactEntry[], staleCount: number }}
 */
export function collectActiveFacts(entries) {
  /** @type {Set<number>} */
  const staledTs = new Set();
  for (const e of entries) {
    if (e['event'] === 'stale' && typeof e['stalledFactTs'] === 'number') {
      staledTs.add(e['stalledFactTs']);
    }
  }

  /** @type {FactEntry[]} */
  const active = [];
  let staleCount = 0;
  for (const e of entries) {
    if (e['event'] !== 'fact') continue;
    if (typeof e['ts'] === 'number' && staledTs.has(e['ts'])) {
      staleCount++;
      continue;
    }
    active.push(/** @type {FactEntry} */ (/** @type {unknown} */ (e)));
  }

  return { active, staleCount };
}