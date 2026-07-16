// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setDependencyGate,
  getDependencyGate,
  listDependencyGates,
  DEP_GATES,
} from '../../lib/dependency-gates.mjs';

/** @returns {{ dir: string, gatePath: string }} */
function makeTmpGates() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-dep-gates-'));
  const gatePath = join(dir, 'gates.json');
  return { dir, gatePath };
}

test('setDependencyGate — valid name + valid status → gates.json updated with correct entry and updatedAt', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await setDependencyGate('backend-unit-pass', 'pass', gatePath);
    const entry = getDependencyGate('backend-unit-pass', gatePath);
    assert.ok(entry !== null, 'entry should not be null');
    assert.equal(entry?.name, 'backend-unit-pass');
    assert.equal(entry?.status, 'pass');
    assert.ok(typeof entry?.updatedAt === 'string', 'updatedAt should be a string');
    assert.ok(entry?.updatedAt.length > 0, 'updatedAt should be non-empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setDependencyGate — unknown gate name → throws with message listing canonical names', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await assert.rejects(
      () => setDependencyGate(/** @type {any} */ ('not-a-gate'), 'pass', gatePath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('not-a-gate'), 'message should contain the bad name');
        for (const name of DEP_GATES) {
          assert.ok(err.message.includes(name), `message should list canonical name: ${name}`);
        }
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setDependencyGate — unknown status → throws with message listing canonical statuses', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await assert.rejects(
      () => setDependencyGate('backend-ready', /** @type {any} */ ('unknown-status'), gatePath),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('unknown-status'), 'message should contain the bad status');
        assert.ok(err.message.includes('pending'), 'message should list valid statuses');
        assert.ok(err.message.includes('pass'));
        assert.ok(err.message.includes('fail'));
        assert.ok(err.message.includes('skipped'));
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setDependencyGate — missing gates.json → creates file with the single new entry', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await setDependencyGate('frontend-unit-pass', 'pending', gatePath);
    const gates = listDependencyGates(gatePath);
    assert.ok('frontend-unit-pass' in gates, 'new entry should be in gates');
    assert.equal(gates['frontend-unit-pass'].status, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDependencyGate — existing entry → returns DepGateEntry', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await setDependencyGate('all-tests-pass', 'fail', gatePath);
    const entry = getDependencyGate('all-tests-pass', gatePath);
    assert.ok(entry !== null);
    assert.equal(entry?.name, 'all-tests-pass');
    assert.equal(entry?.status, 'fail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getDependencyGate — missing file → returns null', () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    const entry = getDependencyGate('backend-ready', gatePath);
    assert.equal(entry, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listDependencyGates — file with two entries → returns both', async () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    await setDependencyGate('backend-unit-pass', 'pass', gatePath);
    await setDependencyGate('frontend-unit-pass', 'pass', gatePath);
    const gates = listDependencyGates(gatePath);
    assert.ok('backend-unit-pass' in gates);
    assert.ok('frontend-unit-pass' in gates);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listDependencyGates — missing file → returns {}', () => {
  const { dir, gatePath } = makeTmpGates();
  try {
    const gates = listDependencyGates(gatePath);
    assert.deepEqual(gates, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEP_GATES — is a Set containing the four canonical gate names', () => {
  assert.ok(DEP_GATES instanceof Set);
  assert.ok(DEP_GATES.has('backend-unit-pass'));
  assert.ok(DEP_GATES.has('backend-ready'));
  assert.ok(DEP_GATES.has('frontend-unit-pass'));
  assert.ok(DEP_GATES.has('all-tests-pass'));
  assert.equal(DEP_GATES.size, 4);
});
