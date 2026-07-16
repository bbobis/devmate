// @ts-check
/**
 * E8-2: tests for the pure glossary stale helpers (lib/memory/glossary-stale.mjs).
 * NOTE: distinct from the E3-5 ledger stale-marker (test/lib/memory/stale-marker.test.mjs);
 * the glossary uses a separate pure module to avoid an API collision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markStale, isStale } from '../../../lib/memory/glossary-stale.mjs';

/** @typedef {import('../../../lib/types.mjs').GlossaryEntry} GlossaryEntry */

/** @returns {GlossaryEntry} a fresh entry. */
function fresh() {
  return { term: 'Foo', definition: 'd', sourceFiles: ['a.mjs'], updatedAt: '2026-06-24' };
}

test('stale-marker › markStale sets staleReason', () => {
  const out = markStale(fresh(), 'file gone');
  assert.equal(out.staleReason, 'file gone');
});

test('stale-marker › original entry not mutated', () => {
  const original = fresh();
  markStale(original, 'file gone');
  assert.equal(original.staleReason, undefined);
});

test('stale-marker › isStale true for stale entry, false for fresh', () => {
  assert.equal(isStale(fresh()), false);
  assert.equal(isStale(markStale(fresh(), 'gone')), true);
});
