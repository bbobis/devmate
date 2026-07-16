// @ts-check
import { dirname } from 'node:path';
import {
  ensureDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { collectActiveFacts } from './active-facts.mjs';

/** @typedef {import('../types.mjs').FactEntry} FactEntry */

const FACTS_START = '<!-- devmate:facts:start -->';
const FACTS_END = '<!-- devmate:facts:end -->';

/**
 * Soft line cap for the rendered MEMORY.md. Tools that auto-load memory at
 * startup typically only read the first ~200 lines, so growth past this is a
 * signal that memory needs compaction — surfaced (event: memory.render.oversize)
 * rather than silently clipped. Not a hard limit: rendering still writes every
 * active fact.
 * @type {number}
 */
export const MEMORY_MD_SOFT_LINE_CAP = 200;

/**
 * @typedef {Object} RenderResult
 * @property {boolean} ok
 * @property {number} [factsRendered]
 * @property {string} [memoryPath]
 * @property {number} [lineCount]  Total lines in the rendered file.
 * @property {boolean} [oversize]  True when lineCount exceeds the soft cap.
 * @property {string} [error]
 */

/**
 * @param {string} path
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readJsonl(path) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(path);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  if (raw.trim().length === 0) return [];
  /** @type {Record<string, unknown>[]} */
  const entries = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      entries.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // Ignore malformed historical lines.
    }
  }
  return entries;
}

/**
 * @param {FactEntry[]} activeFacts
 * @returns {{ body: string, count: number }}
 */
function renderFactsBody(activeFacts) {
  /** @type {Map<string, FactEntry[]>} */
  const bySource = new Map();
  for (const fact of activeFacts) {
    if (!bySource.has(fact.source)) bySource.set(fact.source, []);
    bySource.get(fact.source)?.push(fact);
  }

  const sources = Array.from(bySource.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  /** @type {string[]} */
  const lines = [];
  let count = 0;

  for (const source of sources) {
    lines.push(`## ${source}`);
    const facts = bySource.get(source) ?? [];
    facts.sort((a, b) => a.ts - b.ts);
    for (const fact of facts) {
      const rec = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (fact)
      );
      const taskId =
        typeof rec['taskId'] === 'string' && rec['taskId'].length > 0
          ? rec['taskId']
          : 'unknown';
      const added = new Date(fact.ts).toISOString();
      lines.push(`- ${fact.summary} (task: ${taskId}, added: ${added})`);
      count += 1;
    }
    lines.push('');
  }

  return { body: lines.join('\n').trimEnd(), count };
}

/**
 * @param {string} existing
 * @param {string} renderedBody
 * @returns {string}
 */
function injectFacts(existing, renderedBody) {
  const startIdx = existing.indexOf(FACTS_START);
  const endIdx = existing.indexOf(FACTS_END);
  const bodyWithTrailingNewline =
    renderedBody.length > 0 ? `${renderedBody}\n` : '';

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    const before = existing.slice(0, startIdx + FACTS_START.length);
    const after = existing.slice(endIdx);
    return `${before}\n${bodyWithTrailingNewline}${after}`;
  }

  const trimmed = existing.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  return `${prefix}${FACTS_START}\n${bodyWithTrailingNewline}${FACTS_END}\n`;
}

/**
 * @param {string} repoLedgerPath
 * @param {string} memoryPath
 * @returns {Promise<RenderResult>}
 */
export async function renderMemory(repoLedgerPath, memoryPath) {
  try {
    const entries = await readJsonl(repoLedgerPath);
    const { active } = collectActiveFacts(entries);
    const rendered = renderFactsBody(active);

    let existing = '';
    try {
      existing = await readTextFile(memoryPath);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') throw err;
    }

    const next = injectFacts(existing, rendered.body);
    const tempPath = `${memoryPath}.tmp`;
    await ensureDir(dirname(memoryPath));
    await writeTextFile(tempPath, next);
    await renamePath(tempPath, memoryPath);

    // Growth guard: surface (never clip) when .devmate/MEMORY.md passes the soft cap the
    // startup auto-loader would truncate at, so it can be compacted in time.
    const lineCount = next.split('\n').length;
    const oversize = lineCount > MEMORY_MD_SOFT_LINE_CAP;
    if (oversize) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'memory.render.oversize',
          lines: lineCount,
          cap: MEMORY_MD_SOFT_LINE_CAP,
          memoryPath,
        })}\n`,
      );
    }

    return {
      ok: true,
      factsRendered: rendered.count,
      memoryPath,
      lineCount,
      oversize,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}