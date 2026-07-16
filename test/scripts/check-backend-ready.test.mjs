// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-backend-ready.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-cbr-'));
}

/**
 * @param {number} status
 * @returns {Promise<{ url: string, close: () => void }>}
 */
function startServer(status) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${addr.port}/health`, close: () => server.close() });
    });
  });
}

test('check-backend-ready main - exits 0 on passing predicate', async () => {
  const s = await startServer(200);
  const dir = tmp();
  try {
    const cfg = join(dir, 'preds.json');
    writeFileSync(cfg, JSON.stringify([{ url: s.url }]), 'utf8');
    const code = await main(['--config', cfg]);
    assert.equal(code, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-backend-ready main - exits 1 on failing predicate', async () => {
  const dir = tmp();
  try {
    const cfg = join(dir, 'preds.json');
    writeFileSync(cfg, JSON.stringify([{ url: 'http://127.0.0.1:1/health', timeoutMs: 400 }]), 'utf8');
    const code = await main(['--config', cfg]);
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-backend-ready main - exits 0 when no predicates configured (skip)', async () => {
  const dir = tmp();
  try {
    const cfg = join(dir, 'empty.json');
    writeFileSync(cfg, JSON.stringify([]), 'utf8');
    const code = await main(['--config', cfg]);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
