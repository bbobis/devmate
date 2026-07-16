// @ts-check
// Shared session-handshake corpus, consumer side. Proves devmate's pure
// parseSessionHandshake agrees with the versioned handshake contract. The same
// corpus is vendored byte-identical into monoroot and run through its
// isValidSession, so the two hand validators can never silently drift.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_SCHEMA_VERSION,
  parseSessionHandshake,
} from '../../../lib/init/session-handshake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures', 'session-handshake');

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
 * @typedef {{ handshakeVersion: number, mustAccept: string[], mustReject: string[] }} Manifest
 */
const manifest = /** @type {Manifest} */ (readJson('manifest.json'));

test('session-handshake - manifest pins the handshakeVersion this build targets', () => {
  assert.equal(manifest.handshakeVersion, SESSION_SCHEMA_VERSION);
});

test('session-handshake - every must-accept fixture parses to its devmate block', () => {
  const files = fixtureNames('must-accept');
  assert.ok(files.length > 0, 'expected at least one must-accept fixture');
  for (const f of files) {
    const session = /** @type {Record<string, unknown>} */ (readJson(join('must-accept', f)));
    const handshake = parseSessionHandshake(session);
    assert.ok(handshake !== null, `${f} should parse to a handshake`);
    const d = /** @type {Record<string, unknown>} */ (session['devmate']);
    assert.deepEqual(handshake, {
      mode: 'multi-root',
      primary: d['primary'],
      configPath: d['configPath'],
    });
  }
});

test('session-handshake - every must-reject fixture parses to null', () => {
  const files = fixtureNames('must-reject');
  assert.ok(files.length > 0, 'expected at least one must-reject fixture');
  for (const f of files) {
    assert.equal(parseSessionHandshake(readJson(join('must-reject', f))), null, `${f} should be rejected`);
  }
});

test('session-handshake - no orphan fixtures and no dangling manifest entries', () => {
  const accepts = fixtureNames('must-accept');
  const rejects = fixtureNames('must-reject');
  for (const f of accepts) {
    assert.ok(manifest.mustAccept.includes(f), `${f} is missing from manifest.mustAccept`);
  }
  for (const f of rejects) {
    assert.ok(manifest.mustReject.includes(f), `${f} is missing from manifest.mustReject`);
  }
  for (const f of manifest.mustAccept) {
    assert.ok(accepts.includes(f), `manifest.mustAccept lists ${f} but the file does not exist`);
  }
  for (const f of manifest.mustReject) {
    assert.ok(rejects.includes(f), `manifest.mustReject lists ${f} but the file does not exist`);
  }
});

test('session-handshake - parseSessionHandshake is non-throwing on junk input', () => {
  assert.equal(parseSessionHandshake(null), null);
  assert.equal(parseSessionHandshake(undefined), null);
  assert.equal(parseSessionHandshake('a string'), null);
  assert.equal(parseSessionHandshake(42), null);
  assert.equal(parseSessionHandshake([]), null);
  assert.equal(parseSessionHandshake({ schemaVersion: 2, devmate: [] }), null);
});
