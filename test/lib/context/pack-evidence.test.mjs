// @ts-check
/**
 * #30 — value-ranked greedy evidence packing + elastic slices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packEvidence,
  loadElasticSlice,
  ELASTIC_SUMMARY_TRIGGER_RATIO,
} from '../../../lib/context/evidence-pack.mjs';
import { packBudgetForClass } from '../../../lib/context/output-contract.mjs';
import { tokenBudgetForClass } from '../../../lib/context/session-budget.mjs';

/**
 * @param {Partial<import('../../../lib/types.mjs').EvidencePointer>} over
 * @returns {import('../../../lib/types.mjs').EvidencePointer}
 */
function ptr(over) {
  return {
    path: 'lib/a.mjs',
    lineRange: [1, 10],
    reason: 'relevant to the step',
    confidence: 0.8,
    freshness: '2026-01-01T00:00:00.000Z',
    kind: 'file',
    ...over,
  };
}

test('#30 additive — admits the highest-value set within maxSources and reports dropped', () => {
  const pointers = [
    ptr({ path: 'lib/low.mjs', confidence: 0.3 }),
    ptr({ path: 'lib/high.mjs', confidence: 0.95 }),
    ptr({ path: 'lib/mid.mjs', confidence: 0.6 }),
  ];
  const plan = packEvidence(pointers, { maxTokens: 100000, maxSources: 2 });
  assert.equal(plan.admitted.length, 2, 'only maxSources are admitted');
  assert.equal(plan.dropped, 1, 'the rest are reported dropped, never silently cut');
  const paths = plan.admitted.map((a) => a.pointer.path);
  assert.deepEqual(paths, ['lib/high.mjs', 'lib/mid.mjs'], 'the two highest-value pointers win, in value order');
});

test('#30 additive — a tight token budget drops what does not fit (dropped > 0)', () => {
  // Each full slice is [1,10] → 10 lines * 12 = 120 tokens. A 130-token budget
  // fits one full; the rest cannot fit even as summaries once budget is spent.
  const pointers = [
    ptr({ path: 'lib/a.mjs', confidence: 0.9 }),
    ptr({ path: 'lib/b.mjs', confidence: 0.8 }),
    ptr({ path: 'lib/c.mjs', confidence: 0.7 }),
  ];
  const plan = packEvidence(pointers, { maxTokens: 130, maxSources: 99 });
  assert.ok(plan.dropped > 0, 'over-budget candidates are dropped');
  assert.ok(plan.totalTokenEstimate <= 130, 'the pack never exceeds the token budget');
});

test('#30 elastic — the chosen form flips to summary once remaining budget is tight', () => {
  // maxTokens 100; first full slice ([1,7] → 84 tokens) leaves remaining 16,
  // which is <= 0.2 * 100 = 20 → the next admitted pointer is loaded as summary.
  const pointers = [
    ptr({ path: 'lib/first.mjs', lineRange: [1, 7], confidence: 0.95 }),
    ptr({ path: 'lib/second.mjs', lineRange: [1, 3], confidence: 0.5 }),
  ];
  const plan = packEvidence(pointers, { maxTokens: 100, maxSources: 99 });
  const byPath = Object.fromEntries(plan.admitted.map((a) => [a.pointer.path, a.form]));
  assert.equal(byPath['lib/first.mjs'], 'full', 'the first pointer fits at full fidelity');
  assert.equal(byPath['lib/second.mjs'], 'summary', 'the second is summarized once budget is tight');
  assert.ok(ELASTIC_SUMMARY_TRIGGER_RATIO > 0 && ELASTIC_SUMMARY_TRIGGER_RATIO < 1);
});

