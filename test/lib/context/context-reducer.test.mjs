// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mapChunks,
  reduceChunk,
  mergeChunks,
  reduceEvidencePack,
} from '../../../lib/context/context-reducer.mjs';

/**
 * Build an EvidencePointer with sensible defaults.
 * @param {Partial<import('../../../lib/types.mjs').EvidencePointer>} over
 * @returns {import('../../../lib/types.mjs').EvidencePointer}
 */
function ptr(over) {
  return {
    path: 'src/a.js',
    lineRange: null,
    reason: 'relevant',
    confidence: 0.5,
    freshness: '2026-06-24T00:00:00.000Z',
    kind: 'file',
    ...over,
  };
}

/**
 * Build an EvidencePack with n pointers.
 * @param {number} n
 * @param {number} maxSources
 * @returns {import('../../../lib/types.mjs').EvidencePack}
 */
function pack(n, maxSources) {
  /** @type {import('../../../lib/types.mjs').EvidencePointer[]} */
  const pointers = [];
  for (let i = 0; i < n; i += 1) pointers.push(ptr({ path: `src/f${i}.js` }));
  return {
    taskId: 't1',
    stage: 'discovery',
    pointers,
    maxSources,
    created_at: '2026-06-24T00:00:00.000Z',
  };
}

test('mapChunks / splits 13 pointers into [5,5,3] with chunkSize=5', () => {
  const chunks = mapChunks(pack(13, 100), 5);
  assert.deepEqual(chunks.map((c) => c.length), [5, 5, 3]);
});

test('mapChunks / handles empty pointer list', () => {
  const chunks = mapChunks(pack(0, 5), 5);
  assert.deepEqual(chunks, []);
});

test('reduceChunk / includes sourcePointers in output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  const fp = path.join(dir, 'a.txt');
  await fsp.writeFile(fp, 'Hello world. Second sentence.');
  const chunk = [ptr({ path: fp })];
  const summary = await reduceChunk(chunk, 0);
  assert.equal(summary.chunkIndex, 0);
  assert.deepEqual(summary.sourcePointers, chunk);
  assert.ok(summary.sourcePointers.length > 0);
});

test('reduceChunk / handles SliceReadError gracefully (marks unreadable, continues)', async () => {
  const chunk = [
    ptr({ path: '/no/such/file-xyz.txt' }),
  ];
  const summary = await reduceChunk(chunk, 0);
  assert.deepEqual(summary.sourcePointers, chunk);
  assert.ok(
    summary.preservedFacts.some((f) => f.startsWith('[SLICE_UNREADABLE]')),
    'unreadable slice should be marked, not thrown',
  );
});

test('mergeChunks / deduplicates allPointers across chunks', () => {
  const shared = ptr({ path: 'src/shared.js', lineRange: [1, 2] });
  /** @type {import('../../../lib/types.mjs').ChunkSummary[]} */
  const summaries = [
    { chunkIndex: 0, summary: 'a', sourcePointers: [shared], preservedFacts: [] },
    { chunkIndex: 1, summary: 'b', sourcePointers: [shared, ptr({ path: 'src/x.js' })], preservedFacts: [] },
  ];
  const reduced = mergeChunks(summaries, { taskId: 't1', stage: 'discovery', originalCount: 3 });
  assert.equal(reduced.allPointers.length, 2);
});

test('mergeChunks / truncates mergeSummary to 800 chars', () => {
  const long = 'x'.repeat(500);
  /** @type {import('../../../lib/types.mjs').ChunkSummary[]} */
  const summaries = [
    { chunkIndex: 0, summary: long, sourcePointers: [ptr({})], preservedFacts: [] },
    { chunkIndex: 1, summary: long, sourcePointers: [ptr({})], preservedFacts: [] },
  ];
  const reduced = mergeChunks(summaries, { taskId: 't1', stage: 'discovery', originalCount: 2 });
  assert.ok(reduced.mergeSummary.length <= 800);
});

test('reduceEvidencePack / returns null when pointers within maxSources', async () => {
  const result = await reduceEvidencePack(pack(3, 5));
  assert.equal(result, null);
});

test('reduceEvidencePack / critical fact survival — key phrase appears in preservedFacts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-survival-'));
  const KEY = 'CRITICAL_AUTH_BYPASS_CVE_2026_0001';
  /** @type {import('../../../lib/types.mjs').EvidencePointer[]} */
  const pointers = [];
  // @bounded-alloc — writes 12 fixture files.
  for (let i = 0; i < 12; i += 1) {
    const fp = path.join(dir, `f${i}.txt`);
    const body = i === 7
      ? `${KEY} is the exploit. More detail follows here.`
      : `Filler fact number ${i}. Nothing important here.`;
    await fsp.writeFile(fp, body);
    pointers.push(ptr({ path: fp }));
  }
  /** @type {import('../../../lib/types.mjs').EvidencePack} */
  const p = {
    taskId: 't1',
    stage: 'discovery',
    pointers,
    maxSources: 5,
    created_at: '2026-06-24T00:00:00.000Z',
  };
  const reduced = await reduceEvidencePack(p);
  assert.ok(reduced, 'should reduce a 12-pointer pack over maxSources=5');
  const allFacts = reduced.chunks.flatMap((c) => c.preservedFacts).join(' ');
  assert.ok(allFacts.includes(KEY), 'critical phrase must survive reduction');
});
