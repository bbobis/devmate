// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute } from 'node:path';
import {
  loadDomainContextForDispatch,
  checkDomainContextFiles,
  DOMAIN_CONTEXT_MAX_TOKENS,
} from '../../../lib/context/domain-context-load.mjs';
import { estimateTokens } from '../../../lib/context/estimate-tokens.mjs';

/** @typedef {import('../../../lib/types.mjs').DomainMatch} DomainMatch */
/** @typedef {import('../../../lib/types.mjs').DomainContextState} DomainContextState */

const REPO_ROOT = '/repo';

/**
 * @param {Partial<DomainMatch> & { domain: string }} overrides
 * @returns {DomainMatch}
 */
function match(overrides) {
  return {
    score: 0.7,
    matchedKeywords: ['invoice'],
    matchedGlobs: ['packages/billing/src/**'],
    contextFile: '.devmate/contexts/billing.md',
    relatedDomains: ['orders'],
    ...overrides,
  };
}

/**
 * @param {DomainMatch[]} matches
 * @returns {DomainContextState}
 */
function state(matches) {
  return { schemaVersion: 1, resolvedAt: '2026-07-11T00:00:00.000Z', matches };
}

/**
 * Reader over an in-memory map keyed by the file's basename-ish suffix; the
 * loader resolves contextFile paths against repoRoot, so keys are matched by
 * suffix to stay platform-separator agnostic.
 * @param {Record<string, string>} files  contextFile (repo-relative, /-separated) -> content
 * @returns {(p: string) => string|null}
 */
function readerFor(files) {
  return (p) => {
    const normalized = p.replaceAll('\\', '/');
    for (const [rel, content] of Object.entries(files)) {
      if (normalized.endsWith(rel)) return content;
    }
    return null;
  };
}

test('domain-context-load › zero domains -> []', () => {
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: readerFor({}),
  });
  assert.deepEqual(entries, []);
});

test('domain-context-load › two small context files fit the budget in rank order', () => {
  const billingContent = '# Billing\n\nKey invariant: never double-charge.\n';
  const ordersContent = '# Orders\n\nKey entry: packages/orders/src/index.ts\n';
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([
      match({ domain: 'billing' }),
      match({
        domain: 'orders',
        contextFile: '.devmate/contexts/orders.md',
        matchedGlobs: ['packages/orders/src/**'],
        relatedDomains: ['billing'],
      }),
    ]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: readerFor({
      '.devmate/contexts/billing.md': billingContent,
      '.devmate/contexts/orders.md': ordersContent,
    }),
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].domain, 'billing');
  assert.equal(entries[1].domain, 'orders');
  assert.deepEqual(entries[0], {
    domain: 'billing',
    globs: ['packages/billing/src/**'],
    relatedDomains: ['orders'],
    contextFile: '.devmate/contexts/billing.md',
    content: billingContent,
    digest: null,
    truncated: false,
    missing: false,
  });
  assert.equal(entries[1].content, ordersContent);
  assert.equal(entries[1].truncated, false);
});

test('domain-context-load › over-budget file degrades to digest (head lines + heading list), truncated flag set', () => {
  const bigContent = [
    '# Billing domain',
    '',
    '## Key entry files',
    'packages/billing/src/index.ts',
    '## Invariants',
    'Never double-charge.',
    'line 7',
    'line 8',
    'line 9',
    'line 10',
    'line 11 — beyond the digest head',
    `padding ${'x'.repeat(8000)}`,
  ].join('\n');
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([match({ domain: 'billing' })]),
    maxTokens: 500,
    readFile: readerFor({ '.devmate/contexts/billing.md': bigContent }),
  });

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.truncated, true);
  assert.equal(entry.missing, false);
  assert.equal(entry.content, null);
  // Nullish-coalesce instead of ===: the no-insecure-comparison lint treats
  // comparisons on digest-named identifiers as secret comparison.
  const digest = entry.digest ?? '';
  assert.ok(digest.length > 0, 'digest must be non-empty');
  // First DIGEST_HEAD_LINES lines are kept...
  assert.match(digest, /# Billing domain/);
  assert.match(digest, /line 10/);
  assert.doesNotMatch(digest, /line 11 — beyond the digest head/);
  // ...plus the heading list.
  assert.match(digest, /Headings: # Billing domain \| ## Key entry files \| ## Invariants/);
  // The digest itself respects the budget.
  assert.ok(estimateTokens(digest) <= 500);
});

