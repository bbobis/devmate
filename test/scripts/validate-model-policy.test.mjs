// @ts-check
/**
 * E8-4: tests for the validate-model-policy CI guard. Exercises both the
 * placeholder-blocks-CI path and the fully-verified passes path via temp config
 * files, so the real committed config is never modified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/validate-model-policy.mjs';

/**
 * Write a policy object to a temp file and return its path.
 * @param {unknown} obj
 * @returns {Promise<string>}
 */
async function writePolicy(obj) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'vmp-'));
  const p = join(dir, 'model-policy.json');
  await fsp.writeFile(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('validate-model-policy script › exits 0 for all-placeholder policy (sanctioned shipping state)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
      standard: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
      large: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
    },
  });
  const code = await main([path]);
  assert.equal(code, 0);
});

test('validate-model-policy script › exits 1 for a real modelId without verifiedAt (premature default)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: 'real-tiny', verifiedAt: null },
      standard: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
      large: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
    },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 1 for a placeholder modelId with verifiedAt set (inconsistent)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: '2026-01-01' },
      standard: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
      large: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
    },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 0 for fully verified policy', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: 'real-tiny', verifiedAt: '2026-01-01', source: 'https://docs/tiny' },
      standard: {
        modelId: 'real-standard',
        verifiedAt: '2026-01-01',
        source: 'https://docs/standard',
      },
      large: { modelId: 'real-large', verifiedAt: '2026-01-01', source: 'https://docs/large' },
    },
  });
  const code = await main([path]);
  assert.equal(code, 0);
});

test('validate-model-policy script › exits 1 for verified entry missing source', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: 'real-tiny', verifiedAt: '2026-01-01' },
      standard: { modelId: 'real-standard', verifiedAt: '2026-01-01', source: 'https://docs' },
      large: { modelId: 'real-large', verifiedAt: '2026-01-01', source: 'https://docs' },
    },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 1 for malformed policy file', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'vmp-bad-'));
  const p = join(dir, 'model-policy.json');
  await fsp.writeFile(p, '{ broken', 'utf8');
  const code = await main([p]);
  assert.equal(code, 1);
});

test('validate-model-policy script › committed config exits 0 (explicit placeholders are sanctioned)', async () => {
  // The real config ships placeholder-only on purpose. The guard passes on the
  // explicit-placeholder state (so it can run in CI) while still blocking any
  // real-looking ID that lacks verification.
  const code = await main([]);
  assert.equal(code, 0);
});

// ---- FO-7: the roles block obeys the same rules as class entries ----

/**
 * All-placeholder class map, reused by the role-block cases below.
 * @returns {Record<string, unknown>}
 */
function placeholderClasses() {
  return {
    tiny: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
    standard: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
    large: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null },
  };
}

test('validate-model-policy script › exits 0 for a placeholder roles block (sanctioned shipping state)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: placeholderClasses(),
    roles: {
      discoveryWorker: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null, rationale: 'read-only search' },
    },
  });
  const code = await main([path]);
  assert.equal(code, 0);
});

test('validate-model-policy script › exits 1 for a real role modelId without verifiedAt (premature default)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: placeholderClasses(),
    roles: { discoveryWorker: { modelId: 'real-worker-model', verifiedAt: null } },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 1 for a placeholder role modelId with verifiedAt set (inconsistent)', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: placeholderClasses(),
    roles: { discoveryWorker: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: '2026-01-01' } },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 1 for a verified role entry missing source', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: placeholderClasses(),
    roles: { discoveryWorker: { modelId: 'real-worker-model', verifiedAt: '2026-01-01' } },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 1 for an unknown role name', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: placeholderClasses(),
    roles: { fixerWorker: { modelId: '[UNVERIFIED — set after confirming]', verifiedAt: null } },
  });
  const code = await main([path]);
  assert.equal(code, 1);
});

test('validate-model-policy script › exits 0 for fully verified classes and roles', async () => {
  const path = await writePolicy({
    schemaVersion: 1,
    byBudgetClass: {
      tiny: { modelId: 'real-tiny', verifiedAt: '2026-01-01', source: 'https://docs/tiny' },
      standard: { modelId: 'real-standard', verifiedAt: '2026-01-01', source: 'https://docs/standard' },
      large: { modelId: 'real-large', verifiedAt: '2026-01-01', source: 'https://docs/large' },
    },
    roles: {
      discoveryWorker: { modelId: 'real-worker-model', verifiedAt: '2026-01-01', source: 'https://docs/worker' },
    },
  });
  const code = await main([path]);
  assert.equal(code, 0);
});
