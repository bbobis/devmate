// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-state-writers.mjs';

/**
 * Create a throwaway repo root whose allowlist is `allowed`.
 * @param {Record<string,string>} allowed
 * @returns {{ root: string, cleanup: () => void }}
 */
function seedRoot(allowed) {
  const root = mkdtempSync(join(tmpdir(), 'state-writers-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'state-writer-allowlist.json'), JSON.stringify({ allowed }), 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Write one source file (creating parents) under the root.
 * @param {string} root
 * @param {string} rel  Repo-relative path.
 * @param {string} text
 * @returns {void}
 */
function writeSource(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

test('check-state-writers main — passes when the allowlist exactly covers callers', async () => {
  const { root, cleanup } = seedRoot({ 'lib/task-state.mjs': 'home' });
  try {
    writeSource(root, 'lib/task-state.mjs', 'export function writeTaskState() {}\nwriteTaskState();');
    assert.equal(await main([], { rootOverride: root }), 0);
  } finally {
    cleanup();
  }
});

test('check-state-writers main — fails on an unlisted caller', async () => {
  const { root, cleanup } = seedRoot({ 'lib/task-state.mjs': 'home' });
  try {
    writeSource(root, 'lib/task-state.mjs', 'export function writeTaskState() {}');
    writeSource(root, 'hooks/rogue.mjs', 'await writeTaskState(s, p);');
    assert.equal(await main([], { rootOverride: root }), 1, 'a new direct writer must fail CI');
  } finally {
    cleanup();
  }
});

test('check-state-writers main — fails on a stale allowlist entry', async () => {
  const { root, cleanup } = seedRoot({ 'lib/task-state.mjs': 'home', 'lib/migrated.mjs': 'no longer a writer' });
  try {
    writeSource(root, 'lib/task-state.mjs', 'writeTaskState();');
    writeSource(root, 'lib/migrated.mjs', 'await mutateTaskStateUnderLock(fn, p);');
    assert.equal(await main([], { rootOverride: root }), 1, 'a migrated writer left in the allowlist must fail CI');
  } finally {
    cleanup();
  }
});

test('check-state-writers main — the real repo allowlist covers the real tree', async () => {
  // Guards against this test file drifting from the shipped allowlist: run the
  // guard against the actual repo root (default), which must be green.
  assert.equal(await main([]), 0);
});