test('domain-context-load › null contextFile and unreadable file are both marked missing', () => {
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([
      match({ domain: 'billing', contextFile: null }),
      match({ domain: 'orders', contextFile: '.devmate/contexts/orders.md' }),
    ]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: readerFor({}), // nothing readable
  });

  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.missing, true);
    assert.equal(entry.content, null);
    assert.equal(entry.digest, null);
    assert.equal(entry.truncated, false);
  }
  assert.equal(entries[0].contextFile, null);
  assert.equal(entries[1].contextFile, '.devmate/contexts/orders.md');
});

test('domain-context-load › a throwing reader is fail-open: entry marked missing, no throw', () => {
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([match({ domain: 'billing' })]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].missing, true);
});

test('domain-context-load › budget split across two domains prioritizes rank 1', () => {
  // Rank 1 fits alone; rank 2 would fit an empty budget but not the remainder.
  const rank1 = `# Billing\n${'a'.repeat(3200)}`; // ~800 tokens
  const rank2 = `# Orders\n## Contracts\n${'b'.repeat(3200)}`; // ~800 tokens
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([
      match({ domain: 'billing' }),
      match({ domain: 'orders', contextFile: '.devmate/contexts/orders.md' }),
    ]),
    maxTokens: 1000,
    readFile: readerFor({
      '.devmate/contexts/billing.md': rank1,
      '.devmate/contexts/orders.md': rank2,
    }),
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].domain, 'billing');
  assert.equal(entries[0].truncated, false);
  assert.equal(entries[0].content, rank1);
  assert.equal(entries[1].domain, 'orders');
  assert.equal(entries[1].truncated, true);
  assert.equal(entries[1].content, null);
});

test('domain-context-load › entry count is re-capped defensively at the resolver top-N', () => {
  const entries = loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([
      match({ domain: 'a', contextFile: null }),
      match({ domain: 'b', contextFile: null }),
      match({ domain: 'c', contextFile: null }),
    ]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: readerFor({}),
  });
  // DOMAIN_MATCH_TOP_N is 2 (provisional) — a hand-edited state file cannot
  // blow the dispatch budget by sheer entry count.
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.domain), ['a', 'b']);
});

test('domain-context-load › contextFile paths resolve against repoRoot for the injected reader', () => {
  /** @type {string[]} */
  const seenPaths = [];
  loadDomainContextForDispatch({
    repoRoot: REPO_ROOT,
    state: state([match({ domain: 'billing' })]),
    maxTokens: DOMAIN_CONTEXT_MAX_TOKENS,
    readFile: (p) => {
      seenPaths.push(p);
      return null;
    },
  });
  assert.equal(seenPaths.length, 1);
  assert.ok(isAbsolute(seenPaths[0]));
  assert.match(seenPaths[0].replaceAll('\\', '/'), /repo\/\.devmate\/contexts\/billing\.md$/);
});

test('checkDomainContextFiles › reports declared-but-missing files with id + path, skips null contextFile', () => {
  const domains = [
    { domain: 'billing', keywords: [], globs: ['x/**'], contextFile: '.devmate/contexts/billing.md' },
    { domain: 'orders', keywords: [], globs: ['y/**'], contextFile: '.devmate/contexts/orders.md' },
    { domain: 'shipping', keywords: [], globs: ['z/**'], contextFile: null },
  ];
  const result = checkDomainContextFiles(
    REPO_ROOT,
    domains,
    (p) => p.replaceAll('\\', '/').endsWith('.devmate/contexts/billing.md'),
  );
  assert.deepEqual(result.present, ['billing']);
  assert.deepEqual(result.missing, ['orders (.devmate/contexts/orders.md)']);
});

test('checkDomainContextFiles › all-valid and empty-domains cases produce no missing entries', () => {
  assert.deepEqual(checkDomainContextFiles(REPO_ROOT, [], () => true), {
    missing: [],
    present: [],
  });
  const domains = [
    { domain: 'billing', keywords: [], globs: ['x/**'], contextFile: '.devmate/contexts/billing.md' },
  ];
  assert.deepEqual(checkDomainContextFiles(REPO_ROOT, domains, () => true), {
    missing: [],
    present: ['billing'],
  });
});
