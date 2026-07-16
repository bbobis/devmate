// @ts-check
/**
 * E8-2: advanced glossary retrieval + live validation.
 *
 * `queryGlossary` returns ONLY relevant entries (selective retrieval) so an
 * obsolete glossary is never injected wholesale (TCM-3). `validateGlossaryEntry`
 * checks an entry's source files against live repo state and marks it STALE when
 * a file is missing — preventing silent loading of renamed/removed concepts.
 *
 * Background: ws3-external-grounding.md:129-147 (glossaries as context schemas),
 * ws3-external-grounding.md:407 (validate assumptions against live evidence).
 */

import { resolve } from 'node:path';
import { statPath } from '../fs-safe.mjs';
import { loadGlossary } from './context-ledger.mjs';
import { markStale, isStale } from './glossary-stale.mjs';

/** @typedef {import('../types.mjs').GlossaryEntry} GlossaryEntry */
/** @typedef {import('../types.mjs').GlossaryQuery} GlossaryQuery */
/** @typedef {import('../types.mjs').GlossaryResult} GlossaryResult */

const DEFAULT_MAX_RESULTS = 5;

/**
 * Selectively retrieve glossary entries relevant to `query.text`. Stale entries
 * are excluded by default and counted in `staleSuppressed`. Never returns more
 * than `maxResults` entries.
 * @param {GlossaryQuery} query
 * @param {{ contextPath?: string }} [opts]
 * @returns {Promise<GlossaryResult>}
 */
export async function queryGlossary(query, opts = {}) {
  const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS;
  const excludeStale = query.excludeStale ?? true;
  const needle = (query.text ?? '').toLowerCase();

  const all = await loadGlossary(opts.contextPath);

  let staleSuppressed = 0;
  /** @type {GlossaryEntry[]} */
  const candidates = [];
  for (const entry of all) {
    if (excludeStale && isStale(entry)) {
      staleSuppressed += 1;
      continue;
    }
    candidates.push(entry);
  }

  // Relevance: case-insensitive substring match against term or definition.
  // An empty query matches everything (still capped by maxResults).
  const matched = candidates.filter((e) => {
    if (needle === '') return true;
    return (
      e.term.toLowerCase().includes(needle) ||
      e.definition.toLowerCase().includes(needle)
    );
  });

  return { entries: matched.slice(0, maxResults), staleSuppressed };
}

/**
 * Validate a single glossary entry against current repo files. If any
 * `sourceFiles` path is missing, the returned entry is marked STALE. `updatedAt`
 * is always refreshed to today's ISO date. Pure with respect to the input entry.
 * @param {GlossaryEntry} entry
 * @param {string} repoRoot  Absolute path to the repo root.
 * @returns {Promise<GlossaryEntry>}
 */
export async function validateGlossaryEntry(entry, repoRoot) {
  const today = new Date().toISOString().slice(0, 10);

  /** @type {string | null} */
  let missing = null;
  for (const rel of entry.sourceFiles) {
    try {
      await statPath(resolve(repoRoot, rel));
    } catch {
      missing = rel;
      break;
    }
  }

  if (missing !== null) {
    return { ...markStale(entry, `source file not found: ${missing}`), updatedAt: today };
  }
  // Fresh: drop any prior staleReason and refresh the timestamp.
  const { staleReason: _drop, ...rest } = entry;
  return { ...rest, updatedAt: today };
}
