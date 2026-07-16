// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDevmateConfig } from '../lib/config/devmate-config.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid single-root config.
 * @param {object[]} personas
 * @returns {object}
 */
function singleRoot(personas) {
  return { schemaVersion: 1, personas };
}

/**
 * Minimal valid multi-root config. `primary`/`repos` are contract-required in
 * multi-root mode; the repos list is a superset of every repo these tests use.
 * @param {object[]} personas
 * @returns {object}
 */
function multiRoot(personas) {
  return {
    schemaVersion: 1,
    mode: 'multi-root',
    primary: 'portals-api',
    repos: ['portals-api', 'portals-ui', 'portals-shared'],
    personas,
  };
}

// ---------------------------------------------------------------------------
// Single-root — duplicate names must NOT be rejected (no behavioural change)
// ---------------------------------------------------------------------------

test('single-root config with duplicate persona names — returns ok: true', () => {
  const result = validateDevmateConfig(
    singleRoot([
      { persona: 'editor', editableGlobs: ['src/**'] },
      { persona: 'editor', editableGlobs: ['lib/**'] },
    ]),
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Multi-root — valid configs
// ---------------------------------------------------------------------------

test('multi-root config, all persona names unique — returns ok: true', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'api', repo: 'portals-api', editableGlobs: [] },
      { persona: 'frontend', repo: 'portals-ui', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, true);
});

test('multi-root config with exactly one persona — returns ok: true (no false positive)', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'api', repo: 'portals-api', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, true);
});

test('multi-root config with three personas, all unique names — returns ok: true', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'api', repo: 'portals-api', editableGlobs: [] },
      { persona: 'frontend', repo: 'portals-ui', editableGlobs: [] },
      { persona: 'shared', repo: 'portals-shared', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Multi-root — duplicate detection
// ---------------------------------------------------------------------------

test('multi-root config, two personas named "editor" in different repos — returns ok: false', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'editor', repo: 'portals-api', editableGlobs: [] },
      { persona: 'editor', repo: 'portals-ui', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("'editor'"), 'error must name the duplicate persona');
  assert.ok(!result.ok && result.error.includes('portals-api'), 'error must name first repo');
  assert.ok(!result.ok && result.error.includes('portals-ui'), 'error must name second repo');
});

test('multi-root config, three personas, first and third share a name — returns ok: false (non-adjacent)', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'api', repo: 'portals-api', editableGlobs: [] },
      { persona: 'frontend', repo: 'portals-ui', editableGlobs: [] },
      { persona: 'api', repo: 'portals-shared', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("'api'"));
});

// ---------------------------------------------------------------------------
// Order guarantee: B2 repo check fires before B7 duplicate check
// ---------------------------------------------------------------------------

test('multi-root config with a missing repo field — fails on B2 repo check, NOT B7 duplicate check', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'api', editableGlobs: [] }, // missing repo
      { persona: 'api', repo: 'portals-ui', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, false);
  // Must be the B2 error, not the B7 duplicate error.
  assert.ok(!result.ok && result.error.includes('repo must be a non-empty string in multi-root mode'),
    `expected B2 repo error but got: ${!result.ok ? result.error : ''}`);
});

// ---------------------------------------------------------------------------
// Error message content requirements
// ---------------------------------------------------------------------------

test('error message contains \'Each persona name must be unique across all repos\'', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'editor', repo: 'portals-api', editableGlobs: [] },
      { persona: 'editor', repo: 'portals-ui', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes('Each persona name must be unique across all repos'));
});

test('error message names the "Re-sync devmate" verb and the monoroot producer', () => {
  const result = validateDevmateConfig(
    multiRoot([
      { persona: 'editor', repo: 'portals-api', editableGlobs: [] },
      { persona: 'editor', repo: 'portals-ui', editableGlobs: [] },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes('Re-sync devmate'));
  assert.ok(!result.ok && result.error.includes('monoroot'));
});
