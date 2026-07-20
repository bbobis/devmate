// @ts-check
import { createInterface } from 'node:readline';
import { openReadStream, statPath } from '../fs-safe.mjs';
import { DISCOVERY_FACT_TOOL } from './discovery-facts.mjs';

/** @typedef {import('../types.mjs').LedgerStats} LedgerStats */

/**
 * Compute ledger statistics without loading the whole file into memory.
 * Uses `fs.stat` for the byte size and a streaming `readline` pass for counts.
 *
 * `activeCount` counts `fact` entries whose `ts` is not referenced by any
 * later `stale` entry (`stalledFactTs`) in the same ledger.
 *
 * @param {string} ledgerPath
 * @returns {Promise<LedgerStats>}
 */
export async function getLedgerStats(ledgerPath) {
  /** @type {number} */
  let bytes = 0;
  try {
    const st = await statPath(ledgerPath);
    bytes = st.size;
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      return { entryCount: 0, activeCount: 0, discoveryActiveCount: 0, bytes: 0 };
    }
    throw err;
  }

  let entryCount = 0;
  /** @type {Set<number>} */
  const factTs = new Set();
  /** @type {Set<number>} */
  const discoveryFactTs = new Set();
  /** @type {Set<number>} */
  const staledTs = new Set();

  const rl = createInterface({
    input: openReadStream(ledgerPath),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '') continue;
    entryCount++;
    /** @type {any} */
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate malformed lines in the count
    }
    if (obj && obj.event === 'fact' && typeof obj.ts === 'number') {
      factTs.add(obj.ts);
      // Issue 150: track the discovery-fact subset so the doctor can compare
      // like-for-like against what .devmate/MEMORY.md renders (discovery facts only).
      if (obj.tool === DISCOVERY_FACT_TOOL) discoveryFactTs.add(obj.ts);
    } else if (
      obj &&
      obj.event === 'stale' &&
      typeof obj.stalledFactTs === 'number'
    ) {
      staledTs.add(obj.stalledFactTs);
    }
  }

  let activeCount = 0;
  for (const ts of factTs) {
    if (!staledTs.has(ts)) activeCount++;
  }
  let discoveryActiveCount = 0;
  for (const ts of discoveryFactTs) {
    if (!staledTs.has(ts)) discoveryActiveCount++;
  }

  return { entryCount, activeCount, discoveryActiveCount, bytes };
}
