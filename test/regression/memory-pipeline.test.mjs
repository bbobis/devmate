// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} relPath
 * @returns {string}
 */
function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

test('memory pipeline regression: post-tool-use no longer uses DEFAULT_LEDGER_REL or facts.jsonl', () => {
  const src = read('hooks/post-tool-use.mjs');
  assert.equal(src.includes('DEFAULT_LEDGER_REL'), false);
  assert.equal(src.includes('.devmate/state/facts.jsonl'), false);
});

test('memory pipeline regression: hook and complete-task import central paths module', () => {
  const hookSrc = read('hooks/post-tool-use.mjs');
  const completeTaskSrc = read('scripts/complete-task.mjs');
  assert.equal(hookSrc.includes("../lib/memory/paths.mjs"), true);
  assert.equal(completeTaskSrc.includes("../lib/memory/paths.mjs"), true);
});

test('memory pipeline regression: capture helper promotes before render', () => {
  // The promote-before-render step is shared via lib/memory/capture.mjs so the
  // PreCompact and Stop triggers can never drift. The ordering invariant
  // (promote first, then render — spec Bug 6) lives there now.
  const src = read('lib/memory/capture.mjs');
  const promoteIdx = src.indexOf('promoteLedger(');
  const renderIdx = src.indexOf('renderMemory(');
  assert.ok(promoteIdx !== -1, 'captureMemory must call promoteLedger');
  assert.ok(renderIdx !== -1, 'captureMemory must call renderMemory');
  assert.ok(renderIdx > promoteIdx, 'renderMemory must appear after promoteLedger');
});

test('memory pipeline regression: PreCompact and Stop both capture via the shared helper', () => {
  // Both the PreCompact hook and the (formerly stub) Stop hook must promote +
  // render so a normal session end no longer strands facts.
  const compactSrc = read('scripts/compact-session.mjs');
  const stopSrc = read('scripts/session-stop.mjs');
  assert.equal(compactSrc.includes('captureMemory('), true, 'compact-session must call captureMemory');
  assert.equal(stopSrc.includes('captureMemory('), true, 'session-stop must call captureMemory');
});

test('memory pipeline regression: FactEntry typedef includes key field', () => {
  const src = read('lib/types.mjs');
  assert.equal(src.includes('@property {string}   key'), true);
});

test('memory pipeline regression: promote uses key-based conflict identity', () => {
  const src = read('lib/memory/promote.mjs');
  assert.equal(src.includes('function factKey('), true);
  assert.equal(src.includes('repoByKey'), true);
});

test('memory pipeline regression: active facts helper shared by promote and render', () => {
  const promoteSrc = read('lib/memory/promote.mjs');
  const renderSrc = read('lib/memory/render-memory.mjs');
  assert.equal(promoteSrc.includes("./active-facts.mjs"), true);
  assert.equal(renderSrc.includes("./active-facts.mjs"), true);
});

test('memory pipeline regression: deprecated lib/memory-path.mjs was removed', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'lib/memory-path.mjs')), false);
});
