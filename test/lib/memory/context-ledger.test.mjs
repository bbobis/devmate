// @ts-check
/**
 * E8-2: tests for the docs/CONTEXT.md glossary ledger reader/writer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlossary, saveGlossary } from '../../../lib/memory/context-ledger.mjs';

/** @typedef {import('../../../lib/types.mjs').GlossaryEntry} GlossaryEntry */

/** @returns {Promise<string>} a temp CONTEXT.md path. */
async function tempPath() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'ctx-'));
  return join(dir, 'CONTEXT.md');
}

test('context-ledger › roundtrip save/load preserves all fields', async () => {
  const p = await tempPath();
  /** @type {GlossaryEntry[]} */
  const entries = [
    { term: 'TaskState', definition: 'core state', sourceFiles: ['lib/types.mjs'], updatedAt: '2026-06-24' },
    { term: 'Gone', definition: 'removed', sourceFiles: ['old.mjs'], updatedAt: '2026-06-24', staleReason: 'file not found' },
  ];
  await saveGlossary(entries, p);
  const loaded = await loadGlossary(p);
  assert.deepEqual(loaded, entries);
});

test('context-ledger › malformed frontmatter does not overwrite file', async () => {
  const p = await tempPath();
  const original = '---\n{ this is not json }\n---\n';
  await fsp.writeFile(p, original, 'utf8');
  await assert.rejects(() => loadGlossary(p), /malformed JSON/);
  // File must be untouched after the failed load.
  const after = await fsp.readFile(p, 'utf8');
  assert.equal(after, original);
});

test('context-ledger › empty glossary is loadable without error', async () => {
  const p = await tempPath();
  await saveGlossary([], p);
  const loaded = await loadGlossary(p);
  assert.deepEqual(loaded, []);
});
