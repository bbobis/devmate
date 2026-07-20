// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runWithIO } from '../../scripts/session-stop.mjs';
import {
  memoryMdPath,
  repoLedgerPath,
  taskLedgerPath,
} from '../../lib/memory/paths.mjs';
import { buildResumePlan } from '../../lib/resume/plan.mjs';

/**
 * @param {string} s
 * @returns {import('node:stream').Readable}
 */
function stringReadable(s) {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

/**
 * @returns {{ stream: import('node:stream').Writable, get: () => string }}
 */
function collectingWritable() {
  /** @type {Buffer[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  return { stream, get: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * Temp repo root with a `.devmate/` layout (so resolveRepoRoot short-circuits
 * to it) and a task.json carrying `taskId`. `workflowGate` defaults to `done`
 * (memory-capture tests don't care); the handoff tests pass an in-progress gate.
 * @param {string} taskId
 * @param {string} [workflowGate]
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot(taskId, workflowGate = 'done') {
  const root = mkdtempSync(join(tmpdir(), 'session-stop-test-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'state', 'trace'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId,
      lane: 'feature',
      workflowGate,
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
      outputContract: { done_when: 'ship it' },
    }),
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {Partial<import('../../lib/types.mjs').FactEntry>} over
 * @returns {string}
 */
function factLine(over) {
  return `${JSON.stringify({
    event: 'fact',
    key: 'lib/auth.mjs:abcd1234',
    source: 'lib/auth.mjs',
    // #150: committed MEMORY.md renders SEMANTIC discovery facts only —
    // pipeline fixtures must be discovery-merge facts to reach the rendered view.
    tool: 'discovery-merge',
    lane: 'feature',
    tags: ['ext:mjs'],
    summary: 'write_file edited auth.mjs',
    confidence: 0.8,
    ts: 1782812345678,
    stepId: '1',
    firstEdit: true,
    ...over,
  })}\n`;
}

test('session-stop promotes the active task ledger and renders MEMORY.md on normal exit', async () => {
  const { root, cleanup } = makeRoot('task-1');
  try {
    writeFileSync(taskLedgerPath(root, 'task-1'), factLine({}), 'utf8');

    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    const repo = readFileSync(repoLedgerPath(root), 'utf8');
    assert.equal(repo.includes('lib/auth.mjs'), true);
    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('## lib/auth.mjs'), true);
    assert.equal(memory.includes('write_file edited auth.mjs'), true);
    // Task ledger is consumed on successful promotion.
    assert.equal(existsSync(taskLedgerPath(root, 'task-1')), false);
    assert.equal(out.get().includes('memory.rendered'), true);
  } finally {
    cleanup();
  }
});

test('session-stop re-renders MEMORY.md from repo.jsonl even with no task ledger', async () => {
  const { root, cleanup } = makeRoot('task-1');
  try {
    // Facts already promoted by an earlier task; no task ledger this session.
    writeFileSync(repoLedgerPath(root), factLine({ source: 'lib/db.mjs', key: 'lib/db.mjs:1111' }), 'utf8');

    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('## lib/db.mjs'), true);
  } finally {
    cleanup();
  }
});

test('session-stop keeps running when taskId is invalid (non-fatal promote skip)', async () => {
  const { root, cleanup } = makeRoot('Bad Task');
  try {
    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    assert.equal(err.get().includes('promote skipped (non-fatal)'), true);
  } finally {
    cleanup();
  }
});

test('session-stop is a no-op for a non-Stop hook event', async () => {
  const { root, cleanup } = makeRoot('task-1');
  try {
    writeFileSync(taskLedgerPath(root, 'task-1'), factLine({}), 'utf8');

    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    // No promotion or render happened.
    assert.equal(existsSync(repoLedgerPath(root)), false);
    assert.equal(existsSync(memoryMdPath(root)), false);
  } finally {
    cleanup();
  }
});

// ---- Handoff capture on Stop ----

test('session-stop writes a resume handoff for an in-progress task', async () => {
  const { root, cleanup } = makeRoot('feat-1', 'impl-started');
  try {
    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    const handoffJson = join(root, '.devmate', 'state', 'handoff', 'feat-1', 'handoff.json');
    assert.equal(existsSync(handoffJson), true, 'handoff.json should be written on Stop');
    assert.equal(out.get().includes('handoff.written'), true);
  } finally {
    cleanup();
  }
});

test('session-stop writes no handoff for a completed task (workflowGate=done)', async () => {
  const { root, cleanup } = makeRoot('feat-1', 'done');
  try {
    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    assert.equal(
      existsSync(join(root, '.devmate', 'state', 'handoff', 'feat-1', 'handoff.json')),
      false,
      'a completed task needs no resume handoff',
    );
    assert.equal(out.get().includes('handoff.written'), false);
  } finally {
    cleanup();
  }
});

test('full loop: the handoff written on Stop is consumed by the resume plan', async () => {
  const { root, cleanup } = makeRoot('feat-1', 'impl-started');
  try {
    // Stop writes the handoff.
    const code = await runWithIO(
      stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root })),
      collectingWritable().stream,
      collectingWritable().stream,
    );
    assert.equal(code, 0);

    // A later session's resume plan reads it back.
    const plan = await buildResumePlan('feat-1', {
      traceDir: join(root, '.devmate', 'state', 'trace'),
      handoffDir: join(root, '.devmate', 'state', 'handoff'),
    });
    assert.equal(plan.handoffAvailable, true, 'resume consumes the Stop-written handoff');
    assert.equal(plan.handoff?.taskId, 'feat-1');
  } finally {
    cleanup();
  }
});

// ---- Delegation advisory on Stop ----

test('session-stop flags an inline session (post-analysis gate, no dispatch)', async () => {
  const { root, cleanup } = makeRoot('feat-1', 'impl-started');
  try {
    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    assert.equal(out.get().includes('delegation.warning'), true);
    assert.equal(err.get().includes('likely done inline'), true);
  } finally {
    cleanup();
  }
});

test('session-stop does not flag when the session delegated', async () => {
  const { root, cleanup } = makeRoot('feat-1', 'impl-started');
  try {
    // A recorded subagent dispatch clears the advisory.
    writeFileSync(
      join(root, '.devmate', 'state', 'trace', 'feat-1.jsonl'),
      JSON.stringify({
        type: 'subagent_start',
        stepId: 'subagent-discovery',
        taskId: 'feat-1',
        ts: '2026-07-05T00:00:00.000Z',
        schemaVersion: 1,
        agentName: 'discovery.agent',
        persona: 'discovery',
        activeCount: 1,
      }) + '\n',
      'utf8',
    );
    const stdin = stringReadable(JSON.stringify({ hook_event_name: 'Stop', cwd: root }));
    const out = collectingWritable();
    const err = collectingWritable();
    const code = await runWithIO(stdin, out.stream, err.stream);

    assert.equal(code, 0);
    assert.equal(out.get().includes('delegation.warning'), false);
  } finally {
    cleanup();
  }
});
