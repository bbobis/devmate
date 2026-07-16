// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mergeDiscoveryArtifacts,
  validateDiscoveryArtifact,
} from '../../../../lib/workflow/agents/discovery.mjs';

/**
 * @typedef {import('../../../../lib/types.mjs').MergedDiscoveryArtifact} MergedDiscoveryArtifact
 */

/**
 * @param {string} fact
 * @param {string} path
 * @param {'high'|'low'} confidence
 */
function claim(fact, path, confidence) {
  return { fact, path, confidence };
}

/**
 * Every merged artifact must pass the existing validator (acceptance
 * criterion: "every merged output validates against the existing validator").
 * @param {MergedDiscoveryArtifact} merged
 */
function assertValid(merged) {
  const { ok, errors } = validateDiscoveryArtifact(merged);
  assert.equal(ok, true, `merged artifact should validate: ${errors.join('; ')}`);
}

test('mergeDiscoveryArtifacts / empty artifacts array returns an empty artifact and zeroed stats', () => {
  const result = mergeDiscoveryArtifacts([], { maxClaims: 5 });

  assert.deepEqual(result.merged, { agentName: 'discovery', claims: [], unverified: [] });
  assert.deepEqual(result.stats, {
    inputClaims: 0,
    mergedClaims: 0,
    exactDups: 0,
    nearDups: 0,
    corroborated: 0,
    needsReview: 0,
    dropped: 0,
    invalidInputs: 0,
  });
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / single artifact passthrough — normalized, capped, stats populated', () => {
  const artifacts = [
    {
      claims: [
        claim('The router loads config', 'lib\\router.mjs', 'high'),
        claim('The gate denies on uncertainty', 'lib/gate.mjs#L12', 'low'),
      ],
      unverified: ['[UNVERIFIED] legacy note'],
    },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 2);
  assert.deepEqual(
    result.merged.claims.map((c) => c.fact).sort(),
    ['The gate denies on uncertainty', 'The router loads config'].sort()
  );
  // rule 1: backslash separators normalize to forward slashes in the output path.
  const routerClaim = result.merged.claims.find((c) => c.fact === 'The router loads config');
  assert.equal(routerClaim?.path, 'lib/router.mjs');
  for (const mergedClaim of result.merged.claims) {
    assert.equal(mergedClaim.corroboration, 1);
    assert.deepEqual(mergedClaim.sources, ['0']);
    assert.equal(mergedClaim.needsReview, undefined);
  }
  assert.deepEqual(result.merged.unverified, ['[UNVERIFIED] legacy note']);
  assert.equal(result.stats.inputClaims, 2);
  assert.equal(result.stats.mergedClaims, 2);
  assert.equal(result.stats.exactDups, 0);
  assert.equal(result.stats.nearDups, 0);
  assert.equal(result.stats.dropped, 0);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / rule 1 — backslash path separators normalize to forward slashes, including on a near-dup canonical swap and a dropped-cap entry', () => {
  const canonicalSwap = mergeDiscoveryArtifacts(
    [
      { claims: [claim('a b c d', 'lib\\short.mjs', 'low')], unverified: [] },
      { claims: [claim('a b c d e', 'lib\\short.mjs#L5', 'low')], unverified: [] },
    ],
    { maxClaims: 10 }
  );
  assert.equal(canonicalSwap.merged.claims.length, 1);
  // The longer fact's claim (with the backslash path) becomes canonical —
  // its path must still come out slash-normalized.
  assert.equal(canonicalSwap.merged.claims[0].path, 'lib/short.mjs#L5');

  const droppedByCap = mergeDiscoveryArtifacts(
    [
      {
        claims: [claim('kept claim', 'a.mjs', 'high'), claim('dropped claim', 'lib\\dropped.mjs', 'low')],
        unverified: [],
      },
    ],
    { maxClaims: 1 }
  );
  assert.deepEqual(droppedByCap.merged.unverified, [
    '[UNVERIFIED] — dropped by merge cap: dropped claim (lib/dropped.mjs)',
  ]);
  assertValid(canonicalSwap.merged);
  assertValid(droppedByCap.merged);
});

