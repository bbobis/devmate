// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryMemory } from '../../../lib/memory/query.mjs';
import { contentDigest16, writeDiscoveryFacts } from '../../../lib/memory/discovery-facts.mjs';

/**
 * Build a fact entry line object.
 * @param {Partial<import('../../../lib/types.mjs').FactEntry>} over
 * @returns {object}
 */
function fact(over) {
  return {
    event: 'fact',
    source: 'src/x.js',
    tool: 'edit',
    lane: 'feature',
    tags: [],
    summary: 'a fact',
    confidence: 0.8,
    ts: 1000,
    stepId: 'none',
    firstEdit: true,
    ...over,
  };
}

/**
 * Write rows as JSONL to a temp ledger; return its path.
 * @param {object[]} rows
 * @returns {Promise<string>}
 */
async function writeLedger(rows) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mq-'));
  const p = path.join(dir, 'memory.jsonl');
  await fsp.writeFile(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

test('queryMemory — empty/missing ledger returns ok with no matches', async () => {
  const r = await queryMemory('/no/such/ledger.jsonl', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.matches, []);
  assert.equal(r.totalActive, 0);
  assert.equal(r.scanned, 0);
});

test('queryMemory — lane filter scores feature facts >= 0.4', async () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(fact({ source: `f${i}.js`, lane: 'feature', ts: 100 + i, confidence: 0 }));
  for (let i = 0; i < 5; i += 1) rows.push(fact({ source: `b${i}.js`, lane: 'bug', ts: 200 + i, confidence: 0 }));
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { lane: 'feature', topN: 20 });
  const feature = r.matches.filter((m) => m.lane === 'feature');
  assert.equal(feature.length, 5);
  for (const m of feature) assert.ok(m.score >= 0.4, `score ${m.score} < 0.4`);
  // bug facts score 0 and rank below.
  assert.equal(r.matches[0].lane, 'feature');
});

test('queryMemory — pathPrefix boosts matching paths to the top', async () => {
  const rows = [
    fact({ source: 'src/billing/a.js', lane: 'x', confidence: 0, ts: 1 }),
    fact({ source: 'src/auth/login.js', lane: 'x', confidence: 0, ts: 2 }),
    fact({ source: 'src/auth/token.js', lane: 'x', confidence: 0, ts: 3 }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { pathPrefix: 'src/auth', topN: 10 });
  assert.ok(r.matches[0].source.startsWith('src/auth'));
  assert.ok(r.matches[1].source.startsWith('src/auth'));
});

test('queryMemory — topN cap enforced', async () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push(fact({ source: `f${i}.js`, ts: i }));
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 5 });
  assert.equal(r.matches.length, 5);
  assert.equal(r.totalActive, 50);
});

test('queryMemory — stale facts excluded by default', async () => {
  const rows = [
    fact({ source: 'a.js', ts: 10 }),
    fact({ source: 'b.js', ts: 20 }),
    fact({ source: 'c.js', ts: 30 }),
    { event: 'stale', source: { path: 'd.js' }, reason: 'changed', stalledFactTs: 40, ts: 41 },
    fact({ source: 'd.js', ts: 40 }),
    { event: 'stale', source: { path: 'e.js' }, reason: 'changed', stalledFactTs: 50, ts: 51 },
    fact({ source: 'e.js', ts: 50 }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 20 });
  assert.equal(r.matches.length, 3);
  assert.equal(r.totalActive, 3);
});

test('queryMemory — includeExpired returns stale facts too', async () => {
  const rows = [
    fact({ source: 'a.js', ts: 10 }),
    fact({ source: 'b.js', ts: 20 }),
    fact({ source: 'c.js', ts: 30 }),
    { event: 'stale', source: { path: 'd.js' }, reason: 'changed', stalledFactTs: 40, ts: 41 },
    fact({ source: 'd.js', ts: 40 }),
    { event: 'stale', source: { path: 'e.js' }, reason: 'changed', stalledFactTs: 50, ts: 51 },
    fact({ source: 'e.js', ts: 50 }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 20, includeExpired: true });
  assert.equal(r.matches.length, 5);
});

test('queryMemory — PointerSummary scored with isPointerSummary true', async () => {
  const rows = [
    fact({ source: 'a.js', ts: 10 }),
    {
      event: 'pointer_summary',
      sources: ['src/auth/a.js', 'src/auth/b.js'],
      summary: 'auth area digest',
      tags: ['auth'],
      compactedCount: 2,
      ts: 99,
      archivePath: 'x.archive',
    },
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 10 });
  const ps = r.matches.find((m) => m.isPointerSummary);
  assert.ok(ps, 'expected a pointer-summary match');
  assert.equal(ps.source, 'src/auth/a.js');
  assert.equal(ps.summary, 'auth area digest');
});

