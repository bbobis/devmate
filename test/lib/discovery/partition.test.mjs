// @ts-check
/**
 * FO-5: partitionCandidates — deterministic, disjoint candidate partitioning
 * for the two-phase discovery fan-out. Disjointness is the hard invariant:
 * no path in two partitions, union == input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionCandidates } from '../../../lib/discovery/partition.mjs';

/**
 * Build a minimal candidate for a path.
 * @param {string} path
 * @returns {{ path: string }}
 */
function c(path) {
  return { path };
}

/**
 * Assert the hard invariants: no path in two partitions; union == input.
 * @param {Array<Array<{ path: string }>>} partitions
 * @param {Array<{ path: string }>} input
 */
function assertDisjointUnion(partitions, input) {
  const flat = partitions.flat();
  assert.equal(flat.length, input.length, 'union size equals input size');
  const seen = new Set();
  for (const candidate of flat) {
    assert.ok(!seen.has(candidate.path), `path "${candidate.path}" appears in two partitions`);
    seen.add(candidate.path);
  }
  for (const candidate of input) {
    assert.ok(seen.has(candidate.path), `input path "${candidate.path}" missing from union`);
  }
}

test('partitionCandidates › throws on a non-array candidates value', () => {
  for (const bad of [null, undefined, 'lib/a.mjs', { path: 'x' }]) {
    assert.throws(
      () => partitionCandidates(/** @type {any} */ (bad), 2),
      /candidates to be an array/,
    );
  }
});

test('partitionCandidates › throws on an invalid k (config error, never coerced)', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, '2']) {
    assert.throws(
      () => partitionCandidates([c('lib/a.mjs')], /** @type {any} */ (bad)),
      /k to be an integer >= 1/,
    );
  }
});

test('partitionCandidates › empty input returns no partitions', () => {
  assert.deepEqual(partitionCandidates([], 3), []);
});

test('partitionCandidates › k=1 returns a single partition with every candidate', () => {
  const input = [c('lib/a.mjs'), c('test/b.test.mjs'), c('docs/c.md')];
  const partitions = partitionCandidates(input, 1);
  assert.equal(partitions.length, 1);
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › disjointness + union hold across shapes and k values', () => {
  const inputs = [
    [c('lib/a.mjs')],
    [c('lib/a.mjs'), c('lib/b.mjs'), c('test/a.test.mjs')],
    [
      c('lib/workflow/a.mjs'),
      c('lib/workflow/agents/b.mjs'),
      c('lib/discovery/c.mjs'),
      c('test/lib/workflow/a.test.mjs'),
      c('docs/x.md'),
      c('scripts/y.mjs'),
      c('README.md'),
    ],
  ];
  for (const input of inputs) {
    for (const k of [1, 2, 3, 5]) {
      assertDisjointUnion(partitionCandidates(input, k), input);
    }
  }
});

test('partitionCandidates › same top-level directory stays in one partition (affinity)', () => {
  const input = [
    c('lib/workflow/a.mjs'),
    c('lib/discovery/b.mjs'),
    c('test/one.test.mjs'),
    c('test/two.test.mjs'),
    c('docs/x.md'),
    c('docs/y.md'),
  ];
  const partitions = partitionCandidates(input, 3);
  for (const top of ['lib/', 'test/', 'docs/']) {
    const owners = partitions.filter((p) => p.some((cand) => cand.path.startsWith(top)));
    assert.equal(owners.length, 1, `all ${top} candidates share one partition`);
  }
});

