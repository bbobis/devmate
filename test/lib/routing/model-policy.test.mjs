// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_MODEL_ROLES,
  loadModelPolicy,
  validateModelPolicy,
  routeModel,
  routeWorkerModel,
} from '../../../lib/routing/model-policy.mjs';

/** @typedef {import('../../../lib/types.mjs').ModelPolicy} ModelPolicy */

/**
 * Build a valid policy fixture. Pass overrides per class.
 * @param {Partial<Record<'tiny'|'standard'|'large', import('../../../lib/types.mjs').ModelEntry>>} [over]
 * @returns {ModelPolicy}
 */
function makePolicy(over = {}) {
  return {
    schemaVersion: 1,
    byBudgetClass: {
      tiny: over.tiny ?? { modelId: 'verified-tiny', verifiedAt: '2026-01-01', source: 'https://docs' },
      standard: over.standard ?? {
        modelId: 'verified-standard',
        verifiedAt: '2026-01-01',
        source: 'https://docs',
      },
      large: over.large ?? {
        modelId: 'verified-large',
        verifiedAt: '2026-01-01',
        source: 'https://docs',
      },
    },
  };
}

/**
 * Write a policy object to a temp file and return its path.
 * @param {unknown} obj
 * @returns {Promise<string>}
 */
async function writePolicy(obj) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'model-policy-'));
  const p = join(dir, 'model-policy.json');
  await fsp.writeFile(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('model-policy › loadModelPolicy returns parsed policy', async () => {
  const path = await writePolicy(makePolicy());
  const policy = await loadModelPolicy({ policyPath: path });
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.byBudgetClass.large.modelId, 'verified-large');
});

test('model-policy › validateModelPolicy passes for valid policy', () => {
  const { ok, errors } = validateModelPolicy(makePolicy());
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test('model-policy › validateModelPolicy fails missing byBudgetClass.large', () => {
  const policy = makePolicy();
  // @ts-ignore — deliberately break the shape for the test
  delete policy.byBudgetClass.large;
  const { ok, errors } = validateModelPolicy(policy);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('large')));
});

test('model-policy › routeModel returns PolicyRoute when verified', () => {
  const route = routeModel('tiny', makePolicy());
  assert.equal(route.budgetClass, 'tiny');
  assert.equal(route.modelId, 'verified-tiny');
  assert.equal(route.verified, true);
});

test('model-policy › routeModel throws when verifiedAt=null', () => {
  const policy = makePolicy({ tiny: { modelId: '[UNVERIFIED — x]', verifiedAt: null } });
  assert.throws(
    () => routeModel('tiny', policy),
    /Model ID for tiny is \[UNVERIFIED\]\. Set verifiedAt before routing in production\./
  );
});

test('model-policy › routeModel passes when allowUnverified=true', () => {
  const policy = makePolicy({ tiny: { modelId: 'experimental', verifiedAt: null } });
  const route = routeModel('tiny', policy, { allowUnverified: true });
  assert.equal(route.modelId, 'experimental');
  assert.equal(route.verified, false);
});

test('model-policy › loadModelPolicy throws on malformed JSON', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'model-policy-bad-'));
  const p = join(dir, 'model-policy.json');
  await fsp.writeFile(p, '{ not valid json', 'utf8');
  await assert.rejects(loadModelPolicy({ policyPath: p }), /Invalid JSON/);
});

test('model-policy › the committed config is all-[UNVERIFIED] placeholders', async () => {
  // Anti-hallucination invariant: the real config must never ship a usable
  // (verified) model ID. It must stay placeholder-only until a human verifies.
  const policy = await loadModelPolicy();
  for (const entry of Object.values(policy.byBudgetClass)) {
    assert.equal(entry.verifiedAt, null, 'committed entries must be unverified');
    assert.ok(entry.modelId.includes('[UNVERIFIED'), 'committed modelId must be a placeholder');
  }
});

// ---- FO-7: per-worker role routing ----

test('model-policy › KNOWN_MODEL_ROLES names exactly discoveryWorker', () => {
  assert.deepEqual([...KNOWN_MODEL_ROLES], ['discoveryWorker']);
});

