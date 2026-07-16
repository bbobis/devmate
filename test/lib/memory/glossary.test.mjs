// @ts-check
/**
 * E8-2: tests for queryGlossary + validateGlossaryEntry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryGlossary, validateGlossaryEntry } from '../../../lib/memory/glossary.mjs';
import { saveGlossary } from '../../../lib/memory/context-ledger.mjs';

/** @typedef {import('../../../lib/types.mjs').GlossaryEntry} GlossaryEntry */

/**
 * @param {string} term
 * @param {Partial<GlossaryEntry>} [over]
 * @returns {GlossaryEntry}
 */
function entry(term, over = {}) {
  return {
    term,
    definition: `${term} definition`,
    sourceFiles: ['lib/types.mjs'],
    updatedAt: '2026-06-24',
    ...over,
  };
}

/**
 * Write a temp CONTEXT.md with the given entries; return its path.
 * @param {GlossaryEntry[]} entries
 * @returns {Promise<string>}
 */
async function tempContext(entries) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'glossary-'));
  const p = join(dir, 'CONTEXT.md');
  await saveGlossary(entries, p);
  return p;
}

test('glossary › empty glossary returns empty result', async () => {
  const contextPath = await tempContext([]);
  const res = await queryGlossary({ text: 'anything' }, { contextPath });
  assert.deepEqual(res.entries, []);
  assert.equal(res.staleSuppressed, 0);
});

test('glossary › stale entry excluded by default', async () => {
  const contextPath = await tempContext([entry('Foo', { staleReason: 'gone' })]);
  const res = await queryGlossary({ text: 'foo' }, { contextPath });
  assert.equal(res.entries.length, 0);
  assert.equal(res.staleSuppressed, 1);
});

test('glossary › stale entry included when excludeStale=false', async () => {
  const contextPath = await tempContext([entry('Foo', { staleReason: 'gone' })]);
  const res = await queryGlossary({ text: 'foo', excludeStale: false }, { contextPath });
  assert.equal(res.entries.length, 1);
  assert.equal(res.staleSuppressed, 0);
});

test('glossary › maxResults cap respected', async () => {
  const many = ['Alpha', 'Alphabet', 'Alpine', 'Alarm', 'Album', 'Alley'].map((t) => entry(t));
  const contextPath = await tempContext(many);
  const res = await queryGlossary({ text: 'al', maxResults: 2 }, { contextPath });
  assert.equal(res.entries.length, 2);
});

test('glossary › term substring match returns relevant entry', async () => {
  const contextPath = await tempContext([entry('TaskState'), entry('BudgetClass')]);
  const res = await queryGlossary({ text: 'budget' }, { contextPath });
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].term, 'BudgetClass');
});

test('validateGlossaryEntry › existing files → fresh entry', async () => {
  const repoRoot = await fsp.mkdtemp(join(tmpdir(), 'repo-'));
  await fsp.writeFile(join(repoRoot, 'exists.mjs'), '// file', 'utf8');
  const result = await validateGlossaryEntry(entry('Foo', { sourceFiles: ['exists.mjs'] }), repoRoot);
  assert.equal(result.staleReason, undefined);
});

test('validateGlossaryEntry › missing file → staleReason set', async () => {
  const repoRoot = await fsp.mkdtemp(join(tmpdir(), 'repo-'));
  const result = await validateGlossaryEntry(entry('Foo', { sourceFiles: ['nope.mjs'] }), repoRoot);
  assert.ok(result.staleReason);
  assert.match(result.staleReason ?? '', /nope\.mjs/);
});

test('validateGlossaryEntry › updatedAt is updated', async () => {
  const repoRoot = await fsp.mkdtemp(join(tmpdir(), 'repo-'));
  await fsp.writeFile(join(repoRoot, 'exists.mjs'), '// file', 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const result = await validateGlossaryEntry(
    entry('Foo', { sourceFiles: ['exists.mjs'], updatedAt: '2000-01-01' }),
    repoRoot
  );
  assert.equal(result.updatedAt, today);
});
