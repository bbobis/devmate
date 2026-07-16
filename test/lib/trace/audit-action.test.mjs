// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditAction, actionDigest } from '../../../lib/trace/audit-action.mjs';
import { traceFilePath } from '../../../lib/trace/append.mjs';

/** @returns {Promise<string>} a fresh tmp root dir */
async function makeTmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-audit-'));
}

/**
 * Read the non-empty JSONL lines of a task's trace file.
 * @param {string} taskId
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function readLines(taskId, root) {
  const contents = await fsp.readFile(traceFilePath(taskId, root), 'utf8');
  return contents.split('\n').filter((l) => l.length > 0);
}

const HEX16 = /^[0-9a-f]{16}$/;

test('happy path: one action line with correct fields; digest is 16 hex; no path content', async () => {
  const root = await makeTmpRoot();
  /** @type {import('../../../lib/types.mjs').AuditActionEntry} */
  const entry = { taskId: 'feat-9', stepId: 'step-1', actionType: 'write', path: 'src/secret.mjs' };

  const res = await auditAction(entry, { root });
  assert.equal(res.ok, true);
  assert.equal(res.lineNumber, 1);

  const lines = await readLines('feat-9', root);
  assert.equal(lines.length, 1);

  const ev = JSON.parse(lines[0]);
  assert.equal(ev.type, 'action');
  assert.equal(ev.taskId, 'feat-9');
  assert.equal(ev.stepId, 'step-1');
  assert.equal(ev.actionType, 'write');
  assert.equal(ev.path, 'src/secret.mjs');
  assert.equal(ev.schemaVersion, 1);
  assert.equal(typeof ev.ts, 'string');
  assert.ok(ev.ts.length > 0);

  // digest is exactly 16 hex chars and derived from path + actionType only.
  assert.match(ev.digest, HEX16);
  const expected = createHash('sha256')
    .update('src/secret.mjs|write')
    .digest('hex')
    .slice(0, 16);
  assert.equal(ev.digest, expected);
  assert.equal(ev.digest, actionDigest('src/secret.mjs', 'write'));
});

test('20 parallel calls with same taskId → exactly 20 valid, non-interleaved lines', async () => {
  const root = await makeTmpRoot();

  /** @type {Promise<{ok:boolean, lineNumber:number}>[]} */
  const calls = [];
  for (let i = 0; i < 20; i++) {
    calls.push(
      auditAction(
        { taskId: 'feat-par', stepId: `step-${i}`, actionType: 'write', path: `f${i}.mjs` },
        { root }
      )
    );
  }
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok));

  // Line numbers are exactly 1..20 with no duplicates.
  const nums = results.map((r) => r.lineNumber).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1));

  const lines = await readLines('feat-par', root);
  assert.equal(lines.length, 20);
  // Every line parses as a complete JSON object (no interleaving / partial writes).
  for (const l of lines) {
    const ev = JSON.parse(l);
    assert.equal(ev.type, 'action');
    assert.match(ev.digest, HEX16);
  }
});

test('invalid entry (missing stepId) → ok:false and file unchanged', async () => {
  const root = await makeTmpRoot();
  // Seed one valid line so we can assert the file is not modified afterward.
  await auditAction({ taskId: 'feat-bad', stepId: 'ok-1', actionType: 'write', path: 'a.mjs' }, { root });
  const filePath = traceFilePath('feat-bad', root);
  const before = await fsp.readFile(filePath, 'utf8');

  const bad = /** @type {any} */ ({ taskId: 'feat-bad', actionType: 'write', path: 'b.mjs' });
  const res = await auditAction(bad, { root });
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.errors) && res.errors.length > 0);

  const after = await fsp.readFile(filePath, 'utf8');
  assert.equal(after, before, 'file must be unchanged after a rejected audit');
});
