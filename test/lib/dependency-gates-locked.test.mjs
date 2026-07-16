// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setDependencyGate,
  getDependencyGate,
  validateDepGates,
  DEP_GATES,
} from '../../lib/dependency-gates.mjs';

/**
 * @returns {string}
 */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'devmate-gates-locked-test-'));
}

test('validateDepGates › valid gates object → no error', () => {
  const valid = {
    'backend-unit-pass': { name: 'backend-unit-pass', status: 'pass', updatedAt: '2024-01-01T00:00:00.000Z' },
  };
  const result = validateDepGates(valid);
  assert.equal(result, null);
});

test('validateDepGates › entry with unknown DepGateName key → error lists the bad key', () => {
  const bad = {
    'unknown-gate': { name: 'unknown-gate', status: 'pass', updatedAt: '2024-01-01T00:00:00.000Z' },
  };
  const result = validateDepGates(bad);
  assert.ok(typeof result === 'string', 'should return an error string');
  assert.ok(result.includes('unknown-gate'), `error should mention bad key, got: ${result}`);
});

test('validateDepGates › entry missing status → error mentions gate name and field', () => {
  const bad = {
    'backend-ready': { name: 'backend-ready', updatedAt: '2024-01-01T00:00:00.000Z' },
  };
  const result = validateDepGates(bad);
  assert.ok(typeof result === 'string', 'should return an error string');
  assert.ok(result.includes('backend-ready'), `error should mention gate name, got: ${result}`);
});

test('validateDepGates › empty object is valid', () => {
  const result = validateDepGates({});
  assert.equal(result, null);
});

test('setDependencyGate concurrent test (10 parallel calls, different gate names) → final gates.json has all entries intact', async () => {
  const dir = makeTmpDir();
  const statePath = join(dir, 'gates.json');

  const gates = [...DEP_GATES];

  // Wave 1: all 4 gates concurrently.
  await Promise.all(
    gates.map((name) => setDependencyGate(name, 'pass', statePath))
  );

  for (const name of gates) {
    const entry = getDependencyGate(name, statePath);
    assert.ok(entry !== null, `entry for ${name} should exist after wave 1`);
    assert.equal(entry?.status, 'pass');
  }

  // Wave 2: update all 4 to 'fail' concurrently.
  await Promise.all(
    gates.map((name) => setDependencyGate(name, 'fail', statePath))
  );

  for (const name of gates) {
    const entry = getDependencyGate(name, statePath);
    assert.ok(entry !== null, `entry for ${name} should exist after wave 2`);
    assert.equal(entry?.status, 'fail');
  }

  rmSync(dir, { recursive: true, force: true });
});

test('setDependencyGate with corrupt pre-existing gates.json → throws with "corrupt" and "preserved" in message; original file unchanged', async () => {
  const dir = makeTmpDir();
  const statePath = join(dir, 'gates.json');
  const corruptContent = '{not valid json at all';

  writeFileSync(statePath, corruptContent, 'utf8');

  await assert.rejects(
    () => setDependencyGate('backend-ready', 'pass', statePath),
    (/** @type {Error} */ err) => {
      assert.ok(err.message.toLowerCase().includes('corrupt'), `Expected 'corrupt' in message, got: ${err.message}`);
      assert.ok(err.message.toLowerCase().includes('preserved'), `Expected 'preserved' in message, got: ${err.message}`);
      return true;
    }
  );

  const afterContent = readFileSync(statePath, 'utf8');
  assert.equal(afterContent, corruptContent, 'corrupt file should not be overwritten');

  rmSync(dir, { recursive: true, force: true });
});
