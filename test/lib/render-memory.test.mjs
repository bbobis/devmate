// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMemory } from '../../lib/memory/render-memory.mjs';

/**
 * @returns {{ root: string, repoLedger: string, memoryFile: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'render-memory-'));
  const repoLedger = join(root, '.devmate', 'state', 'repo', 'repo.jsonl');
  const memoryFile = join(root, '.devmate', 'MEMORY.md');
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  return {
    root,
    repoLedger,
    memoryFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {Array<Record<string, unknown>>} lines
 * @returns {string}
 */
function jsonl(lines) {
  return lines.map((x) => JSON.stringify(x)).join('\n') + '\n';
}

test('render-memory creates marker-bounded block when memory file does not exist', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact',
          key: 'src/auth.mjs:aaaa1111',
          source: 'src/auth.mjs',
          summary: 'auth baseline',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1000,
          stepId: '1',
          firstEdit: true,
          taskId: 'task-1',
        },
      ]),
      'utf8',
    );

    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.factsRendered, 1);
    assert.equal(existsSync(memoryFile), true);

    const out = readFileSync(memoryFile, 'utf8');
    assert.equal(out.includes('<!-- devmate:facts:start -->'), true);
    assert.equal(out.includes('## src/auth.mjs'), true);
    assert.equal(out.includes('auth baseline'), true);
  } finally {
    cleanup();
  }
});

test('render-memory groups by source and keeps distinct keys for same source', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact',
          key: 'src/auth.mjs:aaaa1111',
          source: 'src/auth.mjs',
          summary: 'jwt setup',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1000,
          stepId: '1',
          firstEdit: true,
          taskId: 'task-1',
        },
        {
          event: 'fact',
          key: 'src/auth.mjs:bbbb2222',
          source: 'src/auth.mjs',
          summary: 'refresh token update',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1001,
          stepId: '2',
          firstEdit: false,
          taskId: 'task-2',
        },
        {
          event: 'fact',
          key: 'src/cache.mjs:cccc3333',
          source: 'src/cache.mjs',
          summary: 'cache ttl tuned',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1002,
          stepId: '3',
          firstEdit: true,
          taskId: 'task-3',
        },
      ]),
      'utf8',
    );

    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.factsRendered, 3);

    const out = readFileSync(memoryFile, 'utf8');
    assert.equal(out.includes('## src/auth.mjs'), true);
    assert.equal(out.includes('jwt setup'), true);
    assert.equal(out.includes('refresh token update'), true);
    assert.equal(out.includes('## src/cache.mjs'), true);
  } finally {
    cleanup();
  }
});

test('render-memory excludes staled facts', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact',
          key: 'src/auth.mjs:aaaa1111',
          source: 'src/auth.mjs',
          summary: 'old auth note',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1000,
          stepId: '1',
          firstEdit: true,
          taskId: 'task-1',
        },
        {
          event: 'stale',
          stalledFactTs: 1000,
          source: 'src/auth.mjs',
          ts: 1001,
        },
      ]),
      'utf8',
    );

    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.factsRendered, 0);

    const out = readFileSync(memoryFile, 'utf8');
    assert.equal(out.includes('old auth note'), false);
  } finally {
    cleanup();
  }
});

test('render-memory replaces existing marker block and is idempotent', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact',
          key: 'src/auth.mjs:aaaa1111',
          source: 'src/auth.mjs',
          summary: 'fresh auth note',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: ['ext:mjs'],
          confidence: 0.8,
          ts: 1000,
          stepId: '1',
          firstEdit: true,
          taskId: 'task-1',
        },
      ]),
      'utf8',
    );

    writeFileSync(
      memoryFile,
      [
        '# Memory',
        '',
        '> Canonical devmate memory ledger.',
        '',
        '<!-- devmate:facts:start -->',
        '## old/source.mjs',
        '- old bullet',
        '<!-- devmate:facts:end -->',
        '',
      ].join('\n'),
      'utf8',
    );

    const first = await renderMemory(repoLedger, memoryFile);
    assert.equal(first.ok, true);

    const once = readFileSync(memoryFile, 'utf8');
    assert.equal(once.includes('old/source.mjs'), false);
    assert.equal(once.includes('fresh auth note'), true);

    const second = await renderMemory(repoLedger, memoryFile);
    assert.equal(second.ok, true);
    const twice = readFileSync(memoryFile, 'utf8');
    assert.equal(twice, once);
  } finally {
    cleanup();
  }
});

test('render-memory flags oversize (never clips) past the soft line cap', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    /** @type {Array<Record<string, unknown>>} */
    const facts = [];
    for (let i = 0; i < 250; i += 1) {
      facts.push({
        event: 'fact',
        key: `src/a.mjs:${i}`,
        source: 'src/a.mjs',
        summary: `note ${i}`,
        tool: 'discovery-merge',
        lane: 'feature',
        tags: [],
        confidence: 0.8,
        ts: 1000 + i,
        stepId: String(i),
        firstEdit: false,
        taskId: 'task-1',
      });
    }
    writeFileSync(repoLedger, jsonl(facts), 'utf8');

    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.factsRendered, 250, 'every fact is still rendered — no clipping');
    assert.equal(result.oversize, true);
    assert.ok((result.lineCount ?? 0) > 200);
  } finally {
    cleanup();
  }
});

test('render-memory is not oversize for a small ledger', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact',
          key: 'src/a.mjs:1',
          source: 'src/a.mjs',
          summary: 'one',
          tool: 'discovery-merge',
          lane: 'feature',
          tags: [],
          confidence: 0.8,
          ts: 1,
          stepId: '1',
          firstEdit: true,
          taskId: 'task-1',
        },
      ]),
      'utf8',
    );
    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.oversize, false);
  } finally {
    cleanup();
  }
});

