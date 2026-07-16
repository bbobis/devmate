// @ts-check
/**
 * E9-13: `gatectl workflow set pass-verification` refuses without a fresh,
 * passing, spec-matching verify-result.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as gatectlMain } from '../../scripts/gatectl.mjs';
import { MAX_VERIFY_AGE_MS } from '../../lib/gate-preconditions.mjs';

/** Silence stdio during a run. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/**
 * Run gatectl main() from a temp repo root containing the given state files.
 * @param {Record<string, unknown>} state       task.json contents
 * @param {Record<string, unknown>|null} verify verify-result.json contents (null = absent)
 * @returns {Promise<{ code: number, out: string }>}
 */
async function runGatectl(state, verify) {
  const root = await mkdtemp(join(tmpdir(), 'gatectl-ve-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'task.json'), JSON.stringify(state), 'utf8');
  if (verify !== null) {
    await writeFile(join(stateDir, 'verify-result.json'), JSON.stringify(verify), 'utf8');
  }

  /** @type {string[]} */
  const chunks = [];
  const capture = /** @type {typeof process.stdout.write} */ ((c) => {
    chunks.push(String(c));
    return true;
  });
  const prevCwd = process.cwd();
  process.stdout.write = capture;
  process.stderr.write = capture;
  let code;
  try {
    process.chdir(root);
    code = await gatectlMain(['workflow', 'set', 'pass-verification']);
  } finally {
    process.chdir(prevCwd);
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join('') };
}

/** @returns {Record<string, unknown>} */
function implStartedState() {
  return {
    taskId: 't-ve',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 1,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
  };
}

/** @param {Partial<import('../../lib/types.mjs').VerifyResultArtifact>} [over] */
function freshArtifact(over = {}) {
  return {
    passed: true,
    digest: 'all green',
    fullOutputPath: '/tmp/full.log',
    completedAt: new Date().toISOString(),
    specDigest: '',
    ...over,
  };
}

test('pass-verification refused with no artifact', async () => {
  const { code, out } = await runGatectl(implStartedState(), null);
  assert.equal(code, 1);
  assert.match(out, /verify evidence/i);
});

test('refused with mismatched specDigest', async () => {
  const state = implStartedState();
  state.artifactHashes = { spec: 'spec.md', specDigest: 'abc123' };
  const { code, out } = await runGatectl(state, freshArtifact({ specDigest: 'different' }));
  assert.equal(code, 1);
  assert.match(out, /specDigest/);
});

test('refused when stale', async () => {
  const stale = new Date(Date.now() - MAX_VERIFY_AGE_MS - 60_000).toISOString();
  const { code, out } = await runGatectl(implStartedState(), freshArtifact({ completedAt: stale }));
  assert.equal(code, 1);
  assert.match(out, /stale/i);
});

test('refused when the run failed', async () => {
  const { code, out } = await runGatectl(implStartedState(), freshArtifact({ passed: false }));
  assert.equal(code, 1);
  assert.match(out, /failing run/i);
});

test('allowed with fresh passing artifact', async () => {
  const { code, out } = await runGatectl(implStartedState(), freshArtifact());
  assert.equal(code, 0);
  assert.match(out, /impl-started → verification-passed/);
});

test('allowed with matching specDigest', async () => {
  const state = implStartedState();
  state.artifactHashes = { spec: 'spec.md', specDigest: 'abc123' };
  const { code } = await runGatectl(state, freshArtifact({ specDigest: 'abc123' }));
  assert.equal(code, 0);
});
