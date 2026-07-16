// @ts-check
/**
 * Tests for lib/skills/trigram.mjs — morphological token matching and its
 * start-boundary guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trigramSimilarity, morphologicallyMatches } from '../../../lib/skills/trigram.mjs';

test('trigramSimilarity › identical tokens score 1', () => {
  assert.equal(trigramSimilarity('debug', 'debug'), 1);
});

test('trigramSimilarity › empty token scores 0', () => {
  assert.equal(trigramSimilarity('', 'debug'), 0);
});

test('morphologicallyMatches › unifies inflected forms above the threshold', () => {
  for (const [a, b] of [
    ['test', 'tests'],
    ['throw', 'throws'],
    ['vulnerability', 'vulnerabilities'],
  ]) {
    assert.equal(morphologicallyMatches(a, b), true, `${a} ~ ${b} should match`);
  }
});

test('morphologicallyMatches › rejects interior-substring lookalikes (start-boundary guard)', () => {
  for (const [a, b] of [
    ['test', 'latest'],
    ['bug', 'debug'],
    ['auth', 'author'],
    ['plan', 'explanation'],
  ]) {
    assert.equal(morphologicallyMatches(a, b), false, `${a} ~ ${b} should NOT match`);
  }
});

test('morphologicallyMatches › rejects near-collisions below the threshold', () => {
  // readme~read (0.60) shares the start window but is a different word; the
  // 0.65 threshold keeps it out (this is the precision guard).
  assert.equal(morphologicallyMatches('readme', 'read'), false);
});

test('morphologicallyMatches › very short tokens fall back to equality', () => {
  assert.equal(morphologicallyMatches('go', 'going'), false, 'sub-3-char tokens are not fuzzy-matched');
  assert.equal(morphologicallyMatches('go', 'go'), true);
});
