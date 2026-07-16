// @ts-check
// Shared config-contract corpus, consumer side. Proves devmate's hand-written
// validator agrees with the versioned contract. The same corpus is vendored
// byte-identical into monoroot and run through its writer, so the two tools
// can never silently disagree about what a config means.
//
// The v3 manifest tags every fixture with a scope — 'both' | 'consumer' |
// 'producer-merge' — naming who must exercise it. The consumer (this suite)
// runs EVERY fixture through validateDevmateConfig regardless of scope: the
// tags exist so the producer's suite can skip consumer-only fixtures
// explicitly instead of silently.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDevmateConfig } from '../../../lib/config/devmate-config.mjs';
import { CONTRACT_VERSION } from '../../../lib/config/contract-version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures', 'config-contract');

/** Scope tags the manifest may assign to a fixture. */
const VALID_SCOPES = new Set(['both', 'consumer', 'producer-merge']);

/**
 * @param {string} rel
 * @returns {unknown}
 */
function readJson(rel) {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
}

/**
 * @param {string} sub
 * @returns {string[]}
 */
function fixtureNames(sub) {
  return readdirSync(join(FIXTURES, sub)).filter((f) => f.endsWith('.json'));
}

/**
 * @typedef {{ scope: string }} AcceptEntry
 * @typedef {{ scope: string, error: string }} RejectEntry
 * @typedef {{ contractVersion: number, mustAccept: Record<string, AcceptEntry>, mustReject: Record<string, RejectEntry> }} Manifest
 */
const manifest = /** @type {Manifest} */ (readJson('manifest.json'));

test('config-contract - manifest pins the contractVersion this build targets', () => {
  assert.equal(manifest.contractVersion, CONTRACT_VERSION);
});

test('config-contract - every fixture scope tag is a known value', () => {
  for (const [file, entry] of Object.entries(manifest.mustAccept)) {
    assert.ok(VALID_SCOPES.has(entry.scope), `${file} has unknown scope '${entry.scope}'`);
  }
  for (const [file, entry] of Object.entries(manifest.mustReject)) {
    assert.ok(VALID_SCOPES.has(entry.scope), `${file} has unknown scope '${entry.scope}'`);
  }
});

test('config-contract - every must-accept fixture validates', () => {
  const files = fixtureNames('must-accept');
  assert.ok(files.length > 0, 'expected at least one must-accept fixture');
  for (const f of files) {
    const cfg = readJson(join('must-accept', f));
    const result = validateDevmateConfig(cfg);
    assert.equal(result.ok, true, `${f} should validate — got: ${result.ok ? '' : result.error}`);
  }
});

test('config-contract - every must-reject fixture fails with its mapped error substring', () => {
  const files = fixtureNames('must-reject');
  assert.ok(files.length > 0, 'expected at least one must-reject fixture');
  for (const f of files) {
    const entry = manifest.mustReject[f];
    assert.ok(entry !== undefined, `manifest.mustReject must map ${f}`);
    const cfg = readJson(join('must-reject', f));
    const result = validateDevmateConfig(cfg);
    assert.equal(result.ok, false, `${f} should be rejected`);
    if (result.ok) continue;
    assert.ok(
      result.error.includes(entry.error),
      `${f} error "${result.error}" should include "${entry.error}"`,
    );
  }
});

test('config-contract - no orphan fixtures (every file on disk is mapped in the manifest)', () => {
  for (const f of fixtureNames('must-accept')) {
    assert.ok(f in manifest.mustAccept, `${f} is missing from manifest.mustAccept`);
  }
  for (const f of fixtureNames('must-reject')) {
    assert.ok(f in manifest.mustReject, `${f} is missing from manifest.mustReject`);
  }
});

test('config-contract - no dangling manifest entries (every mapped fixture exists on disk)', () => {
  const accepts = new Set(fixtureNames('must-accept'));
  const rejects = new Set(fixtureNames('must-reject'));
  for (const f of Object.keys(manifest.mustAccept)) {
    assert.ok(accepts.has(f), `manifest.mustAccept maps ${f} but the file does not exist`);
  }
  for (const f of Object.keys(manifest.mustReject)) {
    assert.ok(rejects.has(f), `manifest.mustReject maps ${f} but the file does not exist`);
  }
});
