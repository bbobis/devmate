// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJson } from '../../../lib/json-io.mjs';
import { appendJsonl, appendJsonlWithHandle } from '../../../lib/memory/append-jsonl.mjs';

/**
 * @returns {{ dir: string, ledger: string, cleanup: () => void }}
 */
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'append-jsonl-test-'));
  const ledger = join(dir, 'test.jsonl');
  return { dir, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('appendJsonl — single write: ledger has exactly one valid JSON line', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    const result = await appendJsonl(ledger, { hello: 'world' });
    assert.ok(result.ok);
    assert.equal(result.ledgerPath, ledger);
    assert.ok(result.bytesWritten > 0);
    assert.equal(result.timeoutEntry, null);
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, { hello: 'world' });
  } finally {
    cleanup();
  }
});

test('appendJsonl — sequential writes: ledger has N parseable lines', async () => {
  const { ledger, cleanup } = makeTmp();
  const N = 5;
  try {
    for (let i = 0; i < N; i++) {
      await appendJsonl(ledger, { seq: i });
    }
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    assert.equal(lines.length, N);
    for (let i = 0; i < N; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.seq, i);
    }
  } finally {
    cleanup();
  }
});

test('appendJsonl — concurrent stress (20 writers): exactly 20 valid lines, no corruption', async () => {
  const { ledger, cleanup } = makeTmp();
  const N = 20;
  try {
    const promises = Array.from({ length: N }, (_, i) =>
      appendJsonl(ledger, { writer: i })
    );
    const results = await Promise.all(promises);
    assert.ok(results.every((r) => r.ok), 'all appends should succeed');
    const content = readFileSync(ledger, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, N, `expected ${N} lines, got ${lines.length}`);
    for (const line of lines) {
      const parsed = /** @type {any} */ (parseJson(line));
      assert.equal(typeof parsed.writer, 'number', 'each line must have a writer field');
    }
    const ids = lines.map((l) => /** @type {any} */ (parseJson(l)).writer).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: N }, (_, i) => i));
  } finally {
    cleanup();
  }
});

test('appendJsonl — creates ledger if absent: file created with one line', async () => {
  const { ledger, cleanup } = makeTmp();
  try {
    assert.ok(!existsSync(ledger), 'ledger should not exist before append');
    const result = await appendJsonl(ledger, { created: true });
    assert.ok(result.ok);
    assert.ok(existsSync(ledger), 'ledger should exist after append');
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { created: true });
  } finally {
    cleanup();
  }
});

test('appendJsonl — lock released on write error: sentinel removed after rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-jsonl-err-test-'));
  const dirAsLedger = join(dir, 'subdir');
  mkdirSync(dirAsLedger, { recursive: true });
  const lockPath = dirAsLedger + '.lock';
  try {
    await appendJsonl(dirAsLedger, { test: true });
  } catch {
    // Expected: appendFile to a directory path throws.
  }
  assert.ok(!existsSync(lockPath), 'sentinel must be cleaned up after write error');
  rmSync(dir, { recursive: true, force: true });
});

test('appendJsonl — creates parent directory when it does not exist', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const nestedLedger = join(dir, 'missing', 'nested', 'dir', 'facts.jsonl');
    assert.ok(!existsSync(nestedLedger));
    const result = await appendJsonl(nestedLedger, { key: 'mkdir-guard' });
    assert.ok(result.ok);
    assert.ok(existsSync(nestedLedger));
    const line = readFileSync(nestedLedger, 'utf8').trim();
    assert.deepEqual(JSON.parse(line), { key: 'mkdir-guard' });
  } finally {
    cleanup();
  }
});

test('appendJsonlWithHandle — creates parent directory when it does not exist', async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const nestedLedger = join(dir, 'also-missing', 'sub', 'facts.jsonl');
    assert.ok(!existsSync(nestedLedger));
    const result = await appendJsonlWithHandle(nestedLedger, { key: 'handle-mkdir' });
    assert.ok(result.ok);
    assert.ok(existsSync(nestedLedger));
    const line = readFileSync(nestedLedger, 'utf8').trim();
    assert.deepEqual(JSON.parse(line), { key: 'handle-mkdir' });
  } finally {
    cleanup();
  }
});
