// @ts-check
import { dirname, basename, join } from 'node:path';
import {
  appendTextFile,
  ensureDir,
  readTextFile,
  removeFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { getLedgerStats } from './ledger-stats.mjs';

/** @typedef {import('../types.mjs').CompactOpts} CompactOpts */
/** @typedef {import('../types.mjs').CompactResult} CompactResult */
/** @typedef {import('../types.mjs').PointerSummary} PointerSummary */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  maxEntries: 200,
  maxBytes: 102400,
  targetEntries: 80,
  minConfidence: 0.3,
  expiryAgeDays: 90,
};

/**
 * Resolve the archive directory for a ledger path.
 * @param {string} ledgerPath
 * @param {CompactOpts} opts
 * @returns {string}
 */
function resolveArchiveDir(ledgerPath, opts) {
  return opts.archiveDir ?? ledgerPath + '.archive';
}

/**
 * Build the dated archive file path for a ledger.
 * @param {string} ledgerPath
 * @param {string} archiveDir
 * @param {number} now
 * @returns {string}
 */
function archiveFileFor(ledgerPath, archiveDir, now) {
  const d = new Date(now);
  const stamp =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  const base = basename(ledgerPath);
  return join(archiveDir, `${base}-${stamp}.jsonl`);
}

/**
 * Check whether `ledgerPath` exceeds caps and needs compaction.
 * Reads only file metadata and a line count — does not parse JSON deeply.
 * @param {string}      ledgerPath
 * @param {CompactOpts} [opts]
 * @returns {Promise<boolean>}
 */
export async function shouldCompact(ledgerPath, opts = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULTS.maxEntries;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const stats = await getLedgerStats(ledgerPath);
  return stats.entryCount > maxEntries || stats.bytes > maxBytes;
}

/**
 * Read and parse every line of a ledger into objects (with original raw line).
 * @param {string} ledgerPath
 * @returns {Promise<Array<{ raw: string, obj: any }>>}
 */
async function readEntries(ledgerPath) {
  /** @type {string} */
  let content;
  try {
    content = await readTextFile(ledgerPath);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  /** @type {Array<{ raw: string, obj: any }>} */
  const out = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push({ raw: t, obj: JSON.parse(t) });
    } catch {
      // keep malformed line as-is so we never silently lose data
      out.push({ raw: t, obj: null });
    }
  }
  return out;
}

/**
 * Append raw JSONL lines to the archive file (never truncates).
 * @param {string}   archivePath
 * @param {string[]} rawLines
 * @returns {Promise<void>}
 */
async function appendArchive(archivePath, rawLines) {
  if (rawLines.length === 0) return;
  await ensureDir(dirname(archivePath));
  await appendTextFile(archivePath, rawLines.join('\n') + '\n');
}

/**
 * Group active facts by their immediate directory prefix.
 * @param {Array<{ raw: string, obj: any }>} facts
 * @returns {Map<string, Array<{ raw: string, obj: any }>>}
 */
function groupByDirPrefix(facts) {
  /** @type {Map<string, Array<{ raw: string, obj: any }>>} */
  const groups = new Map();
  for (const f of facts) {
    const src = typeof f.obj.source === 'string' ? f.obj.source : 'unknown';
    const idx = src.lastIndexOf('/');
    const prefix = idx === -1 ? '.' : src.slice(0, idx);
    const arr = groups.get(prefix) ?? [];
    arr.push(f);
    groups.set(prefix, arr);
  }
  return groups;
}

/**
 * Compact `ledgerPath` in-place under exclusive lock.
 * @param {string}      ledgerPath
 * @param {CompactOpts} [opts]
 * @returns {Promise<CompactResult>}
 */
