// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveActiveDomains,
  DOMAIN_MATCH_TOP_N,
  DOMAIN_MATCH_MIN_SCORE,
} from '../../../lib/context/domain-resolver.mjs';

/** @typedef {import('../../../lib/types.mjs').DomainConfig} DomainConfig */

/**
 * Build a normalized DomainConfig fixture (post-loadDevmateConfig shape).
 * @param {Partial<DomainConfig> & { domain: string }} overrides
 * @returns {DomainConfig}
 */
function makeDomain(overrides) {
  return {
    keywords: [],
    globs: [],
    contextFile: null,
    relatedDomains: [],
    entryPoints: [],
    ...overrides,
  };
}

/** The DN-1 example config from docs/config.md. */
const BILLING = makeDomain({
  domain: 'billing',
  keywords: ['invoice', 'payment', 'refund', 'charge'],
  globs: ['packages/billing/src/**'],
  contextFile: '.devmate/contexts/billing.md',
  relatedDomains: ['orders'],
  entryPoints: ['packages/billing/src/index.ts'],
});

test('resolveActiveDomains › empty domains returns []', () => {
  const result = resolveActiveDomains({
    taskText: 'fix the refund double-charge on invoices',
    seedFiles: [],
    domains: [],
  });
  assert.deepEqual(result, []);
});

test('resolveActiveDomains › DN-1 example config: refund prompt ranks billing first with matched keywords', () => {
  const orders = makeDomain({
    domain: 'orders',
    keywords: ['order', 'fulfillment'],
    globs: ['packages/orders/src/**'],
  });
  const result = resolveActiveDomains({
    taskText: 'fix the refund double-charge on invoices',
    seedFiles: [],
    domains: [orders, BILLING],
  });
  assert.ok(result.length >= 1, 'expected at least one match');
  assert.equal(result[0].domain, 'billing');
  // 'refund' and 'charge' hit exactly; 'invoices' hits 'invoice' morphologically.
  assert.ok(result[0].matchedKeywords.includes('refund'));
  assert.ok(result[0].matchedKeywords.includes('charge'));
  assert.ok(result[0].matchedKeywords.includes('invoice'));
  // 3 keyword hits x 0.2 = 0.6, capped at the 0.5 keyword contribution cap.
  assert.equal(result[0].score, 0.5);
  // Config pointers are carried through verbatim — path only, never contents.
  assert.equal(result[0].contextFile, '.devmate/contexts/billing.md');
  assert.deepEqual(result[0].relatedDomains, ['orders']);
  // 'orders' matched nothing and is filtered by the min-score floor.
  assert.ok(!result.some((m) => m.domain === 'orders'));
});

test('resolveActiveDomains › keyword hits are exact or morphological, weighted 0.2/hit', () => {
  const domain = makeDomain({
    domain: 'auth',
    keywords: ['login', 'session'],
  });
  // Two exact hits: 0.4.
  const exact = resolveActiveDomains({
    taskText: 'the login session expires early',
    seedFiles: [],
    domains: [domain],
  });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].score, 0.4);
  assert.deepEqual(exact[0].matchedKeywords, ['login', 'session']);
  // Morphological: 'sessions' ~ 'session', 'logins' ~ 'login'.
  const morph = resolveActiveDomains({
    taskText: 'logins drop stale sessions',
    seedFiles: [],
    domains: [domain],
  });
  assert.equal(morph.length, 1);
  assert.equal(morph[0].score, 0.4);
});

test('resolveActiveDomains › keyword contribution is capped at 0.5', () => {
  const domain = makeDomain({
    domain: 'billing',
    keywords: ['invoice', 'payment', 'refund', 'charge'],
  });
  const result = resolveActiveDomains({
    taskText: 'invoice payment refund charge',
    seedFiles: [],
    domains: [domain],
  });
  // 4 hits x 0.2 = 0.8 -> capped at 0.5.
  assert.equal(result[0].score, 0.5);
  assert.equal(result[0].matchedKeywords.length, 4);
});

test('resolveActiveDomains › min-score filter drops weak matches', () => {
  const domain = makeDomain({
    domain: 'billing',
    keywords: ['invoice'],
  });
  // A single keyword hit scores 0.2 < DOMAIN_MATCH_MIN_SCORE (0.25).
  const result = resolveActiveDomains({
    taskText: 'update the invoice text',
    seedFiles: [],
    domains: [domain],
  });
  assert.ok(0.2 < DOMAIN_MATCH_MIN_SCORE);
  assert.deepEqual(result, []);
});

