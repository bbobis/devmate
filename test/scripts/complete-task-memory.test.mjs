// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/complete-task.mjs';
import { memoryMdPath, repoLedgerPath, taskLedgerPath } from '../../lib/memory/paths.mjs';

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'complete-task-memory-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 'task-1',
      lane: 'feature',
      workflowGate: 'done',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('complete-task renders MEMORY.md after successful promotion', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const taskLedger = taskLedgerPath(root, 'task-1');
    writeFileSync(
      taskLedger,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:abcd1234',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'write_file edited auth.mjs',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );

    const code = await main(['--root', root]);
    assert.equal(code, 0);

    const repoLedger = readFileSync(repoLedgerPath(root), 'utf8');
    assert.equal(repoLedger.includes('lib/auth.mjs'), true);

    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('<!-- devmate:facts:start -->'), true);
    assert.equal(memory.includes('## lib/auth.mjs'), true);
    assert.equal(memory.includes('write_file edited auth.mjs'), true);
  } finally {
    cleanup();
  }
});

test('complete-task skips promotion when task ledger is missing', async () => {
  const { root, cleanup } = makeRoot();

  /** @type {string[]} */
  const stderrChunks = [];
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });

  try {
    const code = await main(['--root', root]);
    assert.equal(code, 0);
    const merged = stderrChunks.join('');
    assert.equal(merged.includes('memory.promote.skipped'), true);
    assert.equal(merged.includes('no_task_ledger'), true);
  } finally {
    process.stderr.write = originalStderr;
    cleanup();
  }
});

test('complete-task keeps success status when memory render fails after promotion', async () => {
  const { root, cleanup } = makeRoot();

  /** @type {string[]} */
  const stderrChunks = [];
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });

  try {
    const taskLedger = taskLedgerPath(root, 'task-1');
    writeFileSync(
      taskLedger,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:abcd1234',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'write_file edited auth.mjs',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );

    // Force render failure by making MEMORY.md a directory.
    mkdirSync(memoryMdPath(root), { recursive: true });

    const code = await main(['--root', root]);
    assert.equal(code, 0);

    const repoLedger = readFileSync(repoLedgerPath(root), 'utf8');
    assert.equal(repoLedger.includes('lib/auth.mjs'), true);

    const merged = stderrChunks.join('');
    assert.equal(merged.includes('memory render failed:'), true);
  } finally {
    process.stderr.write = originalStderr;
    cleanup();
  }
});

test('complete-task sequence across tasks keeps facts from different sources', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const taskStatePath = join(root, '.devmate', 'state', 'task.json');

    const ledger1 = taskLedgerPath(root, 'task-1');
    writeFileSync(
      ledger1,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:aaaa1111',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'auth changed',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );
    assert.equal(await main(['--root', root]), 0);

    writeFileSync(
      taskStatePath,
      JSON.stringify({
        taskId: 'task-2',
        lane: 'feature',
        workflowGate: 'done',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 2,
        budget: 10,
        schemaVersion: 1,
      }),
      'utf8',
    );
    const ledger2 = taskLedgerPath(root, 'task-2');
    writeFileSync(
      ledger2,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/cache.mjs:bbbb2222',
        source: 'lib/cache.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'cache changed',
        confidence: 0.8,
        ts: Date.now() + 1,
        stepId: '2',
        firstEdit: true,
      })}\n`,
      'utf8',
    );
    assert.equal(await main(['--root', root]), 0);

    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('## lib/auth.mjs'), true);
    assert.equal(memory.includes('## lib/cache.mjs'), true);
  } finally {
    cleanup();
  }
});

test('complete-task keeps same-source facts when keys differ across tasks', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const taskStatePath = join(root, '.devmate', 'state', 'task.json');

    writeFileSync(
      taskLedgerPath(root, 'task-1'),
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:aaaa1111',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'jwt config updated',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );
    assert.equal(await main(['--root', root]), 0);

    writeFileSync(
      taskStatePath,
      JSON.stringify({
        taskId: 'task-2',
        lane: 'feature',
        workflowGate: 'done',
        artifactHashes: {},
        preImplStash: null,
        currentStep: 2,
        budget: 10,
        schemaVersion: 1,
      }),
      'utf8',
    );
    writeFileSync(
      taskLedgerPath(root, 'task-2'),
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:bbbb2222',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'refresh-token policy updated',
        confidence: 0.8,
        ts: Date.now() + 1,
        stepId: '2',
        firstEdit: false,
      })}\n`,
      'utf8',
    );
    assert.equal(await main(['--root', root]), 0);

    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('jwt config updated'), true);
    assert.equal(memory.includes('refresh-token policy updated'), true);
  } finally {
    cleanup();
  }
});

test('complete-task deletes task ledger after successful promotion', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const taskLedger = taskLedgerPath(root, 'task-1');
    writeFileSync(
      taskLedger,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:zzzz9999',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'auth cleanup',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );

    const code = await main(['--root', root]);
    assert.equal(code, 0);
    assert.equal(existsSync(taskLedger), false);
  } finally {
    cleanup();
  }
});

test('complete-task returns non-zero when promotion cannot acquire repo lock', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const taskLedger = taskLedgerPath(root, 'task-1');
    writeFileSync(
      taskLedger,
      `${JSON.stringify({
        event: 'fact',
        key: 'lib/auth.mjs:lock1111',
        source: 'lib/auth.mjs',
        tool: 'write_file',
        lane: 'feature',
        tags: ['ext:mjs'],
        summary: 'lock timeout path',
        confidence: 0.8,
        ts: Date.now(),
        stepId: '1',
        firstEdit: true,
      })}\n`,
      'utf8',
    );

    const lockPath = repoLedgerPath(root) + '.lock';
    writeFileSync(lockPath, '', 'utf8');

    const code = await main(['--root', root]);
    assert.equal(code, 1);
    assert.equal(existsSync(taskLedger), true);
  } finally {
    cleanup();
  }
});
