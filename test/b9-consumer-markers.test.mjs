// @ts-check
// B9: consumer-side awareness of the producer's provenance markers plus the
// schemaVersion range gate and the wall->pointer guard message.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  validateDevmateConfig,
} from '../lib/config/devmate-config.mjs';
import { formatMultiRootGuardFailure } from '../lib/init/multi-root-init.mjs';

/**
 * A merged multi-root config carrying a synthesized fallback persona — the
 * shape the util writes for an un-init'd repo.
 * @returns {Record<string, unknown>}
 */
function fallbackConfig() {
  return {
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'payments',
    repos: ['payments'],
    personas: [
      {
        persona: 'payments',
        repo: 'payments',
        editableGlobs: ['payments/**'],
        offLimitsGlobs: ['payments/**/.env', 'payments/**/secrets/**'],
        source: 'fallback',
        synthesized: true,
      },
    ],
  };
}

// ---- schemaVersion range gate ----

test('validateDevmateConfig - accepts every SUPPORTED_SCHEMA_VERSION', () => {
  for (const v of SUPPORTED_SCHEMA_VERSIONS) {
    const cfg = { schemaVersion: v, personas: [{ persona: 'p', editableGlobs: ['**'] }] };
    assert.equal(validateDevmateConfig(cfg).ok, true, `version ${v} should validate`);
  }
});

test('validateDevmateConfig - rejects a too-new schemaVersion with an upgrade pointer', () => {
  const cfg = { schemaVersion: 3, personas: [{ persona: 'p', editableGlobs: ['**'] }] };
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /newer than this devmate build/);
  assert.match(result.error, /Upgrade the devmate plugin/);
});

test('validateDevmateConfig - rejects an unsupported (below-range) schemaVersion', () => {
  const cfg = { schemaVersion: 0, personas: [{ persona: 'p', editableGlobs: ['**'] }] };
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not supported/);
});

test('validateDevmateConfig - rejects a non-integer schemaVersion', () => {
  const cfg = { schemaVersion: 1.5, personas: [{ persona: 'p', editableGlobs: ['**'] }] };
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /integer schemaVersion/);
});

// ---- provenance markers (source / synthesized) ----

test('validateDevmateConfig - a synthesized fallback config validates', () => {
  assert.equal(validateDevmateConfig(fallbackConfig()).ok, true);
});

test('validateDevmateConfig - source: "repo" is accepted', () => {
  const cfg = fallbackConfig();
  /** @type {any} */ (cfg.personas)[0].source = 'repo';
  /** @type {any} */ (cfg.personas)[0].synthesized = false;
  assert.equal(validateDevmateConfig(cfg).ok, true);
});

test('validateDevmateConfig - an invalid source value is rejected', () => {
  const cfg = fallbackConfig();
  /** @type {any} */ (cfg.personas)[0].source = 'bogus';
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /source must be 'repo' or 'fallback'/);
});

test('validateDevmateConfig - a non-boolean synthesized is rejected', () => {
  const cfg = fallbackConfig();
  /** @type {any} */ (cfg.personas)[0].synthesized = 'yes';
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /synthesized must be a boolean/);
});

test('validateDevmateConfig - markers are optional (a real config without them still validates)', () => {
  const cfg = fallbackConfig();
  delete (/** @type {any} */ (cfg.personas)[0]).source;
  delete (/** @type {any} */ (cfg.personas)[0]).synthesized;
  assert.equal(validateDevmateConfig(cfg).ok, true);
});

// ---- wall -> pointer guard message ----

test('formatMultiRootGuardFailure - names the problem, the sole writer, and the exact verb', () => {
  const result = {
    ok: /** @type {false} */ (false),
    errors: ["personas[0].repo must be a non-empty string in multi-root mode"],
    created: [],
  };
  const msg = formatMultiRootGuardFailure(result, { repoRoot: '/work/feature-x' });

  // Names the offending problem verbatim.
  assert.match(msg, /personas\[0\]\.repo must be a non-empty string/);
  // Explains devmate is read-only and points at the sole writer.
  assert.match(msg, /read-only for multi-root configs/);
  assert.match(msg, /monoroot \(the sole writer\)/);
  // Gives the exact route forward — the util's repair verb.
  assert.match(msg, /Re-sync devmate/);
  assert.match(msg, /devmate init/);
  // Includes the workspace root for orientation.
  assert.match(msg, /\/work\/feature-x/);
});

test('formatMultiRootGuardFailure - tolerates an empty error list without dead-ending', () => {
  const result = { ok: /** @type {false} */ (false), errors: [], created: [] };
  const msg = formatMultiRootGuardFailure(result, { repoRoot: '/ws' });
  assert.match(msg, /validation failed/);
  assert.match(msg, /Re-sync devmate/);
});