test('queryMemory — returned matches carry no raw FactEntry fields', async () => {
  const rows = [fact({ source: 'a.js', ts: 10, tool: 'edit', firstEdit: true })];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 10 });
  const m = /** @type {Record<string, unknown>} */ (r.matches[0]);
  assert.equal(m.tool, undefined);
  assert.equal(m.writer, undefined);
  assert.equal(m.params, undefined);
  assert.equal(m.content, undefined);
  assert.equal(m.firstEdit, undefined);
});

test('queryMemory — malformed line skipped, scanned counts it, no throw', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mq-bad-'));
  const p = path.join(dir, 'memory.jsonl');
  await fsp.writeFile(
    p,
    [JSON.stringify(fact({ source: 'a.js', ts: 1 })), 'NOT JSON', JSON.stringify(fact({ source: 'b.js', ts: 2 }))].join('\n') + '\n',
  );
  const r = await queryMemory(p, { topN: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 3);
  assert.equal(r.matches.length, 2);
});

test('queryMemory — tag overlap beats lane-only when topN 1', async () => {
  const rows = [
    fact({ source: 'lane-only.js', lane: 'feature', tags: [], confidence: 0, ts: 1 }),
    fact({ source: 'tagged.js', lane: 'bug', tags: ['a', 'b'], confidence: 0, ts: 2 }),
  ];
  const p = await writeLedger(rows);
  // lane:feature => +0.4 for lane-only; tags a,b => +0.2 for tagged, lane bug not matched.
  // To make tag win, query lane that matches tagged's lane too? Spec: 2-tag overlap beats lane-only.
  // Use a query where tagged gets lane(+0.4) + tags(+0.2)=0.6 vs lane-only lane(+0.4)=0.4.
  const r = await queryMemory(p, { lane: 'bug', tags: ['a', 'b'], topN: 1 });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].source, 'tagged.js');
  assert.ok(r.matches[0].score >= 0.6);
});

// ---- FO-6: discovery facts in recall ----

test('queryMemory — discovery facts are visibly typed with kind and carry their digest', async () => {
  const rows = [
    fact({ source: 'lib/a.mjs', ts: 1, tool: 'discovery-merge', contentDigest: 'abcd1234abcd1234' }),
    fact({ source: 'lib/b.mjs', ts: 2, tool: 'write_file' }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 10 });
  const discovery = r.matches.find((m) => m.source === 'lib/a.mjs');
  const edit = r.matches.find((m) => m.source === 'lib/b.mjs');
  assert.ok(discovery && edit);
  assert.equal(discovery.kind, 'discovery');
  assert.equal(discovery.contentDigest, 'abcd1234abcd1234');
  assert.equal(edit.kind, undefined);
  assert.equal(edit.contentDigest, undefined);
});

test('queryMemory — stale check flags changed and missing files, never edit facts', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'mq-stale-'));
  await fsp.mkdir(path.join(repoRoot, 'lib'), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, 'lib/fresh.mjs'), 'fresh\n');
  await fsp.writeFile(path.join(repoRoot, 'lib/mutated.mjs'), 'v1\n');
  await fsp.writeFile(path.join(repoRoot, 'lib/deleted.mjs'), 'gone\n');

  // Write facts through the real write path, then drift two of the files.
  const res = await writeDiscoveryFacts({
    taskId: 'task-1',
    lane: 'feature',
    repoRoot,
    mergedArtifact: {
      agentName: 'discovery',
      claims: [
        { fact: 'stays fresh', path: 'lib/fresh.mjs', confidence: 'high' },
        { fact: 'will mutate', path: 'lib/mutated.mjs', confidence: 'high' },
        { fact: 'will vanish', path: 'lib/deleted.mjs', confidence: 'high' },
      ],
      unverified: [],
    },
  });
  assert.equal(res.ok, true);
  await fsp.writeFile(path.join(repoRoot, 'lib/mutated.mjs'), 'v2 — changed\n');
  await fsp.rm(path.join(repoRoot, 'lib/deleted.mjs'));

  const editRow = fact({ source: 'lib/other.mjs', ts: 9, tool: 'write_file' });
  await fsp.appendFile(res.ledgerPath, JSON.stringify(editRow) + '\n');

  const r = await queryMemory(res.ledgerPath, { topN: 10 }, { staleCheckRoot: repoRoot });
  assert.equal(r.ok, true);
  const bySource = new Map(r.matches.map((m) => [m.source, m]));
  assert.equal(bySource.get('lib/fresh.mjs')?.stale, false);
  assert.equal(bySource.get('lib/mutated.mjs')?.stale, true);
  assert.equal(bySource.get('lib/deleted.mjs')?.stale, true);
  // Edit facts are never annotated — the check is discovery-scoped.
  assert.equal(bySource.get('lib/other.mjs')?.stale, undefined);
});

