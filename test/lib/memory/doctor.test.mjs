// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseMemory } from '../../../lib/memory/doctor.mjs';
import { renderMemory } from '../../../lib/memory/render-memory.mjs';
import { repoLedgerPath, taskLedgerPath } from '../../../lib/memory/paths.mjs';

/**
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'memory-doctor-'));
  mkdirSync(join(root, '.devmate', 'state', 'repo'), { recursive: true });
  mkdirSync(join(root, '.devmate', 'memory', 'tasks'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @param {string} source
 * @param {number} ts
 * @returns {string}
 */
function fact(source, ts) {
  return JSON.stringify({
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
  });
}

test('diagnoseMemory reports healthy when MEMORY.md matches the repo ledger', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n${fact('lib/b.mjs', 2)}\n`, 'utf8');
    await renderMemory(repoLedgerPath(root), join(root, '.devmate', 'MEMORY.md'));

    const d = await diagnoseMemory(root);
    assert.equal(d.ok, true);
    assert.equal(d.firstBrokenStage, null);
    assert.equal(d.promotion.activeFacts, 2);
    assert.equal(d.render.renderedFactLines, 2);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags collection when nothing has been recorded', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'collection');
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags promotion when task ledgers are staged but repo is empty', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(taskLedgerPath(root, 'task-1'), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'promotion');
    assert.equal(d.collection.pendingFacts, 1);
    assert.equal(d.promotion.activeFacts, 0);
  } finally {
    cleanup();
  }
});

test('diagnoseMemory flags render when repo has facts but MEMORY.md does not', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(repoLedgerPath(root), `${fact('lib/a.mjs', 1)}\n`, 'utf8');
    // No MEMORY.md rendered.
    const d = await diagnoseMemory(root);
    assert.equal(d.ok, false);
    assert.equal(d.firstBrokenStage, 'render');
    assert.equal(d.promotion.activeFacts, 1);
    assert.equal(d.render.renderedFactLines, 0);
  } finally {
    cleanup();
  }
});
