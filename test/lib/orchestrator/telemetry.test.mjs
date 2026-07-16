// @ts-check
/**
 * E8-1: tests for recordWorkerTelemetry. Writes to a temp ledger so the real
 * evals/telemetry/workers.jsonl is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJson } from '../../../lib/json-io.mjs';
import { recordWorkerTelemetry } from '../../../lib/orchestrator/telemetry.mjs';

/** @typedef {import('../../../lib/types.mjs').WorkerTelemetry} WorkerTelemetry */

/**
 * Make a unique temp ledger path (inside a not-yet-created subdir, to prove the
 * directory is auto-created on first write).
 * @returns {Promise<string>}
 */
async function tempLedger() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'fanout-tel-'));
  return join(dir, 'nested', 'workers.jsonl');
}

/**
 * @param {string} id
 * @returns {WorkerTelemetry}
 */
function makeTel(id) {
  return { workerId: id, promptTokens: 100, completionTokens: 50, latencyMs: 12, contractValid: true };
}

test('telemetry › appends entry to workers.jsonl', async () => {
  const ledgerPath = await tempLedger();
  await recordWorkerTelemetry('w1', makeTel('w1'), { ledgerPath });

  const text = await fsp.readFile(ledgerPath, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.workerId, 'w1');
  assert.equal(entry.promptTokens, 100);
  assert.equal(entry.contractValid, true);
  assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 0);
});

test('telemetry › concurrent appends safe', async () => {
  const ledgerPath = await tempLedger();
  const N = 8;
  await Promise.all(
    Array.from({ length: N }, (_unused, i) =>
      recordWorkerTelemetry(`w${i}`, makeTel(`w${i}`), { ledgerPath })
    )
  );

  const text = await fsp.readFile(ledgerPath, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, N, `expected ${N} lines, got ${lines.length}`);
  // Every line must be valid JSON (no interleaving/corruption).
  const ids = lines.map((l) => /** @type {any} */ (parseJson(l)).workerId).sort();
  assert.deepEqual(ids, Array.from({ length: N }, (_unused, i) => `w${i}`).sort());
});
