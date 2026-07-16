// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
          tool: 'write_file',
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
          tool: 'write_file',
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
          tool: 'write_file',
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
          tool: 'write_file',
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
          tool: 'write_file',
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
          tool: 'write_file',
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
        tool: 'write_file',
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
          tool: 'write_file',
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
