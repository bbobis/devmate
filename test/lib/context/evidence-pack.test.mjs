// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPack,
  addPointer,
  loadSlice,
  serializePack,
  BudgetExceededError,
  SliceReadError,
} from '../../../lib/context/evidence-pack.mjs';

/**
 * @param {Partial<import('../../../lib/types.mjs').EvidencePointer>} [over]
 * @returns {import('../../../lib/types.mjs').EvidencePointer}
 */
function ptr(over = {}) {
  return {
    path: over.path ?? 'src/a.mjs',
    lineRange: over.lineRange ?? null,
    reason: over.reason ?? 'relevant',
    confidence: over.confidence ?? 0.8,
    freshness: over.freshness ?? new Date().toISOString(),
    kind: over.kind ?? 'file',
  };
}

test('createPack — creates empty pack with correct maxSources and taskId', () => {
  const pack = createPack({ taskId: 't1', stage: 'discovery', maxSources: 3 });
  assert.equal(pack.taskId, 't1');
  assert.equal(pack.stage, 'discovery');
  assert.equal(pack.maxSources, 3);
  assert.deepEqual(pack.pointers, []);
});

test('addPointer — adds pointer within budget', () => {
  let pack = createPack({ taskId: 't1', stage: 's', maxSources: 2 });
  pack = addPointer(pack, ptr());
  assert.equal(pack.pointers.length, 1);
});

test('addPointer — throws BudgetExceededError when pack is full', () => {
  let pack = createPack({ taskId: 't1', stage: 'discovery', maxSources: 1 });
  pack = addPointer(pack, ptr());
  assert.throws(() => addPointer(pack, ptr()), BudgetExceededError);
});

test('addPointer — rejects confidence > 1.0', () => {
  const pack = createPack({ taskId: 't1', stage: 's', maxSources: 3 });
  assert.throws(() => addPointer(pack, ptr({ confidence: 1.5 })), /confidence/);
});

test('addPointer — rejects empty reason', () => {
  const pack = createPack({ taskId: 't1', stage: 's', maxSources: 3 });
  assert.throws(() => addPointer(pack, ptr({ reason: '' })), /reason/);
});

test('addPointer — is immutable, original pack unchanged', () => {
  const pack = createPack({ taskId: 't1', stage: 's', maxSources: 3 });
  const next = addPointer(pack, ptr());
  assert.equal(pack.pointers.length, 0);
  assert.equal(next.pointers.length, 1);
  assert.notEqual(pack, next);
});

test('loadSlice — returns full file when lineRange is null', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'evidence-'));
  const path = join(dir, 'f.txt');
  await fsp.writeFile(path, 'a\nb\nc\n', 'utf8');
  const out = await loadSlice(ptr({ path, lineRange: null }));
  assert.equal(out, 'a\nb\nc\n');
});

test('loadSlice — returns correct line range from temp file', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'evidence-'));
  const path = join(dir, 'f.txt');
  await fsp.writeFile(path, 'l1\nl2\nl3\nl4\nl5', 'utf8');
  const out = await loadSlice(ptr({ path, lineRange: [2, 4] }));
  assert.equal(out, 'l2\nl3\nl4');
});

test('loadSlice — throws SliceReadError on missing file', async () => {
  await assert.rejects(
    loadSlice(ptr({ path: join(tmpdir(), 'does-not-exist-xyz.txt') })),
    SliceReadError,
  );
});

test('loadSlice — throws SliceReadError when endLine exceeds file length', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'evidence-'));
  const path = join(dir, 'f.txt');
  await fsp.writeFile(path, 'one\ntwo', 'utf8');
  await assert.rejects(
    loadSlice(ptr({ path, lineRange: [1, 99] })),
    SliceReadError,
  );
});

test('serializePack — produces valid JSON without pretty-print', () => {
  let pack = createPack({ taskId: 't1', stage: 's', maxSources: 3 });
  pack = addPointer(pack, ptr());
  const s = serializePack(pack);
  assert.doesNotThrow(() => JSON.parse(s));
  assert.ok(!s.includes('\n  '), 'should not contain pretty-print indentation');
});
