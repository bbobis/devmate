// @ts-check
/**
 * E8-3: tests for recordWorktreeTelemetry. Writes to a temp ledger so the real
 * evals/telemetry/worktrees.jsonl is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorktreeTelemetry } from '../../../lib/worktree/telemetry.mjs';

/** @typedef {import('../../../lib/types.mjs').WorktreeHandle} WorktreeHandle */
/** @typedef {import('../../../lib/types.mjs').WorktreeTelemetry} WorktreeTelemetry */

/**
 * Make a unique temp ledger path (inside a not-yet-created subdir, to prove the
 * directory is auto-created on first write).
 * @returns {Promise<string>}
 */
async function tempLedger() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'wt-tel-'));
  return join(dir, 'nested', 'worktrees.jsonl');
}

/**
 * @param {string} branch
 * @returns {WorktreeHandle}
 */
function makeHandle(branch) {
  return {
    branchName: branch,
    worktreePath: `/tmp/${branch}`,
    baseRef: 'main',
    createdAt: new Date().toISOString(),
    active: true,
    repoRoot: '/tmp',
  };
}

test('telemetry › appends entry to worktrees.jsonl', async () => {
  const ledgerPath = await tempLedger();
  const handle = makeHandle('devmate/tel-1');
  await recordWorktreeTelemetry(
    handle,
    { branchName: 'devmate/tel-1', durationMs: 1234, filesChanged: 3, cleanedUp: true },
    { ledgerPath }
  );

  const text = await fsp.readFile(ledgerPath, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.branchName, 'devmate/tel-1');
  assert.equal(entry.durationMs, 1234);
  assert.equal(entry.filesChanged, 3);
  assert.equal(entry.cleanedUp, true);
  assert.ok(typeof entry.timestamp === 'string' && entry.timestamp.length > 0);
});
