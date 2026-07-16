// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl } from '../../../lib/json-io.mjs';
import { shouldCompact, compactLedger } from '../../../lib/memory/compact.mjs';
import { getLedgerStats } from '../../../lib/memory/ledger-stats.mjs';
import { appendJsonl } from '../../../lib/memory/append-jsonl.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {Promise<string>} */
async function mkTmpDir() {
  return fsp.mkdtemp(join(tmpdir(), 'compact-test-'));
}

/**
 * @param {number} i
 * @param {Partial<{ source: string, confidence: number, ts: number, tags: string[] }>} [over]
 */
function fact(i, over = {}) {
  return {
    event: 'fact',
    source: over.source ?? `src/mod${i % 4}/file${i}.mjs`,
    tool: 'edit',
    lane: 'unknown',
    tags: over.tags ?? ['.mjs'],
    summary: `fact ${i}`,
    confidence: over.confidence ?? 0.9,
    ts: over.ts ?? Date.now(),
    stepId: 'none',
    firstEdit: false,
  };
}

/**
 * @param {string} path
 * @param {object[]} entries
 */
async function writeLedger(path, entries) {
  await fsp.writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

/**
 * @param {string} path
 * @returns {Promise<any[]>}
 */
async function readLedger(path) {
  const content = await fsp.readFile(path, 'utf8');
  return parseJsonl(content);
}

test('shouldCompact — under caps returns false', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  await writeLedger(ledger, Array.from({ length: 50 }, (_, i) => fact(i)));
  assert.equal(await shouldCompact(ledger, { maxEntries: 200 }), false);
});

test('shouldCompact — over entry cap returns true', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  await writeLedger(ledger, Array.from({ length: 250 }, (_, i) => fact(i)));
  assert.equal(await shouldCompact(ledger, { maxEntries: 200 }), true);
});

test('shouldCompact — over byte cap returns true', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  // ~50 facts, each well over 50 bytes; cap at 100 bytes -> true.
  await writeLedger(ledger, Array.from({ length: 50 }, (_, i) => fact(i)));
  assert.equal(await shouldCompact(ledger, { maxEntries: 999999, maxBytes: 100 }), true);
});

test('compactLedger — expiry by low confidence', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  const entries = Array.from({ length: 5 }, (_, i) => fact(i, { confidence: 0.1 }));
  await writeLedger(ledger, entries);
  const res = await compactLedger(ledger, { targetEntries: 80 });
  assert.equal(res.ok, true);
  assert.equal(res.expired, 5);
  const archived = await readLedger(res.archivePath);
  assert.equal(archived.length, 5);
  const remaining = await readLedger(ledger);
  assert.equal(remaining.length, 0);
});

test('compactLedger — expiry by age', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  const old = Date.now() - 100 * DAY_MS;
  const entries = Array.from({ length: 3 }, (_, i) => fact(i, { ts: old }));
  await writeLedger(ledger, entries);
  const res = await compactLedger(ledger, { targetEntries: 80, expiryAgeDays: 90 });
  assert.equal(res.expired, 3);
  const remaining = await readLedger(ledger);
  assert.equal(remaining.length, 0);
});

test('compactLedger — summarisation', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  const entries = Array.from({ length: 100 }, (_, i) => fact(i));
  await writeLedger(ledger, entries);
  const res = await compactLedger(ledger, { targetEntries: 10 });
  assert.equal(res.ok, true);
  assert.ok(res.summarised >= 90, `expected >=90 summarised, got ${res.summarised}`);
  const remaining = await readLedger(ledger);
  const summaries = remaining.filter((e) => e.event === 'pointer_summary');
  const facts = remaining.filter((e) => e.event === 'fact');
  assert.ok(facts.length <= 10, `expected <=10 active facts, got ${facts.length}`);
  assert.ok(remaining.length <= 10 + summaries.length);
  // Pointer summaries list their sources and archive path.
  for (const s of summaries) {
    assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
    assert.equal(typeof s.archivePath, 'string');
    assert.ok(s.summary.length <= 256);
  }
});

test('compactLedger — archive grows across runs (never truncated)', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  // Run 1: expire 5 low-confidence facts.
  await writeLedger(ledger, Array.from({ length: 5 }, (_, i) => fact(i, { confidence: 0.1 })));
  const r1 = await compactLedger(ledger, {});
  const after1 = (await readLedger(r1.archivePath)).length;
  assert.equal(after1, 5);
  // Run 2: add 3 more low-confidence facts, compact again (same UTC day -> same archive file).
  await writeLedger(ledger, Array.from({ length: 3 }, (_, i) => fact(i + 100, { confidence: 0.1 })));
  const r2 = await compactLedger(ledger, {});
  assert.equal(r1.archivePath, r2.archivePath);
  const after2 = (await readLedger(r2.archivePath)).length;
  assert.equal(after2, 8, 'archive must accumulate, not truncate');
});

test('compactLedger — already compact is a no-op', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  await writeLedger(ledger, Array.from({ length: 5 }, (_, i) => fact(i)));
  const res = await compactLedger(ledger, { targetEntries: 80 });
  assert.equal(res.ok, true);
  assert.equal(res.summarised, 0);
  assert.equal(res.expired, 0);
  const remaining = await readLedger(ledger);
  assert.equal(remaining.length, 5);
});

test('compactLedger — atomic rewrite leaves original intact on rename failure', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  const entries = Array.from({ length: 5 }, (_, i) => fact(i, { confidence: 0.1 }));
  await writeLedger(ledger, entries);
  const before = await readLedger(ledger);
  await assert.rejects(
    compactLedger(ledger, {
      rename: async () => {
        throw new Error('boom');
      },
    }),
    /boom/,
  );
  // Original ledger unchanged.
  const after = await readLedger(ledger);
  assert.deepEqual(after, before);
  // No leftover temp file.
  await assert.rejects(fsp.stat(ledger + '.compacting'), /ENOENT/);
});

test('appendJsonl — auto-compaction fires at cap', async () => {
  const dir = await mkTmpDir();
  const ledger = join(dir, 'm.jsonl');
  // 201 appends with maxEntries 200, targetEntries 80.
  for (let i = 0; i < 201; i++) {
    await appendJsonl(ledger, fact(i), {
      compact: { maxEntries: 200, targetEntries: 80 },
    });
  }
  const stats = await getLedgerStats(ledger);
  assert.ok(stats.activeCount <= 80, `expected <=80 active facts, got ${stats.activeCount}`);
});
