// @ts-check
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { openReadStream, readTextFile, statPath } from '../fs-safe.mjs';
import { verifyFactSource } from './verify-fact.mjs';
import { contentDigest16, DISCOVERY_FACT_TOOL } from './discovery-facts.mjs';
import { digestsEqual } from '../digest-compare.mjs';

/** @typedef {import('../types.mjs').MemoryQueryRequest} MemoryQueryRequest */
/** @typedef {import('../types.mjs').MemoryQueryResult} MemoryQueryResult */
/** @typedef {import('../types.mjs').MemoryMatch} MemoryMatch */
/** @typedef {import('../types.mjs').FactEntry} FactEntry */
/** @typedef {import('../types.mjs').PointerSummary} PointerSummary */

/** Default maximum number of matches returned (TCM-9 token-cap boundary). */
const DEFAULT_TOP_N = 10;

/** Scoring weights — all components sum to a max of 1.0. */
const WEIGHT_LANE = 0.4;
const WEIGHT_PATH = 0.3;
const WEIGHT_TAG_PER = 0.1;
const WEIGHT_TAG_CAP = 0.2;
const WEIGHT_CONFIDENCE = 0.1;

/**
 * Round a float to 4 decimal places.
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Read every line of a JSONL file, returning parsed objects and a skip count.
 * Unparseable lines are skipped (counted, not thrown). Missing file → empty.
 * @param {string} ledgerPath
 * @returns {Promise<{ rows: any[], scanned: number, missing: boolean }>}
 */
async function readLedger(ledgerPath) {
  /** @type {any[]} */
  const rows = [];
  let scanned = 0;

  // Resolve missing/unreadable ledgers up front so no dangling read stream is
  // left to emit an async error after we have already returned.
  try {
    const st = await statPath(ledgerPath);
    if (!st.isFile()) return { rows, scanned, missing: true };
  } catch {
    return { rows, scanned, missing: true };
  }

  const stream = openReadStream(ledgerPath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    scanned += 1;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Malformed line: counted in scanned, not scored.
    }
  }
  return { rows, scanned, missing: false };
}

/**
 * Build the set of fact timestamps that have been marked stale.
 * Mirrors the stale-set used by compaction (lib/memory/compact.mjs).
 * @param {any[]} rows
 * @returns {Set<number>}
 */
function buildStaledTsSet(rows) {
  /** @type {Set<number>} */
  const staled = new Set();
  for (const o of rows) {
    if (o && o.event === 'stale' && typeof o.stalledFactTs === 'number') {
      staled.add(o.stalledFactTs);
    }
  }
  return staled;
}

/**
 * Score a fact or pointer-summary against the request.
 * @param {{ lane: string, source: string, tags: string[], confidence: number, summaryText: string }} entry
 * @param {MemoryQueryRequest} request
 * @returns {number}
 */
function scoreEntry(entry, request) {
  let score = 0;

  if (request.lane && entry.lane === request.lane) {
    score += WEIGHT_LANE;
  }

  if (request.pathPrefix && entry.source.startsWith(request.pathPrefix)) {
    score += WEIGHT_PATH;
  }

  if (Array.isArray(request.tags) && request.tags.length > 0) {
    const entryTags = new Set(entry.tags);
    let overlap = 0;
    for (const t of request.tags) {
      if (entryTags.has(t)) overlap += 1;
    }
    score += Math.min(overlap * WEIGHT_TAG_PER, WEIGHT_TAG_CAP);
  }

  score += WEIGHT_CONFIDENCE * (entry.confidence ?? 0);

  return round4(Math.min(score, 1));
}

/**
 * Query the repo memory ledger and return the top-N most relevant facts as
 * compact pointer+summary records. Pure read: never modifies the ledger and
 * never acquires the write lock.
 *
 * Scoring (additive, normalised 0-1):
 *   - lane match (+0.4)
 *   - pathPrefix match (+0.3)
 *   - tag overlap: +0.1 per matching tag, capped at +0.2
 *   - confidence: +0.1 x fact.confidence
 * Stale entries are excluded unless `includeExpired: true`.
 *
 * When `opts.verifyRoot` is set, each fact match is verify-before-use checked:
 * a fact whose `source` no longer resolves to a file under `verifyRoot` is
 * dropped (counted in `driftedExcluded`) so recall never hands back a pointer
 * into code that has since moved or been deleted. Pointer summaries aggregate
 * multiple sources and are never dropped.
 *
 * When `opts.staleCheckRoot` is set (FO-6, opt-in — digesting files costs IO),
 * each returned discovery match is annotated with `stale`: the referenced
 * file's current 16-hex content digest is recomputed and compared against the
 * digest recorded at write time; a mismatch, a missing file, or a fact with no
 * recorded digest marks the match `stale: true`. Stale matches are annotated,
 * never dropped — the caller decides whether to re-verify or discard. Only the
 * top-N matches are digested, so the check is bounded by the output cap.
 *
 * @param {string}             repoLedgerPath
 * @param {MemoryQueryRequest} request
 * @param {{ lockOpts?: import('../types.mjs').LockOpts, verifyRoot?: string, staleCheckRoot?: string, kind?: 'discovery' }} [opts]
 *   #150: `kind: 'discovery'` restricts `fact` recall to semantic discovery facts,
 *   excluding bare edit events. `pointer_summary` entries are compacted semantic
 *   aggregates (not edit telemetry) and are intentionally KEPT under this filter.
 *   Additive and opt-in — the default (unset) is unchanged.
 * @returns {Promise<MemoryQueryResult>}
 */
