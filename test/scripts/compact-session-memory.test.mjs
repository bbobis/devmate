// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/compact-session.mjs';
import { memoryMdPath, repoLedgerPath, taskLedgerPath } from '../../lib/memory/paths.mjs';

/**
 * @param {{ taskId?: string }} [opts]
 * @returns {{ root: string, taskStatePath: string, outDir: string, cleanup: () => void }}
 */
function makeRoot(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compact-session-memory-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  const taskId = opts.taskId ?? 'task-1';
  const taskStatePath = join(root, '.devmate', 'state', 'task.json');
  const outDir = join(root, '.devmate', 'state', 'compaction');
  writeFileSync(
    taskStatePath,
    JSON.stringify({
      taskId,
      lane: 'feature',
      workflowGate: 'done',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
      outputContract: { done_when: 'ship it' },
      evidencePack: {
        pointers: [
          {
            path: 'lib/x.mjs',
            lineRange: null,
            reason: 'r',
            confidence: 0.9,
            freshness: 'now',
            kind: 'file',
          },
        ],
      },
    }),
    'utf8',
  );
  return {
    root,
    taskStatePath,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('compact-session promotes active task ledger before rendering MEMORY.md', async () => {
  const { root, taskStatePath, outDir, cleanup } = makeRoot();
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

    const code = await main([taskStatePath, outDir]);
    assert.equal(code, 0);

    const repo = readFileSync(repoLedgerPath(root), 'utf8');
    assert.equal(repo.includes('lib/auth.mjs'), true);

    const memory = readFileSync(memoryMdPath(root), 'utf8');
    assert.equal(memory.includes('## lib/auth.mjs'), true);
    assert.equal(memory.includes('write_file edited auth.mjs'), true);
  } finally {
    cleanup();
  }
});

test('compact-session keeps running when taskId is invalid (non-fatal promote skip)', async () => {
  const { taskStatePath, outDir, cleanup } = makeRoot({ taskId: 'Bad Task' });

  /** @type {string[]} */
  const stderrChunks = [];
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });

  try {
    const code = await main([taskStatePath, outDir]);
    assert.equal(code, 0);
    const merged = stderrChunks.join('');
    assert.equal(merged.includes('promote skipped (non-fatal)'), true);
  } finally {
    process.stderr.write = originalStderr;
    cleanup();
  }
});