export async function compactLedger(ledgerPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes; // referenced for parity
  void maxBytes;
  const targetEntries = opts.targetEntries ?? DEFAULTS.targetEntries;
  const minConfidence = opts.minConfidence ?? DEFAULTS.minConfidence;
  const expiryAgeDays = opts.expiryAgeDays ?? DEFAULTS.expiryAgeDays;
  const archiveDir = resolveArchiveDir(ledgerPath, opts);
  const now = Date.now();
  const expiryCutoff = now - expiryAgeDays * DAY_MS;
  const archivePath = archiveFileFor(ledgerPath, archiveDir, now);

  /** @type {import('../types.mjs').LockHandle | null} */
  let handle = null;
  try {
    handle = await acquireLock(ledgerPath, opts.lockOpts);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return {
        ok: false,
        entriesBefore: 0,
        entriesAfter: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        expired: 0,
        summarised: 0,
        archivePath,
      };
    }
    throw err;
  }

  try {
    const statsBefore = await getLedgerStats(ledgerPath);
    const entries = await readEntries(ledgerPath);
    const bytesBefore = statsBefore.bytes;
    const entriesBefore = statsBefore.entryCount;

    // Determine which fact ts are staled.
    /** @type {Set<number>} */
    const staledTs = new Set();
    for (const e of entries) {
      if (e.obj && e.obj.event === 'stale' && typeof e.obj.stalledFactTs === 'number') {
        staledTs.add(e.obj.stalledFactTs);
      }
    }

    /** @type {string[]} */
    const archiveLines = [];
    /** @type {Array<{ raw: string, obj: any }>} retained non-fact + active facts */
    const retainedNonFact = [];
    /** @type {Array<{ raw: string, obj: any }>} active facts kept for summarise pass */
    const activeFacts = [];
    let expired = 0;

    // --- Expiry pass ---
    for (const e of entries) {
      const o = e.obj;
      if (o === null) {
        retainedNonFact.push(e); // never drop malformed lines silently
        continue;
      }
      if (o.event === 'stale') {
        // Drop stale entries whose referenced fact is no longer present.
        const refTs = o.stalledFactTs;
        const factStillPresent = entries.some(
          (x) => x.obj && x.obj.event === 'fact' && x.obj.ts === refTs,
        );
        if (!factStillPresent) {
          archiveLines.push(e.raw);
          expired++;
        } else {
          retainedNonFact.push(e);
        }
        continue;
      }
      if (o.event === 'fact') {
        // Already-staled facts are archived (superseded).
        if (typeof o.ts === 'number' && staledTs.has(o.ts)) {
          archiveLines.push(e.raw);
          expired++;
          continue;
        }
        const conf = typeof o.confidence === 'number' ? o.confidence : 1;
        const ts = typeof o.ts === 'number' ? o.ts : now;
        if (conf < minConfidence || ts < expiryCutoff) {
          archiveLines.push(e.raw);
          expired++;
          continue;
        }
        activeFacts.push(e);
        continue;
      }
      // Any other entry type (pointer_summary, lock_timeout, etc.) is retained.
      retainedNonFact.push(e);
    }

    // --- Summarisation pass ---
    /** @type {PointerSummary[]} */
    const summaries = [];
    let summarised = 0;
    if (activeFacts.length > targetEntries) {
      // Oldest first.
      const sorted = [...activeFacts].sort(
        (a, b) => (a.obj.ts ?? 0) - (b.obj.ts ?? 0),
      );
      const toSummariseCount = activeFacts.length - targetEntries;
      const toSummarise = sorted.slice(0, toSummariseCount);
      const keep = sorted.slice(toSummariseCount);

      const groups = groupByDirPrefix(toSummarise);
      // @bounded-alloc — one Set pair per directory-prefix group of the ledger
      // slice being compacted; group count is bounded by toSummariseCount.
      for (const [prefix, facts] of groups) {
        /** @type {Set<string>} */
        const sources = new Set();
        /** @type {Set<string>} */
        const tags = new Set();
        for (const f of facts) {
          if (typeof f.obj.source === 'string') sources.add(f.obj.source);
          if (Array.isArray(f.obj.tags)) {
            for (const t of f.obj.tags) tags.add(String(t));
          }
          archiveLines.push(f.raw);
        }
        const sourceList = [...sources];
        let summary = `${facts.length} facts under ${prefix}/ (${sourceList
          .slice(0, 5)
          .join(', ')}${sourceList.length > 5 ? ', …' : ''})`;
        if (summary.length > 256) summary = summary.slice(0, 256);
        summaries.push({
          event: 'pointer_summary',
          sources: sourceList,
          summary,
          tags: [...tags],
          compactedCount: facts.length,
          ts: now,
          archivePath,
        });
        summarised += facts.length;
      }
      // Rebuild active fact set as the kept ones only.
      activeFacts.length = 0;
      for (const k of keep) activeFacts.push(k);
    }

    // --- Assemble retained set ---
    /** @type {string[]} */
    const retainedLines = [];
    for (const e of retainedNonFact) retainedLines.push(e.raw);
    for (const f of activeFacts) retainedLines.push(f.raw);
    for (const s of summaries) retainedLines.push(JSON.stringify(s));

    // Archive first (durable audit trail before mutating the ledger).
    await appendArchive(archivePath, archiveLines);

    // --- Atomic rewrite ---
    const tmpPath = ledgerPath + '.compacting';
    const body = retainedLines.length ? retainedLines.join('\n') + '\n' : '';
    await writeTextFile(tmpPath, body);
    const bytesAfter = Buffer.byteLength(body, 'utf8');
    const entriesAfter = retainedLines.length;

    const rename = opts.rename ?? renamePath;
    try {
      await rename(tmpPath, ledgerPath);
    } catch (/** @type {unknown} */ err) {
      // Clean up temp; leave original untouched.
      await removeFile(tmpPath).catch(() => {});
      throw err;
    }

    return {
      ok: true,
      entriesBefore,
      entriesAfter,
      bytesBefore,
      bytesAfter,
      expired,
      summarised,
      archivePath,
    };
  } finally {
    await releaseLock(handle);
  }
}