export async function queryMemory(repoLedgerPath, request, opts = {}) {
  try {
    const { rows, scanned, missing } = await readLedger(repoLedgerPath);
    if (missing) {
      return { ok: true, matches: [], totalActive: 0, scanned: 0, error: null };
    }

    const staledTs = buildStaledTsSet(rows);
    const includeExpired = request.includeExpired === true;
    const topN = typeof request.topN === 'number' && request.topN >= 0
      ? request.topN
      : DEFAULT_TOP_N;

    /** @type {MemoryMatch[]} */
    const candidates = [];
    let totalActive = 0;

    for (const o of rows) {
      if (!o || typeof o !== 'object') continue;

      if (o.event === 'fact') {
        const fact = /** @type {FactEntry} */ (o);
        const isStale = typeof fact.ts === 'number' && staledTs.has(fact.ts);
        if (isStale && !includeExpired) continue;
        totalActive += isStale ? 0 : 1;
        const tags = Array.isArray(fact.tags) ? fact.tags : [];
        const score = scoreEntry(
          {
            lane: fact.lane,
            source: fact.source,
            tags,
            confidence: typeof fact.confidence === 'number' ? fact.confidence : 0,
            summaryText: fact.summary ?? '',
          },
          request,
        );
        // FO-6: discovery facts stay visibly typed all the way to the caller,
        // and carry their write-time content digest so the stale check can
        // recompute freshness without re-reading the ledger.
        const isDiscovery = fact.tool === DISCOVERY_FACT_TOOL;
        // #150: opt-in kind filter — restrict recall to semantic discovery facts.
        // Excludes from matches without changing totalActive (the scan metric).
        if (opts.kind === 'discovery' && !isDiscovery) continue;
        candidates.push({
          source: fact.source,
          summary: fact.summary ?? '',
          tags,
          lane: fact.lane ?? 'unknown',
          confidence: typeof fact.confidence === 'number' ? fact.confidence : 0,
          score,
          ts: typeof fact.ts === 'number' ? fact.ts : 0,
          isPointerSummary: false,
          ...(isDiscovery ? { kind: /** @type {'discovery'} */ ('discovery') } : {}),
          ...(isDiscovery && fact.contentDigest
            ? { contentDigest: fact.contentDigest }
            : {}),
        });
      } else if (o.event === 'pointer_summary') {
        const ps = /** @type {PointerSummary} */ (o);
        totalActive += 1;
        const tags = Array.isArray(ps.tags) ? ps.tags : [];
        const source = Array.isArray(ps.sources) && ps.sources.length > 0 ? ps.sources[0] : '';
        const score = scoreEntry(
          { lane: '', source, tags, confidence: 1, summaryText: ps.summary ?? '' },
          request,
        );
        candidates.push({
          source,
          summary: ps.summary ?? '',
          tags,
          lane: 'summary',
          confidence: 1,
          score,
          ts: typeof ps.ts === 'number' ? ps.ts : 0,
          isPointerSummary: true,
        });
      }
    }

    // Verify-before-use: drop fact matches whose source no longer resolves to
    // live code, so recall never returns a pointer into moved/deleted files.
    let driftedExcluded = 0;
    let survivors = candidates;
    if (typeof opts.verifyRoot === 'string' && opts.verifyRoot !== '') {
      const root = opts.verifyRoot;
      survivors = candidates.filter((m) => {
        if (m.isPointerSummary) return true;
        if (verifyFactSource({ source: m.source }, root).resolves) return true;
        driftedExcluded += 1;
        return false;
      });
    }

    survivors.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
    const matches = survivors.slice(0, topN);

    if (typeof opts.staleCheckRoot === 'string' && opts.staleCheckRoot !== '') {
      await annotateStaleness(matches, opts.staleCheckRoot);
    }

    return { ok: true, matches, totalActive, scanned, driftedExcluded, error: null };
  } catch (err) {
    return {
      ok: false,
      matches: [],
      totalActive: 0,
      scanned: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * FO-6 stale check: annotate each discovery match with `stale` by recomputing
 * the referenced file's content digest under `root`. Mutates the matches in
 * place (they are already this call's private copies). A fact without a
 * recorded digest cannot be verified and is marked stale (fail-closed — the
 * normal discovery flow re-verifies it).
 * @param {MemoryMatch[]} matches
 * @param {string} root
 * @returns {Promise<void>}
 */
async function annotateStaleness(matches, root) {
  const rootAbs = resolve(root);
  for (const m of matches) {
    if (m.kind !== 'discovery') continue;
    let fresh = false;
    const abs = resolve(rootAbs, m.source);
    // Containment: a tainted ledger source must never read outside the root.
    if (abs.startsWith(rootAbs + sep)) {
      try {
        const content = await readTextFile(abs);
        // digestsEqual is false for an absent recorded digest — fail-closed.
        fresh = digestsEqual(contentDigest16(content), m.contentDigest);
      } catch {
        fresh = false; // missing/unreadable file — the pointer has drifted
      }
    }
    m.stale = !fresh;
  }
}
