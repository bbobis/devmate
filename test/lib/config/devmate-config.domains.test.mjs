// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDevmateConfig, loadDevmateConfig } from '../../../lib/config/devmate-config.mjs';

/**
 * Base config with the required personas array — every test extends this.
 * @type {{ schemaVersion: number, personas: Array<{ persona: string, editableGlobs: string[] }> }}
 */
const BASE = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['src/**'] }] };

test('validateDevmateConfig - domains absent loads byte-for-byte identically (no new fields invented, no warnings)', () => {
  const result = validateDevmateConfig({ ...BASE });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal('domains' in result.config, false);
    assert.equal(result.warnings?.some((w) => w.toLowerCase().includes('domain')), false);
  }
});

test('validateDevmateConfig - valid domains array is exposed, each entry normalized (missing optionals -> []/null)', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [
      { domain: 'billing', keywords: ['invoice', 'refund'], globs: ['packages/billing/**'] },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.config.domains, [
      {
        domain: 'billing',
        keywords: ['invoice', 'refund'],
        globs: ['packages/billing/**'],
        contextFile: null,
        relatedDomains: [],
        entryPoints: [],
      },
    ]);
  }
});

test('validateDevmateConfig - fully-specified domain entry round-trips unchanged', () => {
  const domain = {
    domain: 'billing',
    keywords: ['invoice', 'payment', 'refund', 'charge'],
    globs: ['packages/billing/src/**'],
    contextFile: '.devmate/contexts/billing.md',
    relatedDomains: ['orders'],
    entryPoints: ['packages/billing/src/index.ts'],
  };
  const result = validateDevmateConfig({ ...BASE, domains: [domain] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.config.domains, [domain]);
  }
});

test('validateDevmateConfig - domains non-array = fail', () => {
  const result = validateDevmateConfig({ ...BASE, domains: 'billing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /domains must be an array/);
});

test('validateDevmateConfig - duplicate domain ids = fail', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [
      { domain: 'billing', keywords: [], globs: ['a/**'] },
      { domain: 'billing', keywords: [], globs: ['b/**'] },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /duplicate domain id 'billing'/);
  }
});

test('validateDevmateConfig - non-array keywords = fail naming the domain id', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: 'invoice', globs: ['a/**'] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /domains\[billing\]\.keywords must be an array/);
  }
});

test('validateDevmateConfig - non-array globs = fail naming the domain id', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: ['invoice'], globs: 'a/**' }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /domains\[billing\]\.globs must be an array/);
  }
});

test('validateDevmateConfig - unknown key on a domain entry = fail (rejects an entry with an unknown key)', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: [], globs: ['a/**'], nope: true }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /unknown key 'nope'/);
  }
});

test('validateDevmateConfig - domain entry missing domain id = fail', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [{ keywords: [], globs: ['a/**'] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /domains\[0\]\.domain must be a non-empty string/);
  }
});

test('validateDevmateConfig - contextFile wrong type = fail', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: [], globs: ['a/**'], contextFile: 42 }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /domains\[billing\]\.contextFile must be a string or null/);
  }
});

test('validateDevmateConfig - relatedDomains/entryPoints non-array = fail', () => {
  const relatedResult = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: [], globs: ['a/**'], relatedDomains: 'orders' }],
  });
  assert.equal(relatedResult.ok, false);

  const entryResult = validateDevmateConfig({
    ...BASE,
    domains: [{ domain: 'billing', keywords: [], globs: ['a/**'], entryPoints: 'src/index.ts' }],
  });
  assert.equal(entryResult.ok, false);
});

test('validateDevmateConfig - malformed domain entry never half-loads', () => {
  const result = validateDevmateConfig({
    ...BASE,
    domains: [
      { domain: 'billing', keywords: ['invoice'], globs: ['a/**'] },
      { domain: 'orders', keywords: 'not-an-array', globs: ['b/**'] },
    ],
  });
  assert.equal(result.ok, false);
});

test('loadDevmateConfig - domains round-trip through a temp-dir config file', () => {
  const dir = join(tmpdir(), `devmate-config-domains-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'devmate.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ...BASE,
      domains: [
        { domain: 'billing', keywords: ['invoice'], globs: ['packages/billing/**'] },
      ],
    }),
    'utf8',
  );
  const result = loadDevmateConfig(configPath);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.domains?.[0].domain, 'billing');
    assert.equal(result.config.domains?.[0].contextFile, null);
  }
  rmSync(dir, { recursive: true, force: true });
});
