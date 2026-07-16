// @ts-check
/**
 * E3-1 regression: concurrent JSONL writers must not interleave lines,
 * and a lock timeout must surface a structured entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { acquireLock } from '../../lib/memory/jsonl-lock.mjs';
import { appendJsonl } from '../../lib/memory/append-jsonl.mjs';
import { makeTmpDir, cleanup, readJsonl } from './_helpers.mjs';

test('concurrency › 10 concurrent writers produce zero interleaved lines', async () => {
  const dir = makeTmpDir('reg-concurrency-');
  const ledger = join(dir, 'ledger.jsonl');
  try {
    /** @type {Promise<unknown>[]} */
    const writes = [];
    for (let i = 0; i < 10; i++) {
      writes.push(appendJsonl(ledger, { writer: i, payload: 'x'.repeat(64) }));
    }
    await Promise.all(writes);

    // Every line must parse cleanly (no interleaving / partial writes).
    const rows = readJsonl(ledger);
    assert.equal(rows.length, 10, 'all 10 writes landed as distinct lines');
    const writers = new Set(rows.map((r) => r['writer']));
    assert.equal(writers.size, 10, 'each writer wrote exactly one intact line');
  } finally {
    cleanup(dir);
  }
});

test('concurrency › lock timeout emits structured entry', async () => {
  const dir = makeTmpDir('reg-locktimeout-');
  const ledger = join(dir, 'ledger.jsonl');
  try {
    writeFileSync(ledger, '', 'utf8');
    // Hold the lock so the second acquire is forced to time out.
    const held = await acquireLock(ledger, { timeoutMs: 1000 });
    await assert.rejects(
      () => acquireLock(ledger, { timeoutMs: 60, retryIntervalMs: 10 }),
      /** @param {Error} err */
      (err) => err.name === 'LockTimeoutError'
    );
    await held.release();

    // A structured lock_timeout entry should have been appended best-effort.
    const rows = readJsonl(ledger);
    const timeout = rows.find((r) => r['event'] === 'lock_timeout');
    assert.ok(timeout, 'a structured lock_timeout entry was written');
    assert.equal(timeout?.['ledgerPath'], ledger);
  } finally {
    cleanup(dir);
  }
});
