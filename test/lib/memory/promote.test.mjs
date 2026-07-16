// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl } from '../../../lib/json-io.mjs';
import { promoteLedger } from '../../../lib/memory/promote.mjs';
import { resolveConflict } from '../../../lib/memory/conflict-policy.mjs';

/** @typedef {import('../../../lib/types.mjs').FactEntry} FactEntry */

/**
 * @returns {{ root: string, task: string, repo: string, cleanup: () => void }}
 */
function ws() {
  const root = mkdtempSync(join(tmpdir(), 'promote-test-'));
  return {
    root,
    task: join(root, 'task.jsonl'),
    repo: join(root, 'repo.jsonl'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>[]}
 */
function readLedger(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return [];
  return /** @type {Record<string, unknown>[]} */ (parseJsonl(raw));
}

/**
 * @param {string} source
 * @param {number} ts
 * @param {string} [writer]
 * @param {string} [key]
 * @returns {FactEntry}
 */
function fact(source, ts, writer = 'agent-a', key = `${source}:${ts}`) {
  return /** @type {FactEntry} */ (/** @type {unknown} */ ({
    key,
    event: 'fact', source, tool: 'write_file', lane: 'feature',
    tags: [], summary: `edited ${source}`, confidence: 0.8, ts,
    stepId: 's1', firstEdit: true, writer,
  }));
}

/**
 * @param {string} path
 * @param {object[]} entries
 */
function seed(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

test('happy path — all active facts promoted, task ledger deleted', async () => {
  const w = ws();
  try {
    seed(w.task, [fact('a.mjs', 1), fact('b.mjs', 2), fact('c.mjs', 3)]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1' });
    assert.equal(res.ok, true);
    assert.equal(res.promoted, 3);
    assert.equal(existsSync(w.task), false, 'task ledger deleted');
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 3);
  } finally {
    w.cleanup();
  }
});

test('partial failure — rename throws → ok false, task ledger intact', async () => {
  const w = ws();
  try {
    seed(w.task, [fact('a.mjs', 1)]);
    const res = await promoteLedger(w.task, w.repo, {
      taskId: 't1',
      rename: async () => { throw new Error('disk full'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'rename_failed');
    assert.equal(existsSync(w.task), true, 'task ledger preserved on failure');
    assert.equal(existsSync(w.repo + '.promoting'), false, 'temp file cleaned up');
  } finally {
    w.cleanup();
  }
});

test('verification failure — read-back short → ok false, task ledger intact', async () => {
  const w = ws();
  try {
    seed(w.task, [fact('a.mjs', 1), fact('b.mjs', 2)]);
    const res = await promoteLedger(w.task, w.repo, {
      taskId: 't1',
      readBack: async () => [], // pretend nothing landed
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'verification_failed');
    assert.equal(existsSync(w.task), true);
  } finally {
    w.cleanup();
  }
});

test('stale facts are not promoted', async () => {
  const w = ws();
  try {
    seed(w.task, [
      fact('a.mjs', 1),
      fact('b.mjs', 2),
      { event: 'stale', source: { path: 'b.mjs' }, reason: 'changed', stalledFactTs: 2, ts: 99 },
    ]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1' });
    assert.equal(res.ok, true);
    assert.equal(res.promoted, 1);
    assert.equal(res.skipped, 1);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 1);
    assert.equal(repo[0]['source'], 'a.mjs');
  } finally {
    w.cleanup();
  }
});

test('conflict — keep-existing keeps repo fact', async () => {
  const w = ws();
  try {
    seed(w.repo, [fact('a.mjs', 100, 'repo-writer', 'a.mjs:same-key')]);
    seed(w.task, [fact('a.mjs', 200, 'task-writer', 'a.mjs:same-key')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1', conflictPolicy: 'keep-existing' });
    assert.equal(res.ok, true);
    assert.equal(res.conflicts, 1);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 1);
    assert.equal(repo[0]['ts'], 100, 'existing repo fact kept');
  } finally {
    w.cleanup();
  }
});

test('conflict — keep-incoming replaces with task fact', async () => {
  const w = ws();
  try {
    seed(w.repo, [fact('a.mjs', 100, 'repo-writer', 'a.mjs:same-key')]);
    seed(w.task, [fact('a.mjs', 200, 'task-writer', 'a.mjs:same-key')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1', conflictPolicy: 'keep-incoming' });
    assert.equal(res.ok, true);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 1);
    assert.equal(repo[0]['ts'], 200, 'task fact wins');
  } finally {
    w.cleanup();
  }
});

test('conflict — keep-both keeps both entries', async () => {
  const w = ws();
  try {
    seed(w.repo, [fact('a.mjs', 100, 'repo-writer')]);
    seed(w.task, [fact('a.mjs', 200, 'task-writer')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1', conflictPolicy: 'keep-both' });
    assert.equal(res.ok, true);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 2, 'both entries present');
  } finally {
    w.cleanup();
  }
});

test('same source with different keys does not conflict and both entries survive', async () => {
  const w = ws();
  try {
    seed(w.repo, [fact('a.mjs', 100, 'repo-writer', 'a.mjs:oldkey12')]);
    seed(w.task, [fact('a.mjs', 200, 'task-writer', 'a.mjs:newkey34')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1', conflictPolicy: 'keep-incoming' });
    assert.equal(res.ok, true);
    assert.equal(res.conflicts, 0);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 2);
  } finally {
    w.cleanup();
  }
});

test('original writer and ts preserved verbatim', async () => {
  const w = ws();
  try {
    seed(w.task, [fact('a.mjs', 12345, 'original-writer')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1' });
    assert.equal(res.ok, true);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo[0]['ts'], 12345, 'ts preserved');
    assert.equal(repo[0]['writer'], 'original-writer', 'writer preserved');
    assert.equal(repo[0]['taskId'], 't1', 'taskId added');
    assert.ok(typeof repo[0]['promotedTs'] === 'number', 'promotedTs added');
  } finally {
    w.cleanup();
  }
});

test('empty task ledger — promoted 0, no crash, task ledger removed', async () => {
  const w = ws();
  try {
    writeFileSync(w.task, '', 'utf8');
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1' });
    assert.equal(res.ok, true);
    assert.equal(res.promoted, 0);
  } finally {
    w.cleanup();
  }
});

test('resolveConflict — policy semantics', () => {
  const e = fact('a.mjs', 1, 'repo');
  const i = fact('a.mjs', 2, 'task');
  assert.equal(resolveConflict(e, i, 'keep-existing').winner, e);
  assert.equal(resolveConflict(e, i, 'keep-incoming').winner, i);
  assert.equal(resolveConflict(e, i, 'keep-both').loser, null);
});

// ---- FO-6: discovery facts ride the same transactional promote ----

/**
 * A discovery fact as written by writeDiscoveryFacts (tool marker + digest).
 * @param {string} source
 * @param {number} ts
 * @param {string} [key]
 * @returns {FactEntry}
 */
function discoveryFact(source, ts, key = `${source}:claim0001`) {
  return /** @type {FactEntry} */ (/** @type {unknown} */ ({
    event: 'fact', key, source, tool: 'discovery-merge', lane: 'feature',
    tags: ['ext:mjs', 'dir:lib'], summary: 'a discovery claim', confidence: 0.9,
    ts, stepId: 'merge-discovery', firstEdit: false, contentDigest: 'abcd1234abcd1234',
  }));
}

test('mixed edit + discovery facts promote together, discovery kind and digest preserved', async () => {
  const w = ws();
  try {
    seed(w.task, [fact('lib/a.mjs', 1), discoveryFact('lib/b.mjs', 2)]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't1' });
    assert.equal(res.ok, true);
    assert.equal(res.promoted, 2);
    assert.equal(existsSync(w.task), false, 'task ledger deleted');

    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 2);
    const discovery = repo.find((e) => e['tool'] === 'discovery-merge');
    assert.ok(discovery, 'discovery fact promoted');
    assert.equal(discovery['contentDigest'], 'abcd1234abcd1234', 'freshness anchor preserved');
    assert.equal(discovery['taskId'], 't1');
  } finally {
    w.cleanup();
  }
});

test('keep-incoming replaces a same-key discovery fact — newer discovery supersedes older', async () => {
  const w = ws();
  try {
    seed(w.repo, [discoveryFact('lib/b.mjs', 1, 'lib/b.mjs:claim0001')]);
    seed(w.task, [discoveryFact('lib/b.mjs', 50, 'lib/b.mjs:claim0001')]);
    const res = await promoteLedger(w.task, w.repo, { taskId: 't2' });
    assert.equal(res.ok, true);
    assert.equal(res.conflicts, 1);
    const repo = readLedger(w.repo).filter((e) => e['event'] === 'fact');
    assert.equal(repo.length, 1, 'replaced, not duplicated');
    assert.equal(repo[0]['ts'], 50, 'incoming (newer) discovery fact won');
  } finally {
    w.cleanup();
  }
});