test('render-memory #149: a first render writes the file (wrote: true)', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact', key: 'src/a.mjs:1', source: 'src/a.mjs',
          summary: 'a fact', tool: 'discovery-merge', lane: 'feature', tags: [],
          confidence: 0.8, ts: 1, stepId: '1', firstEdit: false, contentDigest: 'aaaa1111aaaa1111', taskId: 'task-1',
        },
      ]),
      'utf8',
    );
    assert.equal(existsSync(memoryFile), false);
    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.wrote, true, 'the initial render must write the file');
    assert.equal(existsSync(memoryFile), true);
  } finally {
    cleanup();
  }
});

test('render-memory #149: a re-render from an unchanged ledger is a no-op write (wrote: false, file untouched)', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        {
          event: 'fact', key: 'src/a.mjs:1', source: 'src/a.mjs',
          summary: 'a fact', tool: 'discovery-merge', lane: 'feature', tags: [],
          confidence: 0.8, ts: 1, stepId: '1', firstEdit: false, contentDigest: 'aaaa1111aaaa1111', taskId: 'task-1',
        },
      ]),
      'utf8',
    );

    const first = await renderMemory(repoLedger, memoryFile);
    assert.equal(first.wrote, true);
    const bytesAfterFirst = readFileSync(memoryFile);
    const mtimeAfterFirst = statSync(memoryFile).mtimeMs;

    // Nothing changed in the ledger — the render must not touch the tracked file.
    const second = await renderMemory(repoLedger, memoryFile);
    assert.equal(second.ok, true);
    assert.equal(second.wrote, false, 'an identical render must skip the write');
    const bytesAfterSecond = readFileSync(memoryFile);
    assert.equal(
      Buffer.compare(bytesAfterFirst, bytesAfterSecond),
      0,
      'the tracked file bytes must be byte-for-byte unchanged',
    );
    assert.equal(
      statSync(memoryFile).mtimeMs,
      mtimeAfterFirst,
      'the tracked file must not be rewritten (mtime unchanged)',
    );
  } finally {
    cleanup();
  }
});

// ── #150: the committed MEMORY.md prefers semantic discovery facts ────────────

test('#150 render-memory EXCLUDES bare edit events, keeps discovery facts', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        // A discovery fact — a natural-language repository claim (kept).
        {
          event: 'fact', key: 'src/auth.mjs:d1', source: 'src/auth.mjs',
          summary: 'auth uses a rotating-key JWT scheme', tool: 'discovery-merge',
          lane: 'feature', tags: [], confidence: 0.9, ts: 2000, stepId: 's', firstEdit: false,
          contentDigest: 'abcd1234abcd1234', taskId: 'task-1',
        },
        // Bare edit events — telemetry, excluded from the committed artifact.
        {
          event: 'fact', key: 'src/noise.mjs:e1', source: 'src/noise.mjs',
          summary: 'write_file edited src/noise.mjs', tool: 'write_file',
          lane: 'feature', tags: [], confidence: 0.8, ts: 2100, stepId: 's', firstEdit: true, taskId: 'task-1',
        },
        {
          event: 'fact', key: 'src/auth.mjs:e2', source: 'src/auth.mjs',
          summary: 'edit edited src/auth.mjs', tool: 'edit',
          lane: 'feature', tags: [], confidence: 0.8, ts: 2200, stepId: 's', firstEdit: false, taskId: 'task-1',
        },
      ]),
      'utf8',
    );

    const result = await renderMemory(repoLedger, memoryFile);
    assert.equal(result.ok, true);
    assert.equal(result.factsRendered, 1, 'only the discovery fact is committed');
    const out = readFileSync(memoryFile, 'utf8');
    assert.ok(out.includes('auth uses a rotating-key JWT scheme'), 'the discovery claim is kept');
    assert.ok(!out.includes('edited src/noise.mjs'), 'edit-event telemetry is excluded');
    assert.ok(!out.includes('## src/noise.mjs'), 'a source with only edit events gets no committed section');
  } finally {
    cleanup();
  }
});

test('#150 render-memory orders discovery facts by confidence, then recency', async () => {
  const { repoLedger, memoryFile, cleanup } = makeRoot();
  try {
    writeFileSync(
      repoLedger,
      jsonl([
        { event: 'fact', key: 'a:1', source: 'src/a.mjs', summary: 'low conf newer', tool: 'discovery-merge', lane: 'feature', tags: [], confidence: 0.6, ts: 3000, stepId: 's', firstEdit: false, contentDigest: 'aaaa1111aaaa1111', taskId: 't' },
        { event: 'fact', key: 'a:2', source: 'src/a.mjs', summary: 'high conf older', tool: 'discovery-merge', lane: 'feature', tags: [], confidence: 0.9, ts: 1000, stepId: 's', firstEdit: false, contentDigest: 'bbbb2222bbbb2222', taskId: 't' },
        { event: 'fact', key: 'a:3', source: 'src/a.mjs', summary: 'high conf newer', tool: 'discovery-merge', lane: 'feature', tags: [], confidence: 0.9, ts: 2000, stepId: 's', firstEdit: false, contentDigest: 'cccc3333cccc3333', taskId: 't' },
      ]),
      'utf8',
    );

    await renderMemory(repoLedger, memoryFile);
    const out = readFileSync(memoryFile, 'utf8');
    const order = ['high conf newer', 'high conf older', 'low conf newer'].map((s) => out.indexOf(s));
    assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2],
      `expected confidence-desc then recency-desc order; got indices ${JSON.stringify(order)}`);
  } finally {
    cleanup();
  }
});
