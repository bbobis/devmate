// @ts-check
/**
 * E8-2: read/write the `docs/CONTEXT.md` glossary ledger.
 *
 * The ledger stores its data in a JSON frontmatter fence delimited by lines of
 * exactly `---`. We use JSON (not YAML) so no third-party parser is needed and
 * arrays/optional fields round-trip losslessly.
 *
 * Safety: a malformed ledger throws on load and is NEVER overwritten as a side
 * effect of reading (the caller decides whether to repair it).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, readTextFile, writeTextFile } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').GlossaryEntry} GlossaryEntry */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default ledger path: <repo>/docs/CONTEXT.md. @type {string} */
export const DEFAULT_CONTEXT_PATH = resolve(__dirname, '../../docs/CONTEXT.md');

const SCHEMA_VERSION = 1;

/**
 * Extract the JSON object from the first `---` … `---` frontmatter fence.
 * @param {string} text
 * @returns {{ schemaVersion: number, entries: GlossaryEntry[] }}
 */
function parseFrontmatter(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim() === '---');
  if (first === -1) throw new Error('CONTEXT.md: no frontmatter fence found');
  const second = lines.findIndex((l, i) => i > first && l.trim() === '---');
  if (second === -1) throw new Error('CONTEXT.md: unterminated frontmatter fence');

  const body = lines.slice(first + 1, second).join('\n').trim();
  /** @type {unknown} */
  let parsed;
  try {
    // eslint-disable-next-line secure-coding/no-xxe-injection -- parsing JSON frontmatter, not XML.
    parsed = JSON.parse(body);
  } catch (/** @type {unknown} */ err) {
    throw new Error(`CONTEXT.md: malformed JSON frontmatter: ${/** @type {Error} */ (err).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(/** @type {Record<string, unknown>} */ (parsed)['entries'])) {
    throw new Error('CONTEXT.md: frontmatter must be an object with an "entries" array');
  }
  const obj = /** @type {{ schemaVersion?: number, entries: GlossaryEntry[] }} */ (parsed);
  return { schemaVersion: obj.schemaVersion ?? SCHEMA_VERSION, entries: obj.entries };
}

/**
 * Load all glossary entries from the ledger. Throws (without modifying the file)
 * when the ledger is malformed.
 * @param {string} [contextPath]
 * @returns {Promise<GlossaryEntry[]>}
 */
export async function loadGlossary(contextPath = DEFAULT_CONTEXT_PATH) {
  const text = await readTextFile(contextPath);
  return parseFrontmatter(text).entries;
}

/**
 * Render a human-readable markdown table for the entries.
 * @param {GlossaryEntry[]} entries
 * @returns {string}
 */
function renderTable(entries) {
  const header = '| Term | Definition | Source files | Status |\n| --- | --- | --- | --- |';
  const rows = entries.map((e) => {
    const files = e.sourceFiles.map((f) => `\`${f}\``).join(', ');
    const status = e.staleReason ? `STALE: ${e.staleReason}` : 'fresh';
    return `| ${e.term} | ${e.definition} | ${files} | ${status} |`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Serialize entries back to the `docs/CONTEXT.md` frontmatter format.
 * @param {GlossaryEntry[]} entries
 * @param {string} [contextPath]
 * @returns {Promise<void>}
 */
export async function saveGlossary(entries, contextPath = DEFAULT_CONTEXT_PATH) {
  const frontmatter = JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }, null, 2);
  const text = [
    '<!--',
    '  devmate glossary ledger (E8-2). Edit via lib/memory/context-ledger.mjs.',
    '  Frontmatter is a JSON object: { schemaVersion, entries: GlossaryEntry[] }.',
    '-->',
    '',
    '---',
    frontmatter,
    '---',
    '',
    '## Glossary (human-readable view)',
    '',
    renderTable(entries),
    '',
  ].join('\n');
  await ensureDir(dirname(contextPath));
  await writeTextFile(contextPath, text);
}