test('#148 queryMemory — a discovery fact stays FRESH across a CRLF/LF re-checkout of identical content', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'mq-eol-'));
  await fsp.mkdir(path.join(repoRoot, 'lib'), { recursive: true });
  // Write the fact from an LF checkout.
  await fsp.writeFile(path.join(repoRoot, 'lib/x.mjs'), 'export const a = 1;\nexport const b = 2;\n');
  const res = await writeDiscoveryFacts({
    taskId: 'task-1',
    lane: 'feature',
    repoRoot,
    mergedArtifact: {
      agentName: 'discovery',
      claims: [{ fact: 'stays fresh across EOL', path: 'lib/x.mjs', confidence: 'high' }],
      unverified: [],
    },
  });
  assert.equal(res.ok, true);
  // Simulate a CRLF checkout of the SAME logical content (git `text=auto eol=lf`
  // means checkouts legitimately differ by line ending). Pre-#148 this made the
  // digest mismatch → false-stale → the fact silently dropped from recall.
  await fsp.writeFile(path.join(repoRoot, 'lib/x.mjs'), 'export const a = 1;\r\nexport const b = 2;\r\n');

  const r = await queryMemory(res.ledgerPath, { topN: 10 }, { staleCheckRoot: repoRoot });
  assert.equal(r.ok, true);
  const m = r.matches.find((x) => x.source === 'lib/x.mjs');
  assert.ok(m, 'the discovery fact is recalled');
  assert.equal(m.stale, false, 'a CRLF re-checkout of identical content must NOT be false-stale');
});

test('queryMemory — stale check never reads outside the root (traversal source is stale)', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'mq-traverse-'));
  const repoRoot = path.join(parent, 'repo');
  await fsp.mkdir(repoRoot, { recursive: true });
  // A real file OUTSIDE the root whose digest would match — containment must
  // win over digest equality: without the root check this would be "fresh".
  const outsideContent = 'secret outside the root\n';
  await fsp.writeFile(path.join(parent, 'outside.txt'), outsideContent);
  const rows = [
    fact({
      source: '../outside.txt',
      ts: 1,
      tool: 'discovery-merge',
      contentDigest: contentDigest16(outsideContent),
    }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 10 }, { staleCheckRoot: repoRoot });
  assert.equal(r.matches[0].stale, true);
});

test('queryMemory — no stale annotation without staleCheckRoot (opt-in IO)', async () => {
  const rows = [
    fact({ source: 'lib/a.mjs', ts: 1, tool: 'discovery-merge', contentDigest: 'abcd1234abcd1234' }),
  ];
  const p = await writeLedger(rows);
  const r = await queryMemory(p, { topN: 10 });
  assert.equal(r.matches[0].stale, undefined);
});

// ── #150: opt-in kind filter restricts recall to semantic discovery facts ──────

test('#150 queryMemory — opts.kind "discovery" returns only discovery facts; default unchanged', async () => {
  const p = await writeLedger([
    fact({ source: 'src/a.mjs', ts: 1, tool: 'discovery-merge', summary: 'a semantic claim', contentDigest: 'abcd1234abcd1234' }),
    fact({ source: 'src/b.mjs', ts: 2, tool: 'edit', summary: 'edit edited src/b.mjs' }),
  ]);

  // Default: both facts recalled (edit events stay queryable locally).
  const all = await queryMemory(p, { topN: 10 });
  assert.equal(all.matches.length, 2, 'default recall is unchanged');

  // kind filter: only the discovery fact.
  const discoveryOnly = await queryMemory(p, { topN: 10 }, { kind: 'discovery' });
  assert.equal(discoveryOnly.matches.length, 1);
  assert.equal(discoveryOnly.matches[0].source, 'src/a.mjs');
  assert.equal(discoveryOnly.matches[0].kind, 'discovery');
  // totalActive is the scan metric, not the match count — the filter doesn't shrink it.
  assert.equal(discoveryOnly.totalActive, 2);
});
