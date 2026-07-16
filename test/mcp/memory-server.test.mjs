// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMessage, runQueryMemoryTool } from '../../mcp/memory-server.mjs';
import { repoLedgerPath } from '../../lib/memory/paths.mjs';

/**
 * Collect responses from handleMessage.
 * @returns {{ respond: (r: object) => void, all: object[] }}
 */
function collector() {
  /** @type {object[]} */
  const all = [];
  return { respond: (r) => all.push(r), all };
}

/**
 * @param {string} source
 * @param {number} ts
 * @returns {Record<string, unknown>}
 */
function fact(source, ts) {
  return {
    event: 'fact',
    key: `${source}:${ts}`,
    source,
    tool: 'write_file',
    lane: 'feature',
    tags: [],
    summary: `edited ${source}`,
    confidence: 0.8,
    ts,
    stepId: '1',
    firstEdit: true,
  };
}

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-mem-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'live.mjs'), 'export const x = 1;', 'utf8');
  writeFileSync(
    repoLedgerPath(root),
    `${JSON.stringify(fact('lib/live.mjs', 1))}\n${JSON.stringify(fact('lib/gone.mjs', 2))}\n`,
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('MCP initialize echoes protocolVersion and advertises tools capability', async () => {
  const c = collector();
  await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    c.respond,
    { repoRoot: '/tmp' },
  );
  assert.equal(c.all.length, 1);
  const r = /** @type {any} */ (c.all[0]);
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'devmate-memory');
});

test('MCP tools/list returns the query_memory tool with an input schema', async () => {
  const c = collector();
  await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, c.respond, { repoRoot: '/tmp' });
  const r = /** @type {any} */ (c.all[0]);
  assert.equal(r.result.tools.length, 1);
  assert.equal(r.result.tools[0].name, 'query_memory');
  assert.equal(r.result.tools[0].inputSchema.type, 'object');
});

test('MCP tools/call query_memory returns verified recall (drifted fact dropped)', async () => {
  const { root, cleanup } = makeRepo();
  try {
    const c = collector();
    await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_memory', arguments: {} } },
      c.respond,
      { repoRoot: root },
    );
    const r = /** @type {any} */ (c.all[0]);
    assert.equal(r.error, undefined);
    const text = r.result.content[0].text;
    assert.match(text, /lib\/live\.mjs/);
    assert.doesNotMatch(text, /lib\/gone\.mjs/, 'drifted fact must not appear (verify-before-use default on)');
  } finally {
    cleanup();
  }
});

test('runQueryMemoryTool with verify:false keeps drifted facts', async () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = await runQueryMemoryTool({ verify: false }, root);
    assert.match(res.content[0].text, /lib\/gone\.mjs/);
  } finally {
    cleanup();
  }
});

test('MCP unknown method returns method-not-found; notifications are ignored', async () => {
  const c = collector();
  await handleMessage({ jsonrpc: '2.0', id: 9, method: 'nope/nope' }, c.respond, { repoRoot: '/tmp' });
  assert.equal(/** @type {any} */ (c.all[0]).error.code, -32601);

  const c2 = collector();
  await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, c2.respond, { repoRoot: '/tmp' });
  assert.equal(c2.all.length, 0, 'a notification must produce no response');
});
