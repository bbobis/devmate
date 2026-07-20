// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCommittedMemory, main } from '../../scripts/check-memory.mjs';
import { FACTS_START, FACTS_END, MEMORY_MD_SOFT_LINE_CAP } from '../../lib/memory/render-memory.mjs';

const WELL_FORMED = [
  '# Memory index',
  '',
  FACTS_START,
  '## discovery',
  '- a promoted fact (task: t1, added: 2026-01-01T00:00:00.000Z)',
  FACTS_END,
  '',
].join('\n');

test('evaluateCommittedMemory › a well-formed committed file is clean', () => {
  const r = evaluateCommittedMemory(WELL_FORMED);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('evaluateCommittedMemory › a seed with no facts block yet is clean', () => {
  const r = evaluateCommittedMemory('# Memory index\n\n(no promoted facts yet)\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('evaluateCommittedMemory › a half-present block (start only) fails', () => {
  const r = evaluateCommittedMemory(`# Memory\n${FACTS_START}\n## x\n- fact\n`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /malformed facts block/);
});

test('evaluateCommittedMemory › a half-present block (end only) fails', () => {
  const r = evaluateCommittedMemory(`# Memory\n## x\n- fact\n${FACTS_END}\n`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /malformed facts block/);
});

test('evaluateCommittedMemory › reversed markers fail', () => {
  const r = evaluateCommittedMemory(`${FACTS_END}\n## x\n${FACTS_START}\n`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /start marker appears after the end marker/);
});

test('evaluateCommittedMemory › duplicated markers (merge-conflict artifact) fail', () => {
  // START … END … START — a classic merge-conflict leftover the first-index
  // check would miss; the count-based check rejects it.
  const dup = `${FACTS_START}\n## a\n${FACTS_END}\n${FACTS_START}\n## b\n${FACTS_END}\n`;
  const r = evaluateCommittedMemory(dup);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /exactly one start and one end sentinel/);
});

test('evaluateCommittedMemory › over the render soft cap fails', () => {
  const oversize = Array.from({ length: MEMORY_MD_SOFT_LINE_CAP + 1 }, (_, i) => `line ${i}`).join('\n');
  const r = evaluateCommittedMemory(oversize);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /over the render soft cap/);
});

test('evaluateCommittedMemory › exactly at the soft cap passes', () => {
  const atCap = Array.from({ length: MEMORY_MD_SOFT_LINE_CAP }, (_, i) => `line ${i}`).join('\n');
  const r = evaluateCommittedMemory(atCap);
  assert.equal(r.ok, true);
});

test('evaluateCommittedMemory › a secret-like token fails', () => {
  const r = evaluateCommittedMemory(`${WELL_FORMED}\nAPI_TOKEN=supersecretvalue1234567890`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /secret-like token/);
});

test('evaluateCommittedMemory › a bare commit SHA is NOT flagged as a secret', () => {
  // Committed memory legitimately references commits; a 40-hex SHA after a colon
  // must not trip the base64-after-delimiter rule (the pre-scan de-hash guard).
  const sha40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
  const sha64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const r = evaluateCommittedMemory(`${WELL_FORMED}\n- fixed in commit: ${sha40} and tree: ${sha64}`);
  assert.equal(r.ok, true, r.violations.join('; '));
});

test('evaluateCommittedMemory › a bare provider token (ghp_) is flagged (#222)', () => {
  const r = evaluateCommittedMemory(`${WELL_FORMED}\n- see token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /secret-like token/);
});

test('evaluateCommittedMemory › a named secret with a hex value is still flagged', () => {
  // De-hashing must not blind the named-credential rule: SECRET_KEY=<hex> still fails.
  const r = evaluateCommittedMemory(`SECRET_KEY=a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4`);
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /secret-like token/);
});

test('evaluateCommittedMemory › aggregates multiple violations', () => {
  const oversizeLines = Array.from({ length: MEMORY_MD_SOFT_LINE_CAP + 1 }, (_, i) => `line ${i}`);
  oversizeLines.push('AWS_SECRET_KEY=abcdef1234567890zzz');
  oversizeLines.push(FACTS_START); // start with no end
  const r = evaluateCommittedMemory(oversizeLines.join('\n'));
  assert.equal(r.ok, false);
  assert.ok(r.violations.length >= 3, `expected >=3 violations, got ${r.violations.length}`);
});

test('evaluateCommittedMemory › non-string input does not throw', () => {
  // @ts-expect-error deliberately wrong type
  const r = evaluateCommittedMemory(null);
  assert.equal(r.ok, true);
});

test('main › a missing committed file is not a failure (exit 0)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'check-memory-none-'));
  assert.equal(await main([root]), 0);
});

test('main › a clean committed file exits 0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'check-memory-clean-'));
  await mkdir(join(root, '.devmate'), { recursive: true });
  await writeFile(join(root, '.devmate', 'MEMORY.md'), WELL_FORMED, 'utf8');
  assert.equal(await main([root]), 0);
});

test('main › a committed file with a secret exits 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'check-memory-secret-'));
  await mkdir(join(root, '.devmate'), { recursive: true });
  await writeFile(
    join(root, '.devmate', 'MEMORY.md'),
    `${WELL_FORMED}\nDATABASE_PASSWORD=hunter2hunter2hunter2xy`,
    'utf8',
  );
  assert.equal(await main([root]), 1);
});