test('#30 subtractive — starts full and drops the lowest-value until it fits', () => {
  // 4 full slices at 120 tokens each = 480; a 250-token budget keeps the top 2.
  const pointers = [
    ptr({ path: 'lib/a.mjs', confidence: 0.9 }),
    ptr({ path: 'lib/b.mjs', confidence: 0.8 }),
    ptr({ path: 'lib/c.mjs', confidence: 0.4 }),
    ptr({ path: 'lib/d.mjs', confidence: 0.2 }),
  ];
  const plan = packEvidence(pointers, { maxTokens: 250, maxSources: 999, mode: 'subtractive' });
  assert.ok(plan.totalTokenEstimate <= 250, 'the kept set fits the budget');
  assert.ok(plan.admitted.every((a) => a.form === 'full'), 'subtractive keeps full fidelity');
  const paths = plan.admitted.map((a) => a.pointer.path).sort();
  assert.deepEqual(paths, ['lib/a.mjs', 'lib/b.mjs'], 'the lowest-value pointers are dropped first');
  assert.equal(plan.dropped, 2);
});

test('#30 value ranking — freshness is relative recency; newer ranks higher when confidence ties', () => {
  const pointers = [
    ptr({ path: 'lib/older.mjs', confidence: 0.8, freshness: '2025-01-01T00:00:00.000Z' }),
    ptr({ path: 'lib/newer.mjs', confidence: 0.8, freshness: '2026-06-01T00:00:00.000Z' }),
  ];
  const plan = packEvidence(pointers, { maxTokens: 100000, maxSources: 1 });
  assert.equal(plan.admitted[0].pointer.path, 'lib/newer.mjs', 'the fresher pointer outranks the stale one');
});

test('#30 deterministic — same inputs pack identically', () => {
  const pointers = [ptr({ path: 'lib/a.mjs' }), ptr({ path: 'lib/b.mjs', confidence: 0.5 })];
  const a = packEvidence(pointers, { maxTokens: 500, maxSources: 5 });
  const b = packEvidence(pointers, { maxTokens: 500, maxSources: 5 });
  assert.deepEqual(a, b);
});

test('#30 dropped is observable — a zero budget drops everything', () => {
  const pointers = [ptr({}), ptr({ path: 'lib/b.mjs' })];
  const plan = packEvidence(pointers, { maxTokens: 0, maxSources: 0 });
  assert.equal(plan.admitted.length, 0);
  assert.equal(plan.dropped, 2);
  assert.equal(plan.totalTokenEstimate, 0);
});

test('#30 packBudgetForClass reads the canonical thresholds — no duplication', () => {
  for (const [cls, maxSources] of /** @type {const} */ ([['tiny', 3], ['standard', 10], ['large', 999]])) {
    const budget = packBudgetForClass(cls);
    assert.equal(budget.maxTokens, tokenBudgetForClass(cls), `${cls} maxTokens comes from session-budget`);
    assert.equal(budget.maxSources, maxSources, `${cls} maxSources`);
  }
});

test('#30 loadElasticSlice — summary returns a compact descriptor (no file read); full returns content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-evidence-'));
  try {
    const file = join(dir, 'code.mjs');
    writeFileSync(file, 'line1\nline2\nline3\n', 'utf8');
    const pointer = ptr({ path: file, lineRange: [2, 3], reason: 'the interesting bit' });

    const summary = await loadElasticSlice(pointer, 'summary');
    assert.match(summary, /the interesting bit/, 'the summary carries the reason');
    assert.ok(!summary.includes('line2'), 'the summary does NOT read file content');

    const full = await loadElasticSlice(pointer, 'full');
    assert.equal(full, 'line2\nline3', 'the full form returns the exact slice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#30 robustness — a pointer with a missing lineRange does not crash packing (#30 review)', () => {
  const malformed = /** @type {any} */ ({ reason: 'r', confidence: 0.8, freshness: '2026-01-01T00:00:00.000Z', kind: 'file' }); // no lineRange AND no path
  const plan = packEvidence([malformed, ptr({ path: 'lib/y.mjs' })], { maxTokens: 100000, maxSources: 5 });
  assert.equal(plan.admitted.length, 2, 'the malformed pointer degrades to a default estimate, never a throw');
});