test('model-policy › validateModelPolicy accepts a valid roles block', () => {
  const policy = {
    ...makePolicy(),
    roles: {
      discoveryWorker: { modelId: '[UNVERIFIED — x]', verifiedAt: null, rationale: 'read-only search' },
    },
  };
  const { ok, errors } = validateModelPolicy(policy);
  assert.equal(ok, true, errors.join('; '));
});

test('model-policy › validateModelPolicy stays valid without a roles block (optional)', () => {
  const { ok } = validateModelPolicy(makePolicy());
  assert.equal(ok, true);
});

test('model-policy › validateModelPolicy rejects an unknown role name', () => {
  const policy = {
    ...makePolicy(),
    roles: { fixerWorker: { modelId: 'x', verifiedAt: null } },
  };
  const { ok, errors } = validateModelPolicy(policy);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('roles.fixerWorker is not a known model role')));
});

test('model-policy › validateModelPolicy rejects a malformed role entry', () => {
  for (const [entry, expected] of /** @type {[unknown, string][]} */ ([
    [{ verifiedAt: null }, 'roles.discoveryWorker.modelId must be a non-empty string'],
    [{ modelId: '', verifiedAt: null }, 'roles.discoveryWorker.modelId must be a non-empty string'],
    [{ modelId: 'x', verifiedAt: 42 }, 'roles.discoveryWorker.verifiedAt must be a string or null'],
    [null, 'roles.discoveryWorker is missing or not an object'],
  ])) {
    const policy = { ...makePolicy(), roles: { discoveryWorker: entry } };
    const { ok, errors } = validateModelPolicy(policy);
    assert.equal(ok, false, JSON.stringify(entry));
    assert.ok(errors.some((e) => e.includes(expected)), `${JSON.stringify(entry)} → ${errors.join('; ')}`);
  }
});

test('model-policy › validateModelPolicy rejects a non-object roles block', () => {
  for (const bad of ['discoveryWorker', ['discoveryWorker'], 42]) {
    const { ok, errors } = validateModelPolicy({ ...makePolicy(), roles: bad });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('roles must be an object when present')));
  }
});

test('model-policy › routeWorkerModel returns RolePolicyRoute when verified', () => {
  const policy = {
    ...makePolicy(),
    roles: { discoveryWorker: { modelId: 'verified-worker', verifiedAt: '2026-01-01', source: 'https://docs' } },
  };
  const route = routeWorkerModel('discoveryWorker', policy);
  assert.deepEqual(route, { role: 'discoveryWorker', modelId: 'verified-worker', verified: true });
});

test('model-policy › routeWorkerModel throws when verifiedAt=null', () => {
  const policy = {
    ...makePolicy(),
    roles: { discoveryWorker: { modelId: '[UNVERIFIED — x]', verifiedAt: null } },
  };
  assert.throws(
    () => routeWorkerModel('discoveryWorker', policy),
    /Model ID for role discoveryWorker is \[UNVERIFIED\]\. Set verifiedAt before routing in production\./
  );
});

test('model-policy › routeWorkerModel passes when allowUnverified=true', () => {
  const policy = {
    ...makePolicy(),
    roles: { discoveryWorker: { modelId: 'experimental-worker', verifiedAt: null } },
  };
  const route = routeWorkerModel('discoveryWorker', policy, { allowUnverified: true });
  assert.equal(route.modelId, 'experimental-worker');
  assert.equal(route.verified, false);
});

test('model-policy › routeWorkerModel throws when the policy has no entry for the role', () => {
  assert.throws(
    () => routeWorkerModel('discoveryWorker', makePolicy()),
    /No model policy entry for role 'discoveryWorker'\./
  );
  assert.throws(
    () => routeWorkerModel('discoveryWorker', { ...makePolicy(), roles: {} }),
    /No model policy entry for role 'discoveryWorker'\./
  );
});

test('model-policy › the committed config roles block is all-[UNVERIFIED] placeholders', async () => {
  // Same anti-hallucination invariant as the class map: no committed role
  // may ship a usable (verified) model ID.
  const policy = await loadModelPolicy();
  assert.ok(policy.roles, 'committed config declares a roles block (FO-7)');
  for (const entry of Object.values(policy.roles ?? {})) {
    if (entry === undefined) continue;
    assert.equal(entry.verifiedAt, null, 'committed role entries must be unverified');
    assert.ok(entry.modelId.includes('[UNVERIFIED'), 'committed role modelId must be a placeholder');
  }
});
