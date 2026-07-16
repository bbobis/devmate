// @ts-check
/**
 * DN-6: SessionStart reconciles a stale `activeSubagents` counter to 0 before
 * the resume plan is computed, appending a `subagent_reconciled` trace event
 * with the previous value. A zero/absent counter or missing task.json is a
 * silent no-op (no write, no trace event).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runWithIO } from '../../scripts/session-start.mjs';

/**
 * Build a minimal, devmate-ready repo root so the readiness checks pass.
 * @param {{ activeSubagents?: number, withTask?: boolean }} opts
 * @returns {Promise<string>}
 */
async function makeRepoRoot(opts = {}) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ss-reconcile-'));
  await fsp.mkdir(join(root, '.git'), { recursive: true });
  await fsp.mkdir(join(root, '.devmate', 'state', 'trace'), { recursive: true });
  await fsp.writeFile(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'fullstack', editableGlobs: ['src/**'] }],
      verification: { unitTest: 'node --test' },
    }),
    'utf8',
  );
  // No hooks/ or scripts/ here: the gate-guard manifest and script are
  // plugin-shipped and resolve against the plugin root, not this repo (#72).
  if (opts.withTask ?? true) {
    /** @type {Record<string, unknown>} */
    const state = {
      taskId: 't-reconcile',
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    };
    if (opts.activeSubagents !== undefined) state.activeSubagents = opts.activeSubagents;
    await fsp.writeFile(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify(state),
      'utf8',
    );
  }
  return root;
}

/**
 * @param {string} root
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function runSessionStart(root) {
  const stdin = Readable.from([
    Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }), 'utf8'),
  ]);
  /** @type {string[]} */
  const outChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  const mkStream = (/** @type {string[]} */ sink) =>
    /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ ({
      write: (/** @type {string|Buffer} */ c) => {
        sink.push(String(c));
        return true;
      },
    }));
  const code = await runWithIO(stdin, mkStream(outChunks), mkStream(errChunks));
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

/**
 * @param {string} root
 * @returns {Promise<any>}
 */
async function readTaskJson(root) {
  return JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'task.json'), 'utf8'));
}

/**
 * @param {string} root
 * @param {string} taskId
 * @returns {Promise<string[]>}
 */
async function readTraceLines(root, taskId) {
  try {
    const raw = await fsp.readFile(
      join(root, '.devmate', 'state', 'trace', `${taskId}.jsonl`),
      'utf8',
    );
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

test('resets a nonzero activeSubagents counter to 0 and traces the reconciliation', async () => {
  const root = await makeRepoRoot({ activeSubagents: 2 });
  const { code } = await runSessionStart(root);
  assert.equal(code, 0);

  const state = await readTaskJson(root);
  assert.equal(state.activeSubagents, 0);

  const lines = await readTraceLines(root, 't-reconcile');
  /** @type {any[]} */
  const reconciled = [];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === 'subagent_reconciled') reconciled.push(parsed);
  }
  assert.equal(reconciled.length, 1, 'exactly one subagent_reconciled event');
  assert.equal(reconciled[0].previous, 2);
  assert.equal(reconciled[0].taskId, 't-reconcile');
});

test('resume plan is computed after the reconciliation reset (clean counter)', async () => {
  const root = await makeRepoRoot({ activeSubagents: 3 });
  await runSessionStart(root);
  const plan = JSON.parse(
    await fsp.readFile(join(root, '.devmate', 'state', 'resume-plan.json'), 'utf8'),
  );
  assert.equal(plan.taskId, 't-reconcile');
  const state = await readTaskJson(root);
  assert.equal(state.activeSubagents, 0, 'plan computed against the already-reset counter');
});

test('activeSubagents === 0 is a no-op: no write, no trace event', async () => {
  const root = await makeRepoRoot({ activeSubagents: 0 });
  const before = await readTaskJson(root);
  const beforeMtime = (await fsp.stat(join(root, '.devmate', 'state', 'task.json'))).mtimeMs;

  await runSessionStart(root);

  const after = await readTaskJson(root);
  assert.deepEqual(after, before, 'task.json content unchanged');
  const afterMtime = (await fsp.stat(join(root, '.devmate', 'state', 'task.json'))).mtimeMs;
  assert.equal(afterMtime, beforeMtime, 'task.json not rewritten');

  const lines = await readTraceLines(root, 't-reconcile');
  assert.deepEqual(lines, [], 'no trace file/lines written');
});

test('activeSubagents absent is a no-op: no write, no trace event', async () => {
  const root = await makeRepoRoot({});
  const before = await readTaskJson(root);

  await runSessionStart(root);

  const after = await readTaskJson(root);
  assert.deepEqual(after, before, 'task.json content unchanged');
  const lines = await readTraceLines(root, 't-reconcile');
  assert.deepEqual(lines, [], 'no trace file/lines written');
});

test('no task.json at all is a no-op: session start still succeeds', async () => {
  const root = await makeRepoRoot({ withTask: false });
  const { code } = await runSessionStart(root);
  assert.equal(code, 0);
  const exists = await fsp
    .access(join(root, '.devmate', 'state', 'task.json'))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false, 'no task.json created');
});

test('reconciliation failure (lock contention) warns and does not abort session start', async () => {
  const root = await makeRepoRoot({ activeSubagents: 2 });
  // Pre-place a stale lock file so writeTaskState's lock acquisition times
  // out (mirrors a crashed-process lock leftover per lib/file-lock.mjs).
  await fsp.writeFile(join(root, '.devmate', 'state', 'task.json.lock'), '', 'utf8');

  const before = await readTaskJson(root);
  const { code, err } = await runSessionStart(root);

  assert.equal(code, 0, 'session start still succeeds despite the lock failure');
  assert.match(err, /subagent reconciliation skipped \(non-fatal\)/);

  const after = await readTaskJson(root);
  assert.deepEqual(after, before, 'activeSubagents left untouched when the write could not be persisted');
});