test('mergeDiscoveryArtifacts / rule 2 — exact dedup case-folds, collapses whitespace, strips trailing punctuation, and unions sources', () => {
  const artifacts = [
    { claims: [claim('Foo   does X.', 'lib/foo.mjs#L10', 'low')], unverified: [] },
    { claims: [claim('foo does x', 'lib/foo.mjs#L10', 'high')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 1);
  const merged = result.merged.claims[0];
  assert.equal(merged.confidence, 'high'); // highest confidence kept
  assert.equal(merged.corroboration, 2);
  assert.deepEqual([...(merged.sources ?? [])].sort(), ['0', '1']);
  assert.equal(result.stats.exactDups, 1);
  assert.equal(result.stats.nearDups, 0);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / corroboration is counted per distinct source artifact, not per duplicate claim', () => {
  const artifacts = [
    {
      claims: [claim('dup fact', 'lib/dup.mjs', 'low'), claim('dup fact', 'lib/dup.mjs', 'low')],
      unverified: [],
    },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 1);
  assert.equal(result.merged.claims[0].corroboration, 1); // one artifact, not two claims
  assert.equal(result.stats.exactDups, 1);
  assert.equal(result.stats.corroborated, 0); // corroboration stayed at 1, no upgrade
  assert.equal(result.merged.claims[0].confidence, 'low');
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / rule 3 — near-dup merges via token-set Jaccard and keeps the longer fact as canonical', () => {
  const artifacts = [
    { claims: [claim('a b c d', 'x.mjs', 'low')], unverified: [] },
    { claims: [claim('a b c d e', 'x.mjs#L5', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 1);
  const merged = result.merged.claims[0];
  assert.equal(merged.fact, 'a b c d e'); // longer fact is canonical
  assert.equal(merged.path, 'x.mjs#L5'); // canonical claim's own path
  assert.equal(merged.corroboration, 2);
  assert.equal(merged.confidence, 'high'); // rule 4: corroboration >= 2 upgrades low -> high
  assert.equal(result.stats.nearDups, 1);
  assert.equal(result.stats.exactDups, 0);
  assert.equal(result.stats.corroborated, 1);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / near-dup threshold boundary — inclusive comparison at exactly the configured threshold', () => {
  // jaccard('a b c d', 'a b c d e') === 4/5 === 0.8 exactly.
  const artifacts = [
    { claims: [claim('a b c d', 'x.mjs', 'low')], unverified: [] },
    { claims: [claim('a b c d e', 'x.mjs', 'low')], unverified: [] },
  ];

  const merges079 = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10, nearDupThreshold: 0.79 });
  assert.equal(merges079.merged.claims.length, 1, '0.8 >= 0.79 should merge');

  const merges080 = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10, nearDupThreshold: 0.8 });
  assert.equal(merges080.merged.claims.length, 1, '0.8 >= 0.80 should merge (inclusive)');

  const merges081 = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10, nearDupThreshold: 0.81 });
  assert.equal(merges081.merged.claims.length, 2, '0.8 < 0.81 should NOT merge');
  assert.equal(merges081.stats.needsReview, 1); // same file, 2 distinct unmerged claims
  assertValid(merges079.merged);
  assertValid(merges080.merged);
  assertValid(merges081.merged);
});

