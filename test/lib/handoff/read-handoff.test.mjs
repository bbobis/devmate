// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHandoff, handoffTaskDir } from '../../../lib/handoff/write-handoff.mjs';
import { readHandoff } from '../../../lib/handoff/read-handoff.mjs';

/** @returns {Promise<string>} a fresh tmp handoff dir */
async function makeHandoffDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-readhandoff-'));
}

/** @returns {import('../../../lib/types.mjs').HandoffInput} */
function makeInput(over = {}) {
  return {
    taskId: 'feat-1',
    purpose: 'Ship the trace subsystem.',
    currentState: 'halted',
    decisions: ['Use stepId identity'],
    openQuestions: ['Where to store handoff?'],
    evidencePointers: [
      { kind: 'file', path_or_url: 'lib/x.mjs', why_relevant: 'core', confidence: 'high' },
    ],
    suggestedNextSkill: 'devmate-research',
    blockers: ['b1'],
    ...over,
  };
}

test('round-trip: writeHandoff then readHandoff returns identical logical fields', async () => {
  const handoffDir = await makeHandoffDir();
  const input = makeInput();
  await writeHandoff(input, { handoffDir });
  const got = await readHandoff('feat-1', { handoffDir });
  // Logical fields match the input.
  assert.equal(got.taskId, input.taskId);
  assert.equal(got.purpose, input.purpose);
  assert.equal(got.currentState, input.currentState);
  assert.deepEqual(got.decisions, input.decisions);
  assert.deepEqual(got.openQuestions, input.openQuestions);
  assert.deepEqual(got.evidencePointers, input.evidencePointers);
  assert.equal(got.suggestedNextSkill, input.suggestedNextSkill);
  assert.deepEqual(got.blockers, input.blockers);
  // Stamped fields present.
  assert.equal(got.schemaVersion, 1);
  assert.ok(typeof got.ts === 'string' && got.ts.length > 0);
});

test('missing file → throws with "not found", file system unchanged', async () => {
  const handoffDir = await makeHandoffDir();
  await assert.rejects(() => readHandoff('nope', { handoffDir }), /not found/);
  // Directory remains empty.
  const entries = await fsp.readdir(handoffDir);
  assert.deepEqual(entries, []);
});

test('schema mismatch (missing purpose) → throws naming the missing field, file preserved', async () => {
  const handoffDir = await makeHandoffDir();
  const dir = handoffTaskDir('feat-1', handoffDir);
  await fsp.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, 'handoff.json');
  const bad = {
    taskId: 'feat-1',
    // purpose missing
    currentState: 'halted',
    decisions: [],
    openQuestions: [],
    evidencePointers: [],
    suggestedNextSkill: null,
    blockers: [],
    ts: new Date().toISOString(),
    schemaVersion: 1,
  };
  await fsp.writeFile(jsonPath, JSON.stringify(bad), 'utf8');
  const before = await fsp.readFile(jsonPath, 'utf8');
  await assert.rejects(() => readHandoff('feat-1', { handoffDir }), /purpose/);
  const after = await fsp.readFile(jsonPath, 'utf8');
  assert.equal(after, before, 'file must be preserved on read failure');
});

test('malformed JSON → throws descriptive error', async () => {
  const handoffDir = await makeHandoffDir();
  const dir = handoffTaskDir('feat-1', handoffDir);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'handoff.json'), '{ not json', 'utf8');
  await assert.rejects(() => readHandoff('feat-1', { handoffDir }), /malformed handoff JSON/);
});
