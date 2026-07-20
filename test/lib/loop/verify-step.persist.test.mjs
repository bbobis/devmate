// @ts-check
/**
 * #132: persistVerifyResult stamps the owning taskId onto verify-result.json, so
 * the pass-verification precondition can refuse a prior task's stale evidence
 * (the specDigest guard is vacuous on the lanes that write no spec). Absence is
 * preserved when the owner is unknown, so the precondition's lenient
 * reject-on-mismatch-only rule is never turned into a false wedge.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { persistVerifyResult } from '../../../lib/loop/verify-step.mjs';

/**
 * A temp `.devmate/state` seeded with the given task.json body.
 * @param {Record<string, unknown>} taskJson
 * @returns {{ dir: string, stateDir: string }}
 */
function seedStateDir(taskJson) {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-verify-persist-'));
  const stateDir = join(dir, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'task.json'), JSON.stringify(taskJson), 'utf8');
  return { dir, stateDir };
}

test('persistVerifyResult stamps the owning taskId read from task.json', async () => {
  const { dir, stateDir } = seedStateDir({ taskId: 'T-owner', artifactHashes: { specDigest: 'abc' } });
  try {
    const path = await persistVerifyResult({ passed: true, digest: 'd', fullOutputPath: 'f' }, { stateDir });
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(artifact.taskId, 'T-owner');
    assert.equal(artifact.specDigest, 'abc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistVerifyResult omits taskId when task.json declares none (leniency preserved)', async () => {
  const { dir, stateDir } = seedStateDir({ artifactHashes: {} });
  try {
    const path = await persistVerifyResult({ passed: true, digest: 'd', fullOutputPath: 'f' }, { stateDir });
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(!('taskId' in artifact), 'taskId must be absent (not "") when the owner is unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistVerifyResult honors an explicit taskId override', async () => {
  const { dir, stateDir } = seedStateDir({ taskId: 'T-from-state' });
  try {
    const path = await persistVerifyResult(
      { passed: true, digest: 'd', fullOutputPath: 'f' },
      { stateDir, taskId: 'T-explicit' },
    );
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(artifact.taskId, 'T-explicit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
