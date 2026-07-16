// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeResult } from '../../../lib/output/write-result.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'write-result-'));
}

test('writeResult - writes file and returns ok:true with path', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'result.json');
    const res = await writeResult(file, { ok: true, value: 42 });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('unreachable');
    assert.equal(res.path, file);
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, { ok: true, value: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeResult - creates parent directories when missing', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'nested', 'deep', 'result.json');
    const res = await writeResult(file, { created: true });
    assert.equal(res.ok, true);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeResult - atomically replaces an existing file', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'result.json');
    await writeResult(file, { version: 1 });
    const res = await writeResult(file, { version: 2 });
    assert.equal(res.ok, true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeResult - returns ok:false when data is not serialisable', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'result.json');
    const circular = /** @type {Record<string, unknown>} */ ({});
    circular['self'] = circular;
    const res = await writeResult(file, circular);
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('unreachable');
    assert.ok(res.error.includes('serialisation failed'));
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
