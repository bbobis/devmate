// @ts-check
// B10: consumer Phase 2 — reading the producer's fallback markers and consuming
// the util's session.json handshake.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fallbackReposOf,
  formatContractSkewNudge,
  formatFallbackNudge,
} from '../lib/init/multi-root-init.mjs';
import { readSessionHandshake } from '../lib/init/session-handshake.mjs';

// ---- fallbackReposOf ----

test('fallbackReposOf - returns repos whose persona is source "fallback"', () => {
  const config = {
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'api',
    repos: ['api', 'payments', 'ui'],
    personas: [
      { persona: 'api-dev', repo: 'api', editableGlobs: ['src/**'], source: 'repo' },
      { persona: 'payments', repo: 'payments', editableGlobs: ['payments/**'], source: 'fallback', synthesized: true },
      { persona: 'ui', repo: 'ui', editableGlobs: ['ui/**'], source: 'fallback', synthesized: true },
    ],
  };
  assert.deepEqual(fallbackReposOf(/** @type {any} */ (config)), ['payments', 'ui']);
});

test('fallbackReposOf - empty for no fallbacks or bad input', () => {
  assert.deepEqual(
    fallbackReposOf(/** @type {any} */ ({ personas: [{ persona: 'x', repo: 'a', source: 'repo' }] })),
    [],
  );
  assert.deepEqual(fallbackReposOf(/** @type {any} */ ({})), []);
  assert.deepEqual(fallbackReposOf(/** @type {any} */ (null)), []);
});

// ---- formatFallbackNudge ----

test('formatFallbackNudge - names the repos and the Re-sync verb', () => {
  const msg = formatFallbackNudge(['payments', 'ui']);
  assert.match(msg, /payments, ui/);
  assert.match(msg, /Re-sync devmate/);
  assert.match(msg, /devmate init/);
});

test('formatFallbackNudge - singular phrasing for one repo', () => {
  assert.match(formatFallbackNudge(['payments']), /1 repo is/);
});

// ---- formatContractSkewNudge ----

test('formatContractSkewNudge - names both versions, the producer, and the Re-sync verb', () => {
  const msg = formatContractSkewNudge(2, 3);
  assert.match(msg, /contract version skew/);
  assert.match(msg, /v2/);
  assert.match(msg, /v3/);
  assert.match(msg, /monoroot/);
  assert.match(msg, /Re-sync devmate/);
});

test('formatContractSkewNudge - points the update at the stale side', () => {
  // Config newer than the consumer → the plugin is stale.
  assert.match(formatContractSkewNudge(4, 3), /update the devmate plugin/);
  // Config older than the consumer → the extension is stale.
  assert.match(formatContractSkewNudge(2, 3), /update the monoroot extension/);
});

// ---- readSessionHandshake ----

/**
 * @param {string} dir
 * @param {unknown} obj
 */
function writeSession(dir, obj) {
  const devmate = join(dir, '.devmate');
  mkdirSync(devmate, { recursive: true });
  writeFileSync(join(devmate, 'session.json'), JSON.stringify(obj));
}

test('readSessionHandshake - returns the devmate block for a valid v2 session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-hs-'));
  try {
    writeSession(dir, {
      schemaVersion: 2,
      branchName: 'feature-x',
      createdAt: 't',
      workspaceFile: 'feature-x.code-workspace',
      devmate: { mode: 'multi-root', primary: 'api', configPath: '.devmate/devmate.config.json' },
      worktrees: [],
    });
    const hs = await readSessionHandshake(dir);
    assert.deepEqual(hs, {
      mode: 'multi-root',
      primary: 'api',
      configPath: '.devmate/devmate.config.json',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionHandshake - null when the file is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-hs-'));
  try {
    assert.equal(await readSessionHandshake(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionHandshake - null for legacy, malformed, or non-multi-root sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-hs-'));
  try {
    writeSession(dir, { schemaVersion: 1, devmate: { mode: 'multi-root', primary: 'api', configPath: 'x' } });
    assert.equal(await readSessionHandshake(dir), null, 'v1 rejected');

    writeSession(dir, { schemaVersion: 2 });
    assert.equal(await readSessionHandshake(dir), null, 'missing devmate block');

    writeSession(dir, { schemaVersion: 2, devmate: { mode: 'single', primary: 'a', configPath: 'x' } });
    assert.equal(await readSessionHandshake(dir), null, 'non-multi-root mode');

    const devmate = join(dir, '.devmate');
    mkdirSync(devmate, { recursive: true });
    writeFileSync(join(devmate, 'session.json'), 'not json');
    assert.equal(await readSessionHandshake(dir), null, 'malformed JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
