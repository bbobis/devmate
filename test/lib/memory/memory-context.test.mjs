// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryContext } from '../../../lib/memory/memory-context.mjs';

/**
 * @param {Partial<import('../../../lib/types.mjs').MemoryMatch>} over
 * @returns {import('../../../lib/types.mjs').MemoryMatch}
 */
function match(over) {
  return {
    source: 'lib/auth.mjs',
    summary: 'uses JWT RS256',
    tags: [],
    lane: 'feature',
    confidence: 0.8,
    score: 0.5,
    ts: 1,
    isPointerSummary: false,
    ...over,
  };
}

test('buildMemoryContext returns empty string for no matches', () => {
  assert.equal(buildMemoryContext([]), '');
  assert.equal(buildMemoryContext(/** @type {any} */ (undefined)), '');
});

test('buildMemoryContext renders a marker-tagged block with one line per match', () => {
  const block = buildMemoryContext([
    match({ source: 'lib/auth.mjs', summary: 'uses JWT RS256' }),
    match({ source: 'lib/db.mjs', summary: 'pg pool max 10', lane: 'bug', confidence: 0.6 }),
  ]);
  assert.match(block, /^<devmate-memory>/);
  assert.match(block, /<\/devmate-memory>$/);
  // Header nudges verify-before-use.
  assert.match(block, /Verify against current code/);
  assert.match(block, /- lib\/auth\.mjs — uses JWT RS256 \[lane: feature, conf: 0\.80\]/);
  assert.match(block, /- lib\/db\.mjs — pg pool max 10 \[lane: bug, conf: 0\.60\]/);
});

test('buildMemoryContext applies an optional scope label and handles unknown lane', () => {
  const block = buildMemoryContext([match({ lane: 'unknown' })], { label: 'portals-api' });
  assert.match(block, /Recalled facts \(portals-api\)/);
  assert.match(block, /\[lane: -, conf: 0\.80\]/);
});
