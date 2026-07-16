// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkBackendReady,
  loadHealthPredicates,
  markBackendReadyStale,
  assertBackendReadyBeforeTier5,
  traceE2EBlock,
} from '../../../lib/workflow/backend-ready.mjs';

/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-bready-'));
}

/** @returns {TaskState} */
function makeState() {
  return {
    taskId: 't1',
    lane: /** @type {any} */ ('feature'),
    workflowGate: /** @type {any} */ ('impl-started'),
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

/**
 * Start a one-shot http server returning the given status/body.
 * @param {number} status
 * @param {string} body
 * @returns {Promise<{ url: string, close: () => void }>}
 */
function startServer(status, body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${addr.port}/health`, close: () => server.close() });
    });
  });
}

// ---- checkBackendReady ----

test('checkBackendReady - empty predicates = ready/skip', async () => {
  const r = await checkBackendReady([]);
  assert.equal(r.ready, true);
  assert.match(r.reason, /skip/i);
});

test('checkBackendReady - all pass', async () => {
  const s = await startServer(200, '{"status":"UP"}');
  try {
    const r = await checkBackendReady([{ url: s.url, bodyContains: '"status":"UP"' }]);
    assert.equal(r.ready, true);
    assert.equal(r.failedPredicates.length, 0);
  } finally {
    s.close();
  }
});

test('checkBackendReady - status mismatch fails', async () => {
  const s = await startServer(503, 'down');
  try {
    const r = await checkBackendReady([{ url: s.url }]);
    assert.equal(r.ready, false);
    assert.equal(r.failedPredicates.length, 1);
  } finally {
    s.close();
  }
});

test('checkBackendReady - bodyContains mismatch fails', async () => {
  const s = await startServer(200, 'pong');
  try {
    const r = await checkBackendReady([{ url: s.url, bodyContains: 'healthy' }]);
    assert.equal(r.ready, false);
  } finally {
    s.close();
  }
});

test('checkBackendReady - network error captured, no throw', async () => {
  // Port 1 is almost certainly closed; should resolve to a failure, not throw.
  const r = await checkBackendReady([{ url: 'http://127.0.0.1:1/health', timeoutMs: 500 }]);
  assert.equal(r.ready, false);
  assert.equal(r.failedPredicates.length, 1);
});

// ---- loadHealthPredicates ----

test('loadHealthPredicates - no config = empty array (no Spring default)', async () => {
  const dir = tmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const preds = await loadHealthPredicates();
    assert.deepEqual(preds, []);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadHealthPredicates - loads explicit predicate file', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'preds.json');
    writeFileSync(path, JSON.stringify([{ url: 'http://x/health' }]), 'utf8');
    const preds = await loadHealthPredicates(path);
    assert.equal(preds.length, 1);
    assert.equal(preds[0].url, 'http://x/health');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadHealthPredicates - reads healthPredicates from devmate.config.json', async () => {
  const dir = tmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, '.devmate'), { recursive: true });
    writeFileSync(
      join(dir, '.devmate', 'devmate.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }],
        healthPredicates: [{ url: 'http://api/health', statusCode: 204 }],
      }),
      'utf8',
    );
    const preds = await loadHealthPredicates();
    assert.equal(preds.length, 1);
    assert.equal(preds[0].statusCode, 204);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadHealthPredicates - invalid array throws', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{"not":"array"}', 'utf8');
    await assert.rejects(() => loadHealthPredicates(path), /must be a JSON array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- markBackendReadyStale ----

test('markBackendReadyStale - sets timestamp and writes trace', async () => {
  const dir = tmp();
  try {
    const statePath = join(dir, 'state.json');
    const trace = join(dir, 'trace.jsonl');
    const next = await markBackendReadyStale(makeState(), 'health failed', {
      statePath,
      transitionsPath: trace,
    });
    assert.ok(typeof next.backendReadyStaleSince === 'string');
    assert.ok(existsSync(trace));
    const line = readFileSync(trace, 'utf8').trim();
    assert.match(line, /gate_stale/);
    assert.match(line, /backend-ready/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- assertBackendReadyBeforeTier5 ----

test('assertBackendReadyBeforeTier5 - throws on stale gate without probing', async () => {
  const dir = tmp();
  try {
    const trace = join(dir, 'trace.jsonl');
    const state = makeState();
    state.backendReadyStaleSince = new Date().toISOString();
    await assert.rejects(
      () => assertBackendReadyBeforeTier5(state, [{ url: 'http://unused/health' }], { transitionsPath: trace }),
      /stale/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertBackendReadyBeforeTier5 - marks stale and throws on failure', async () => {
  const dir = tmp();
  try {
    const statePath = join(dir, 'state.json');
    const trace = join(dir, 'trace.jsonl');
    await assert.rejects(
      () =>
        assertBackendReadyBeforeTier5(makeState(), [{ url: 'http://127.0.0.1:1/health', timeoutMs: 400 }], {
          statePath,
          transitionsPath: trace,
        }),
      /not ready/,
    );
    const traceTxt = readFileSync(trace, 'utf8');
    assert.match(traceTxt, /e2e_blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertBackendReadyBeforeTier5 - returns result on pass', async () => {
  const s = await startServer(200, 'ok');
  const dir = tmp();
  try {
    const r = await assertBackendReadyBeforeTier5(makeState(), [{ url: s.url }], {
      statePath: join(dir, 'state.json'),
      transitionsPath: join(dir, 'trace.jsonl'),
    });
    assert.equal(r.ready, true);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- traceE2EBlock ----

test('traceE2EBlock - appends event with reason/gate/tier/blockedAt', async () => {
  const dir = tmp();
  try {
    const trace = join(dir, 'trace.jsonl');
    await traceE2EBlock({ reason: 'r', gate: 'backend-ready', tier: 5 }, { transitionsPath: trace });
    const obj = JSON.parse(readFileSync(trace, 'utf8').trim());
    assert.equal(obj.event, 'e2e_blocked');
    assert.equal(obj.reason, 'r');
    assert.equal(obj.gate, 'backend-ready');
    assert.equal(obj.tier, 5);
    assert.ok(typeof obj.blockedAt === 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