test('resolveActiveDomains › a seed file matching a domain glob adds GLOB_WEIGHT', () => {
  const withoutSeed = resolveActiveDomains({
    taskText: 'refactor the checkout flow',
    seedFiles: [],
    domains: [BILLING],
  });
  assert.deepEqual(withoutSeed, []);
  const withSeed = resolveActiveDomains({
    taskText: 'refactor the checkout flow',
    seedFiles: ['packages/billing/src/checkout.ts'],
    domains: [BILLING],
  });
  assert.equal(withSeed.length, 1);
  assert.equal(withSeed[0].domain, 'billing');
  assert.equal(withSeed[0].score, 0.4);
  assert.deepEqual(withSeed[0].matchedGlobs, ['packages/billing/src/**']);
});

test('resolveActiveDomains › glob matching accepts Windows-separated seed paths', () => {
  const result = resolveActiveDomains({
    taskText: 'refactor the checkout flow',
    seedFiles: ['packages\\billing\\src\\checkout.ts'],
    domains: [BILLING],
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].matchedGlobs, ['packages/billing/src/**']);
});

test('resolveActiveDomains › verbatim domain id in the task text adds ID_WEIGHT', () => {
  const domain = makeDomain({
    domain: 'billing',
    keywords: ['invoice'],
  });
  // 'billing' id verbatim (0.2) + 'invoice' keyword (0.2) = 0.4.
  const result = resolveActiveDomains({
    taskText: 'billing invoice cleanup',
    seedFiles: [],
    domains: [domain],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].score, 0.4);
  // The id token must match as a whole token, not a substring.
  const partial = resolveActiveDomains({
    taskText: 'rebilling invoice cleanup',
    seedFiles: [],
    domains: [makeDomain({ domain: 'billing', keywords: [] })],
  });
  assert.deepEqual(partial, []);
});

test('resolveActiveDomains › total score is capped at 1.0', () => {
  const result = resolveActiveDomains({
    taskText: 'billing invoice payment refund charge',
    seedFiles: ['packages/billing/src/index.ts'],
    domains: [BILLING],
  });
  // keywords 0.5 (capped) + glob 0.4 + id 0.2 = 1.1 -> 1.0.
  assert.equal(result[0].score, 1);
});

test('resolveActiveDomains › results are capped at DOMAIN_MATCH_TOP_N', () => {
  const domains = ['alpha', 'beta', 'gamma'].map((id) =>
    makeDomain({ domain: id, keywords: ['invoice', 'refund'] }),
  );
  const result = resolveActiveDomains({
    taskText: 'invoice refund',
    seedFiles: [],
    domains,
  });
  assert.equal(result.length, DOMAIN_MATCH_TOP_N);
});

test('resolveActiveDomains › ties order alphabetically by domain id', () => {
  const domains = ['zeta', 'alpha', 'mid'].map((id) =>
    makeDomain({ domain: id, keywords: ['invoice', 'refund'] }),
  );
  const result = resolveActiveDomains({
    taskText: 'invoice refund',
    seedFiles: [],
    domains,
  });
  assert.deepEqual(
    result.map((m) => m.domain),
    ['alpha', 'mid'],
  );
});

test('resolveActiveDomains › higher score wins regardless of config order', () => {
  const weak = makeDomain({ domain: 'aaa-weak', keywords: ['invoice', 'refund'] });
  const strong = makeDomain({
    domain: 'zzz-strong',
    keywords: ['invoice', 'refund'],
    globs: ['src/**'],
  });
  const result = resolveActiveDomains({
    taskText: 'invoice refund',
    seedFiles: ['src/index.mjs'],
    domains: [weak, strong],
  });
  assert.deepEqual(
    result.map((m) => m.domain),
    ['zzz-strong', 'aaa-weak'],
  );
});

test('resolveActiveDomains › deterministic and pure: same input, same output, no mutation', () => {
  const domains = [BILLING];
  const input = {
    taskText: 'fix the refund double-charge on invoices',
    seedFiles: ['packages/billing/src/checkout.ts'],
    domains,
  };
  const snapshot = JSON.stringify(input);
  const first = resolveActiveDomains(input);
  const second = resolveActiveDomains(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
});
