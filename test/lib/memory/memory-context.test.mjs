// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryContext,
  buildMemoryFallbackContext,
  MEMORY_FALLBACK_MAX_LINES,
  MEMORY_FALLBACK_MAX_LINE_LEN,
} from '../../../lib/memory/memory-context.mjs';

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

test('buildMemoryFallbackContext #149: returns empty for empty/blank/non-string input', () => {
  assert.equal(buildMemoryFallbackContext(''), '');
  assert.equal(buildMemoryFallbackContext('   \n  \n'), '');
  assert.equal(buildMemoryFallbackContext(/** @type {any} */ (undefined)), '');
});

test('buildMemoryFallbackContext #149: wraps committed content in a verify-first block, dropping sentinel/blank lines', () => {
  const md = [
    '# Memory',
    '',
    '<!-- devmate:facts:start -->',
    '## lib/auth.mjs',
    '- uses JWT RS256 (task: t1, added: 2026-01-01T00:00:00.000Z)',
    '',
    '<!-- devmate:facts:end -->',
  ].join('\n');
  const block = buildMemoryFallbackContext(md);
  assert.match(block, /^<devmate-memory>/);
  assert.match(block, /<\/devmate-memory>$/);
  assert.match(block, /fresh checkout/);
  assert.match(block, /Verify against current code/);
  assert.match(block, /## lib\/auth\.mjs/);
  assert.match(block, /uses JWT RS256/);
  // Sentinel comment lines and blank padding are dropped.
  assert.doesNotMatch(block, /devmate:facts:start/);
  assert.equal(block.includes('\n\n'), false);
});

test('buildMemoryFallbackContext #149: bounds to maxLines and appends a truncation marker — never an unbounded dump', () => {
  /** @type {string[]} */
  const rows = [];
  for (let i = 0; i < MEMORY_FALLBACK_MAX_LINES + 15; i += 1) {
    rows.push(`- fact ${i}`);
  }
  const block = buildMemoryFallbackContext(rows.join('\n'), { maxLines: MEMORY_FALLBACK_MAX_LINES });
  assert.match(block, /15 more line\(s\) in the committed memory file/);
  assert.equal(block.includes('- fact 0'), true);
  // The line just past the cap must NOT be present.
  assert.equal(block.includes(`- fact ${MEMORY_FALLBACK_MAX_LINES}`), false);
});

test('buildMemoryFallbackContext #149: clamps a single very long line (bounded by bytes, not just line count)', () => {
  const longSummary = 'x'.repeat(MEMORY_FALLBACK_MAX_LINE_LEN + 500);
  const block = buildMemoryFallbackContext(`- ${longSummary}`);
  const factLine = block.split('\n').find((l) => l.startsWith('- '));
  assert.ok(factLine, 'the fact line is present');
  assert.ok(
    factLine.length <= MEMORY_FALLBACK_MAX_LINE_LEN + 2,
    `a long line is clamped (got ${factLine?.length} chars)`,
  );
  assert.match(block, /…$/m, 'a clamped line ends with an ellipsis');
});
