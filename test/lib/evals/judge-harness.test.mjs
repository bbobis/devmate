// @ts-check
/**
 * E16-7 (#26): LLM-as-judge bias guards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  debiasComparison,
  resolveWinner,
  normalizeForLength,
  pinJudge,
  functionalTieBreak,
  VERBOSITY_NORMALIZATION_ALPHA,
} from '../../../lib/evals/judge-harness.mjs';

test('#26 debiasComparison is deterministic and recoverable', () => {
  const cases = [
    { a: 'a0', b: 'b0' },
    { a: 'a1', b: 'b1' },
    { a: 'a2', b: 'b2' },
    { a: 'a3', b: 'b3' },
  ];
  const first = debiasComparison(cases);
  const second = debiasComparison(cases);
  assert.deepEqual(first, second, 'same input → same shuffle (no Math.random)');
  assert.equal(first.presented.length, cases.length);
  assert.equal(first.undo.length, cases.length);
  // Each presented pair holds the SAME two elements as the original (just maybe swapped).
  cases.forEach((c, i) => {
    const p = first.presented[i];
    const set = new Set([p.first, p.second]);
    assert.ok(set.has(c.a) && set.has(c.b), 'the pair members are preserved');
    // undo tells the truth about the swap:
    if (first.undo[i] === 1) assert.equal(p.first, c.b, 'undo=1 means first is the original b');
    else assert.equal(p.first, c.a, 'undo=0 means first is the original a');
  });
});

test('#26 the shuffle actually varies position across a case set (not all same order)', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ a: `a${i}`, b: `b${i}` }));
  const { undo } = debiasComparison(cases);
  const swaps = undo.filter((u) => u === 1).length;
  assert.ok(swaps > 0 && swaps < undo.length, `position is mixed across cases (swapped ${swaps}/${undo.length})`);
});

test('#26 resolveWinner: a flipped presentation order does not change the mapped verdict', () => {
  // A judge that always prefers the content of the ORIGINAL `a`, wherever it sits.
  // Not swapped → a is `first`; the judge picks `first`.
  assert.equal(resolveWinner('first', 0), 'a');
  // Swapped → a is `second`; the judge picks `second`. Must still resolve to `a`.
  assert.equal(resolveWinner('second', 1), 'a');
  // And the symmetric cases for `b`:
  assert.equal(resolveWinner('second', 0), 'b');
  assert.equal(resolveWinner('first', 1), 'b');
});

test('#26 normalizeForLength penalizes the longer answer', () => {
  // Equal raw scores; A is much longer → A is penalized, B is not.
  const { scoreA, scoreB } = normalizeForLength(0.8, 0.8, 1000, 100, 0.5);
  assert.ok(scoreA < scoreB, 'the longer answer loses its length advantage');
  assert.equal(scoreB, 0.8, 'the shorter answer is not penalized');
  // A longer answer must be BETTER to still win: a small raw edge is erased.
  const close = normalizeForLength(0.82, 0.8, 1000, 100, 0.5);
  assert.ok(close.scoreA < close.scoreB, 'a marginally-higher long answer no longer wins');
  // Equal length → no penalty either way.
  const even = normalizeForLength(0.7, 0.6, 200, 200);
  assert.equal(even.scoreA, 0.7);
  assert.equal(even.scoreB, 0.6);
});

test('#26 normalizeForLength guards degenerate inputs and bounds the penalty (#26 review)', () => {
  // A NaN score collapses to 0 — no NaN leak.
  const nan = normalizeForLength(Number.NaN, 0.5, 100, 100);
  assert.equal(nan.scoreA, 0);
  // A zero/negative length is treated as unknown (0) — no divide-by-zero, no wrong penalty.
  const zeroLen = normalizeForLength(0.8, 0.8, 0, 0, 0.5);
  assert.deepEqual(zeroLen, { scoreA: 0.8, scoreB: 0.8 });
  // alpha <= 0 disables the penalty.
  const noAlpha = normalizeForLength(0.8, 0.8, 1000, 1, 0);
  assert.deepEqual(noAlpha, { scoreA: 0.8, scoreB: 0.8 });
  // The penalty is bounded by alpha even for a pathological length ratio.
  const huge = normalizeForLength(0.8, 0.8, 1e9, 1, 0.3);
  assert.ok(huge.scoreA >= 0.8 - 0.3 - 1e-9, 'penalty never exceeds alpha');
});

test('#26 resolveWinner accepts a boolean swap flag too (robustness)', () => {
  assert.equal(resolveWinner('second', true), 'a');
  assert.equal(resolveWinner('first', false), 'a');
});

test('#26 pinJudge records the model + version and restates the anchor', () => {
  const pinned = pinJudge({ model: 'claude-sonnet-5', version: '2026-01-01', pinnedAt: '2026-07-20T00:00:00Z' });
  assert.equal(pinned.model, 'claude-sonnet-5');
  assert.equal(pinned.version, '2026-01-01');
  assert.equal(pinned.pinnedAt, '2026-07-20T00:00:00Z');
  assert.match(pinned.anchor, /functional correctness/i, 'the anchor reminder is present');
  // Missing config degrades to 'unknown', never throws; pinnedAt stays null (no Date.now).
  const bare = pinJudge();
  assert.equal(bare.model, 'unknown');
  assert.equal(bare.version, 'unknown');
  assert.equal(bare.pinnedAt, null);
  // An empty-string pinnedAt is not a timestamp → null (#26 Copilot triage).
  assert.equal(pinJudge({ model: 'm', pinnedAt: '' }).pinnedAt, null);
});

test('#26 functionalTieBreak: the passing artifact wins over the judge; ties defer to the judge', () => {
  assert.equal(functionalTieBreak('b', true, false), 'a', 'a passes, b fails → a wins regardless of the judge');
  assert.equal(functionalTieBreak('a', false, true), 'b', 'b passes, a fails → b wins regardless of the judge');
  assert.equal(functionalTieBreak('a', true, true), 'a', 'both pass → the judge verdict stands');
  assert.equal(functionalTieBreak('b', false, false), 'b', 'both fail → the judge verdict stands');
});

test('#26 the verbosity alpha is a positive provisional coefficient', () => {
  assert.ok(VERBOSITY_NORMALIZATION_ALPHA > 0 && VERBOSITY_NORMALIZATION_ALPHA < 1);
});