test('partitionCandidates › repo-root files group together', () => {
  const input = [c('README.md'), c('CHANGELOG.md'), c('lib/a.mjs'), c('lib/b.mjs')];
  const partitions = partitionCandidates(input, 2);
  const rootOwners = partitions.filter((p) => p.some((cand) => !cand.path.includes('/')));
  assert.equal(rootOwners.length, 1, 'root-level files share one partition');
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › backslash-separated paths group with their slash siblings', () => {
  const input = [c('lib\\workflow\\a.mjs'), c('lib/workflow/b.mjs'), c('docs/x.md')];
  const partitions = partitionCandidates(input, 2);
  const libOwners = partitions.filter((p) =>
    p.some((cand) => cand.path.split('\\').join('/').startsWith('lib/')),
  );
  assert.equal(libOwners.length, 1, 'both lib candidates share one partition');
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › balances whole groups by candidate count', () => {
  // Four groups of sizes 3, 2, 2, 1 onto k=2: greedy-by-count yields 4 / 4.
  const input = [
    c('lib/a.mjs'), c('lib/b.mjs'), c('lib/c.mjs'),
    c('test/a.test.mjs'), c('test/b.test.mjs'),
    c('docs/a.md'), c('docs/b.md'),
    c('scripts/a.mjs'),
  ];
  const partitions = partitionCandidates(input, 2);
  assert.equal(partitions.length, 2);
  const sizes = partitions.map((p) => p.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [4, 4]);
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › never splits a group at or below ceil(total/k)*1.5', () => {
  // total=8, k=2 -> threshold ceil(8/2)*1.5 = 6. The 6-strong lib group must
  // stay whole even though splitting it would balance better.
  const input = [
    c('lib/a.mjs'), c('lib/b.mjs'), c('lib/c.mjs'),
    c('lib/d.mjs'), c('lib/e.mjs'), c('lib/f.mjs'),
    c('docs/x.md'), c('docs/y.md'),
  ];
  const partitions = partitionCandidates(input, 2);
  const libOwners = partitions.filter((p) => p.some((cand) => cand.path.startsWith('lib/')));
  assert.equal(libOwners.length, 1, 'the at-threshold group is not split');
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › splits an oversized group by subdirectory', () => {
  // total=8, k=2 -> threshold 6; the 7-strong lib group must split, and the
  // split follows subdirectory boundaries (workflow vs discovery).
  const input = [
    c('lib/workflow/a.mjs'), c('lib/workflow/b.mjs'), c('lib/workflow/c.mjs'),
    c('lib/workflow/d.mjs'),
    c('lib/discovery/e.mjs'), c('lib/discovery/f.mjs'), c('lib/discovery/g.mjs'),
    c('docs/x.md'),
  ];
  const partitions = partitionCandidates(input, 2);
  assertDisjointUnion(partitions, input);
  const workflowOwners = partitions.filter((p) =>
    p.some((cand) => cand.path.startsWith('lib/workflow/')),
  );
  const discoveryOwners = partitions.filter((p) =>
    p.some((cand) => cand.path.startsWith('lib/discovery/')),
  );
  assert.equal(workflowOwners.length, 1, 'lib/workflow subtree stays together');
  assert.equal(discoveryOwners.length, 1, 'lib/discovery subtree stays together');
});

test('partitionCandidates › splits a single oversized flat directory by chunking', () => {
  // Every candidate sits directly in lib/: no subdirectory distinguishes
  // them, so the oversized group falls back to deterministic chunks.
  const input = Array.from({ length: 10 }, (_, i) => c(`lib/f${i}.mjs`));
  const partitions = partitionCandidates(input, 2);
  assert.ok(partitions.length >= 2, 'oversized flat group is split');
  assertDisjointUnion(partitions, input);
});

test('partitionCandidates › returns at most k partitions', () => {
  const input = [
    c('lib/a.mjs'), c('test/b.test.mjs'), c('docs/c.md'),
    c('scripts/d.mjs'), c('hooks/e.mjs'),
  ];
  for (const k of [1, 2, 3]) {
    assert.ok(partitionCandidates(input, k).length <= k, `k=${k} respects the bound`);
  }
});

test('partitionCandidates › deterministic: same input, same output', () => {
  const input = [
    c('lib/workflow/a.mjs'), c('lib/discovery/b.mjs'), c('test/a.test.mjs'),
    c('docs/x.md'), c('scripts/y.mjs'), c('README.md'),
  ];
  const first = partitionCandidates(input, 3);
  const second = partitionCandidates(input, 3);
  assert.deepEqual(first, second);
});

test('partitionCandidates › pure: input array and members are not mutated', () => {
  const input = [c('lib/a.mjs'), c('test/b.test.mjs'), c('docs/c.md')];
  const snapshot = JSON.parse(JSON.stringify(input));
  partitionCandidates(input, 2);
  assert.deepEqual(input, snapshot);
});

test('partitionCandidates › partitions carry the original candidate objects', () => {
  const input = [
    { path: 'lib/a.mjs', score: 42, why: 'name match' },
    { path: 'docs/b.md', score: 7, why: 'content match' },
  ];
  const partitions = partitionCandidates(input, 2);
  const flat = partitions.flat();
  for (const candidate of input) {
    assert.ok(flat.includes(candidate), `original object for ${candidate.path} is preserved`);
  }
});