test('mergeDiscoveryArtifacts / different filePath never merges, even with an identical fact', () => {
  const artifacts = [
    { claims: [claim('same fact text', 'a.mjs', 'high')], unverified: [] },
    { claims: [claim('same fact text', 'b.mjs', 'high')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 2);
  assert.equal(result.stats.exactDups, 0);
  assert.equal(result.stats.needsReview, 0); // different files, no conflict
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / anchor overlap — anchorless claims on the same file share a dedup key', () => {
  const artifacts = [
    { claims: [claim('a b c d', 'lib/router.mjs', 'low')], unverified: [] },
    { claims: [claim('a b c d e', 'lib/router.mjs', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 1);
  assert.equal(result.stats.nearDups, 1);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / anchor overlap — overlapping anchored ranges on the same file merge', () => {
  const artifacts = [
    { claims: [claim('a b c d', 'lib/a.mjs#L10-L20', 'low')], unverified: [] },
    { claims: [claim('a b c d e', 'lib/a.mjs#L15-L25', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 1);
  assert.equal(result.merged.claims[0].path, 'lib/a.mjs#L15-L25');
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / anchor overlap — non-overlapping anchored ranges on the same file do not merge, and surface a conflict', () => {
  const artifacts = [
    { claims: [claim('a b c d', 'lib/a.mjs#L1-L5', 'high')], unverified: [] },
    { claims: [claim('a b c d e', 'lib/a.mjs#L100-L110', 'high')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims.length, 2);
  assert.equal(result.stats.needsReview, 1);
  assert.equal(result.merged.claims.every((c) => c.needsReview === true), true);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / anchored vs anchorless pair on the same file merges only when facts are near-dup', () => {
  const notNearDup = mergeDiscoveryArtifacts(
    [
      { claims: [claim('a b c d', 'lib/b.mjs', 'high')], unverified: [] },
      { claims: [claim('x y z', 'lib/b.mjs#L5', 'high')], unverified: [] },
    ],
    { maxClaims: 10 }
  );
  assert.equal(notNearDup.merged.claims.length, 2, 'unrelated facts on the same file, one anchored, should not merge');
  assert.equal(notNearDup.stats.needsReview, 1);

  const nearDup = mergeDiscoveryArtifacts(
    [
      { claims: [claim('a b c d', 'lib/b.mjs', 'high')], unverified: [] },
      { claims: [claim('a b c d e', 'lib/b.mjs#L5', 'high')], unverified: [] },
    ],
    { maxClaims: 10 }
  );
  assert.equal(nearDup.merged.claims.length, 1, 'near-dup facts on the same file should merge despite mixed anchoring');
  assert.equal(nearDup.merged.claims[0].path, 'lib/b.mjs#L5');
  assertValid(notNearDup.merged);
  assertValid(nearDup.merged);
});

test('mergeDiscoveryArtifacts / rule 6 — rank before cap: corroboration desc, confidence, first-seen order; overflow becomes unverified', () => {
  // X: corroboration 3, starts low -> upgraded to high by rule 4.
  // Y: corroboration 2, starts high.
  // Z: corroboration 1, high.
  // W: corroboration 1, low.
  // Expected rank: X, Y, Z, W.
  const artifacts = [
    {
      claims: [
        claim('claim X', 'fX.mjs', 'low'),
        claim('claim Y', 'fY.mjs', 'high'),
        claim('claim Z', 'fZ.mjs', 'high'),
        claim('claim W', 'fW.mjs', 'low'),
      ],
      unverified: ['[UNVERIFIED] alpha'],
    },
    {
      claims: [claim('claim X', 'fX.mjs', 'low'), claim('claim Y', 'fY.mjs', 'high')],
      unverified: ['[UNVERIFIED] alpha', '[UNVERIFIED] beta'],
    },
    { claims: [claim('claim X', 'fX.mjs', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 2 });

  assert.equal(result.merged.claims.length, 2);
  assert.deepEqual(result.merged.claims.map((c) => c.fact), ['claim X', 'claim Y']);
  assert.equal(result.merged.claims[0].corroboration, 3);
  assert.equal(result.merged.claims[1].corroboration, 2);
  assert.equal(result.stats.corroborated, 1); // only X was upgraded low -> high
  assert.equal(result.stats.dropped, 2);
  assert.equal(result.stats.mergedClaims, 2);

  // Unverified union preserves first-appearance order, then dropped-cap entries
  // in rank order (Z before W).
  assert.deepEqual(result.merged.unverified, [
    '[UNVERIFIED] alpha',
    '[UNVERIFIED] beta',
    '[UNVERIFIED] — dropped by merge cap: claim Z (fZ.mjs)',
    '[UNVERIFIED] — dropped by merge cap: claim W (fW.mjs)',
  ]);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / rank tie-break falls back to stable first-seen input order', () => {
  const artifacts = [
    { claims: [claim('first seen', 'a.mjs', 'high'), claim('second seen', 'b.mjs', 'high')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.deepEqual(result.merged.claims.map((c) => c.fact), ['first seen', 'second seen']);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / rule 4 never downgrades an already-high claim', () => {
  const artifacts = [{ claims: [claim('solo claim', 'solo.mjs', 'high')], unverified: [] }];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.merged.claims[0].confidence, 'high');
  assert.equal(result.stats.corroborated, 0);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / an input artifact failing validateDiscoveryArtifact is skipped, never thrown', () => {
  const artifacts = [
    { claims: [claim('valid claim', 'valid.mjs', 'high')], unverified: [] },
    { claims: 'not-an-array', unverified: [] },
    { claims: [{ fact: '', path: 'missing-fact.mjs', confidence: 'high' }], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.equal(result.stats.invalidInputs, 2);
  assert.equal(result.merged.claims.length, 1);
  assert.equal(result.stats.inputClaims, 1);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / opts.maxClaims missing or invalid throws (programmer error)', () => {
  const artifacts = [{ claims: [claim('a', 'a.mjs', 'high')], unverified: [] }];

  assert.throws(() => mergeDiscoveryArtifacts(artifacts, /** @type {any} */ ({})));
  assert.throws(() => mergeDiscoveryArtifacts(artifacts, { maxClaims: 0 }));
  assert.throws(() => mergeDiscoveryArtifacts(artifacts, { maxClaims: -1 }));
  assert.throws(() => mergeDiscoveryArtifacts(artifacts, { maxClaims: NaN }));
  assert.throws(() => mergeDiscoveryArtifacts(artifacts, /** @type {any} */ ({ maxClaims: 'five' })));
});

test('mergeDiscoveryArtifacts / opts.nearDupThreshold out of [0,1] throws (programmer error)', () => {
  const artifacts = [{ claims: [claim('a', 'a.mjs', 'high')], unverified: [] }];

  assert.throws(() => mergeDiscoveryArtifacts(artifacts, { maxClaims: 1, nearDupThreshold: -0.1 }));
  assert.throws(() => mergeDiscoveryArtifacts(artifacts, { maxClaims: 1, nearDupThreshold: 1.1 }));
});

test('mergeDiscoveryArtifacts / opts.workerIds label sources when provided', () => {
  const artifacts = [
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10, workerIds: ['scan-by-name', 'scan-by-content'] });

  assert.deepEqual([...(result.merged.claims[0].sources ?? [])].sort(), ['scan-by-content', 'scan-by-name']);
});

test('mergeDiscoveryArtifacts / duplicate opts.workerIds labels never under-count corroboration', () => {
  // Corroboration identity is the artifact index, not the caller-supplied
  // label — three distinct artifacts sharing the same workerId label must
  // still count as 3 distinct sources.
  const artifacts = [
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, {
    maxClaims: 10,
    workerIds: ['dup', 'dup', 'dup'],
  });

  assert.equal(result.merged.claims.length, 1);
  assert.equal(result.merged.claims[0].corroboration, 3);
  assert.equal(result.merged.claims[0].confidence, 'high'); // corroboration >= 2 upgrades
  assert.deepEqual(result.merged.claims[0].sources, ['dup']); // label set collapses; identity does not
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / an empty-string opts.workerIds entry falls back to the index label without harming corroboration identity', () => {
  const artifacts = [
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
    { claims: [claim('shared fact', 'shared.mjs', 'low')], unverified: [] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10, workerIds: ['', ''] });

  assert.equal(result.merged.claims[0].corroboration, 2);
  assert.deepEqual([...(result.merged.claims[0].sources ?? [])].sort(), ['0', '1']);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / rule 7 — unverified union exact-dedupes and preserves first-appearance order', () => {
  const artifacts = [
    { claims: [], unverified: ['[UNVERIFIED] a', '[UNVERIFIED] b'] },
    { claims: [], unverified: ['[UNVERIFIED] b', '[UNVERIFIED] c'] },
  ];

  const result = mergeDiscoveryArtifacts(artifacts, { maxClaims: 10 });

  assert.deepEqual(result.merged.unverified, ['[UNVERIFIED] a', '[UNVERIFIED] b', '[UNVERIFIED] c']);
  assertValid(result.merged);
});

test('mergeDiscoveryArtifacts / is pure — never mutates input artifacts, and is deterministic across runs', () => {
  const artifacts = [
    {
      claims: [claim('a b c d', 'x.mjs', 'low'), claim('claim Z', 'fZ.mjs', 'high')],
      unverified: ['[UNVERIFIED] alpha'],
    },
    { claims: [claim('a b c d e', 'x.mjs#L5', 'low')], unverified: ['[UNVERIFIED] beta'] },
  ];
  const before = JSON.parse(JSON.stringify(artifacts));

  const run1 = mergeDiscoveryArtifacts(artifacts, { maxClaims: 1, workerIds: ['w0', 'w1'] });
  assert.deepEqual(artifacts, before, 'input artifacts must not be mutated');

  const run2 = mergeDiscoveryArtifacts(artifacts, { maxClaims: 1, workerIds: ['w0', 'w1'] });
  assert.deepEqual(run1, run2, 'merge output must be deterministic across runs');
  assertValid(run1.merged);
});
