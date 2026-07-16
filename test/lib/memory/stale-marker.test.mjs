// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl } from '../../../lib/json-io.mjs';
import { markStale, resolveSourceIdentity } from '../../../lib/memory/stale-marker.mjs';

/** @typedef {import('../../../lib/types.mjs').HookPayload} HookPayload */

/**
 * Build a fresh temp workspace + ledger path.
 * @returns {{ root: string, ledger: string, cleanup: () => void }}
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'stale-marker-test-'));
  const ledger = join(root, 'facts.jsonl');
  return { root, ledger, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Read a JSONL file into parsed entries; returns [] if missing/empty.
 * @param {string} path
 * @returns {Record<string, unknown>[]}
 */
function readLedger(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return [];
  return /** @type {Record<string, unknown>[]} */ (parseJsonl(raw));
}

/**
 * Append a raw `fact` entry for `source` with a specific `ts`.
 * @param {string} ledger
 * @param {string} source
 * @param {number} ts
 * @param {string} [stepId]
 */
function writeRawFact(ledger, source, ts, stepId = 's1') {
  const entry = { event: 'fact', source, tool: 'write_file', ts, stepId, firstEdit: false };
  writeFileSync(ledger, JSON.stringify(entry) + '\n', { flag: 'a' });
}

test('first edit — no stale written, firstEdit true', async () => {
  const ws = makeWorkspace();
  try {
    const res = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(res.markedCount, 0);
    assert.equal(res.firstEdit, true);
    assert.deepEqual(res.entries, []);
    // Ledger must remain absent/empty.
    assert.equal(existsSync(ws.ledger), false);
  } finally {
    ws.cleanup();
  }
});

test('second edit — one stale written with correct stalledFactTs', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000);
    const res = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(res.markedCount, 1);
    assert.equal(res.firstEdit, false);
    const ledger = readLedger(ws.ledger);
    const stale = ledger.filter((e) => e['event'] === 'stale');
    assert.equal(stale.length, 1);
    assert.equal(stale[0]['stalledFactTs'], 1000);
    assert.equal(stale[0]['reason'], 'changed');
    assert.deepEqual(stale[0]['source'], { path: 'src/foo.mjs' });
  } finally {
    ws.cleanup();
  }
});

test('multiple active facts all staled in one call', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000, 's1');
    writeRawFact(ws.ledger, 'src/foo.mjs', 2000, 's2');
    const res = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(res.markedCount, 2);
    const staled = readLedger(ws.ledger)
      .filter((e) => e['event'] === 'stale')
      .map((e) => e['stalledFactTs'])
      .sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(staled, [1000, 2000]);
  } finally {
    ws.cleanup();
  }
});

test('duplicate reason — marks prior fact stale', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000, 'step-7');
    const res = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'duplicate');
    assert.equal(res.markedCount, 1);
    const stale = readLedger(ws.ledger).filter((e) => e['event'] === 'stale');
    assert.equal(stale[0]['reason'], 'duplicate');
  } finally {
    ws.cleanup();
  }
});

test('renamed reason — prior fact staled correctly', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/old.mjs', 1000);
    const res = await markStale(ws.ledger, { path: 'src/old.mjs' }, 'renamed');
    assert.equal(res.markedCount, 1);
    const stale = readLedger(ws.ledger).filter((e) => e['event'] === 'stale');
    assert.equal(stale[0]['reason'], 'renamed');
    assert.deepEqual(stale[0]['source'], { path: 'src/old.mjs' });
  } finally {
    ws.cleanup();
  }
});

test('deleted reason — prior fact staled', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/gone.mjs', 1000);
    const res = await markStale(ws.ledger, { path: 'src/gone.mjs' }, 'deleted');
    assert.equal(res.markedCount, 1);
    const stale = readLedger(ws.ledger).filter((e) => e['event'] === 'stale');
    assert.equal(stale[0]['reason'], 'deleted');
  } finally {
    ws.cleanup();
  }
});

test('already-staled fact is not re-staled', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000);
    // first markStale produces a stale entry for ts 1000
    const first = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(first.markedCount, 1);
    // second markStale finds no ACTIVE fact -> firstEdit true, markedCount 0
    const second = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(second.markedCount, 0);
    assert.equal(second.firstEdit, true);
    const staleCount = readLedger(ws.ledger).filter((e) => e['event'] === 'stale').length;
    assert.equal(staleCount, 1); // not doubled
  } finally {
    ws.cleanup();
  }
});

test('only facts for the matching source are staled', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000);
    writeRawFact(ws.ledger, 'src/bar.mjs', 1100);
    const res = await markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed');
    assert.equal(res.markedCount, 1);
    const stale = readLedger(ws.ledger).filter((e) => e['event'] === 'stale');
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0]['source'], { path: 'src/foo.mjs' });
  } finally {
    ws.cleanup();
  }
});

// #77: `write_file` and a `workspaceRoot` payload key are both fictions — VS
// Code sends `create_file` and never sends a root at all.
test('resolveSourceIdentity — path escape returns null', () => {
  /** @type {HookPayload} */
  const payload = { tool_name: 'create_file', path: '../../secret' };
  assert.equal(resolveSourceIdentity(payload, { workspaceRoot: '/ws' }), null);
});

test('resolveSourceIdentity — non-path payload returns null', () => {
  /** @type {HookPayload} */
  const payload = { tool_name: 'run_in_terminal', command: 'ls -la' };
  assert.equal(resolveSourceIdentity(payload, { workspaceRoot: '/ws' }), null);
});

test('resolveSourceIdentity — normalises a workspace-relative path', () => {
  /** @type {HookPayload} */
  const payload = { tool_name: 'create_file', path: 'src/foo.mjs' };
  const id = resolveSourceIdentity(payload, { workspaceRoot: '/ws' });
  assert.deepEqual(id, { path: 'src/foo.mjs' });
});

test('concurrent stale calls — no missing stale, no double-stale', async () => {
  const ws = makeWorkspace();
  try {
    writeRawFact(ws.ledger, 'src/foo.mjs', 1000);
    // Two concurrent markStale calls race for the lock. Exactly one should
    // produce a stale entry (the other sees the fact already staled).
    const [a, b] = await Promise.all([
      markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed'),
      markStale(ws.ledger, { path: 'src/foo.mjs' }, 'changed'),
    ]);
    const totalMarked = a.markedCount + b.markedCount;
    assert.equal(totalMarked, 1, 'exactly one stale entry across both calls');
    const staleCount = readLedger(ws.ledger).filter((e) => e['event'] === 'stale').length;
    assert.equal(staleCount, 1);
  } finally {
    ws.cleanup();
  }
});
