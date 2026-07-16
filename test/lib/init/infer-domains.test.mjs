// @ts-check
/**
 * DN-4: inferDomains — pure, deterministic draft-domain inference.
 * Fixtures are in-memory file lists (the walker-output contract), so no
 * filesystem is touched at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferDomains,
  MIN_FILES_PER_DOMAIN,
  MAX_INFERRED_DOMAINS,
} from '../../../lib/init/infer-domains.mjs';

const REPO_ROOT = '/repo';

/** A two-package monorepo plus a src tree. */
function monorepoFileList() {
  return [
    'package.json',
    'packages/billing/package.json',
    'packages/billing/src/index.ts',
    'packages/billing/src/invoice-service.ts',
    'packages/billing/src/refund-handler.ts',
    'packages/billing/src/invoice-schema.ts',
    'packages/billing/test/invoice-service.test.ts',
    'packages/orders/package.json',
    'packages/orders/src/index.ts',
    'packages/orders/src/order-intake.ts',
    'packages/orders/src/fulfillment.ts',
    'README.md',
  ];
}

test('inferDomains › workspace packages become domains with globs, keywords, entry points, and stubs', () => {
  const { domains, stubs, droppedDomains } = inferDomains({
    repoRoot: REPO_ROOT,
    fileList: monorepoFileList(),
    candidatesArtifact: null,
  });

  assert.deepEqual(droppedDomains, []);
  assert.deepEqual(domains.map((d) => d.domain), ['billing', 'orders']);

  const billing = domains[0];
  assert.deepEqual(billing.globs, ['packages/billing/**']);
  assert.equal(billing.contextFile, '.devmate/contexts/billing.md');
  assert.ok(billing.keywords.includes('billing'), 'dir-name token is a keyword');
  assert.ok(billing.keywords.includes('invoice'), 'frequent basename token is a keyword');
  assert.ok(!billing.keywords.includes('package'), 'generic manifest token excluded');
  assert.deepEqual(billing.entryPoints, ['packages/billing/src/index.ts']);

  // One stub per domain, from the DRAFT template.
  assert.deepEqual(Object.keys(stubs).sort(), ['billing', 'orders']);
  const stub = stubs['billing'];
  assert.match(stub, /^# billing — domain context \(DRAFT — edit before applying\)/);
  assert.match(stub, /## Key entry files/);
  assert.match(stub, /packages\/billing\/src\/index\.ts/);
  assert.match(stub, /## Invariants \(what NOT to touch\)/);
  assert.match(stub, /## Tests to run for this domain/);
  assert.match(stub, /packages\/billing\/test\/invoice-service\.test\.ts/);
  assert.match(stub, /## Cross-domain contracts/);
});

test('inferDomains › src subdirectories need MIN_FILES_PER_DOMAIN files; smaller dirs are excluded', () => {
  const fileList = [
    // src/billing: exactly at threshold.
    ...Array.from({ length: MIN_FILES_PER_DOMAIN }, (_, i) => `src/billing/invoice-${i}.ts`),
    // src/tiny: below threshold.
    'src/tiny/one.ts',
    'src/tiny/two.ts',
  ];
  const { domains } = inferDomains({ repoRoot: REPO_ROOT, fileList, candidatesArtifact: null });
  assert.deepEqual(domains.map((d) => d.domain), ['billing']);
  assert.deepEqual(domains[0].globs, ['src/billing/**']);
});

test('inferDomains › candidates artifact adds an uncovered cluster; null branch is first-class', () => {
  const clusterFiles = Array.from(
    { length: MIN_FILES_PER_DOMAIN },
    (_, i) => `services/payments/gateway-${i}.ts`,
  );
  const fileList = [...monorepoFileList(), ...clusterFiles];
  const artifact = { candidates: clusterFiles.map((path) => ({ path, score: 1 })) };

  const withArtifact = inferDomains({ repoRoot: REPO_ROOT, fileList, candidatesArtifact: artifact });
  assert.ok(
    withArtifact.domains.some((d) => d.domain === 'payments'),
    'candidate cluster becomes a domain',
  );

  const withoutArtifact = inferDomains({ repoRoot: REPO_ROOT, fileList, candidatesArtifact: null });
  assert.ok(
    !withoutArtifact.domains.some((d) => d.domain === 'payments'),
    'without the artifact the cluster is not a domain',
  );
  assert.deepEqual(
    withoutArtifact.domains.map((d) => d.domain),
    ['billing', 'orders'],
  );
});

test('inferDomains › candidate paths already covered by a domain do not add a duplicate', () => {
  const artifact = {
    candidates: [
      { path: 'packages/billing/src/invoice-service.ts' },
      { path: 'packages/billing/src/refund-handler.ts' },
    ],
  };
  const { domains } = inferDomains({
    repoRoot: REPO_ROOT,
    fileList: monorepoFileList(),
    candidatesArtifact: artifact,
  });
  assert.deepEqual(domains.map((d) => d.domain), ['billing', 'orders']);
});

test('inferDomains › deterministic: same tree (any input order) yields deep-equal output', () => {
  const first = inferDomains({
    repoRoot: REPO_ROOT,
    fileList: monorepoFileList(),
    candidatesArtifact: null,
  });
  const second = inferDomains({
    repoRoot: REPO_ROOT,
    fileList: [...monorepoFileList()].reverse(),
    candidatesArtifact: null,
  });
  assert.deepEqual(second, first);
});

test('inferDomains › caps at MAX_INFERRED_DOMAINS keeping the largest, reporting the dropped', () => {
  /** @type {string[]} */
  const fileList = [];
  const total = MAX_INFERRED_DOMAINS + 2;
  for (let d = 0; d < total; d++) {
    // Later dirs get more files so the smallest two (dom-00, dom-01) drop.
    fileList.push(`packages/dom-${String(d).padStart(2, '0')}/package.json`);
    for (let f = 0; f < d + 1; f++) {
      fileList.push(`packages/dom-${String(d).padStart(2, '0')}/file-${f}.ts`);
    }
  }
  const { domains, droppedDomains } = inferDomains({
    repoRoot: REPO_ROOT,
    fileList,
    candidatesArtifact: null,
  });
  assert.equal(domains.length, MAX_INFERRED_DOMAINS);
  assert.deepEqual(droppedDomains.sort(), ['dom-00', 'dom-01']);
});

test('inferDomains › empty file list yields no domains and no stubs', () => {
  const result = inferDomains({ repoRoot: REPO_ROOT, fileList: [], candidatesArtifact: null });
  assert.deepEqual(result, { domains: [], stubs: {}, droppedDomains: [] });
});

test('inferDomains › nested package manifests do not create a domain inside a package', () => {
  const fileList = [
    'packages/billing/package.json',
    'packages/billing/src/index.ts',
    'packages/billing/vendor/thing/package.json',
    'packages/billing/vendor/thing/index.js',
  ];
  const { domains } = inferDomains({ repoRoot: REPO_ROOT, fileList, candidatesArtifact: null });
  assert.deepEqual(domains.map((d) => d.domain), ['billing']);
});
