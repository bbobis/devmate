// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTY_ESCALATION_THRESHOLD,
  AC_DIFFICULTY_SATURATION,
  chooseModelTier,
  difficultyFromBudgetClass,
  deriveDifficulty,
} from '../../../lib/routing/model-route.mjs';
import { createPassThroughGateway } from '../../../lib/routing/model-gateway.mjs';

test('chooseModelTier: large budget class escalates to powerful regardless of difficulty', () => {
  const r = chooseModelTier({ budgetClass: 'large', difficulty: 0, lane: 'feature' });
  assert.equal(r.tier, 'powerful');
  assert.match(r.reason, /large budget class/);
  assert.match(r.reason, /feature/);
});

test('chooseModelTier: high difficulty escalates to powerful even for a small class', () => {
  const r = chooseModelTier({ budgetClass: 'tiny', difficulty: 0.9, lane: 'bug' });
  assert.equal(r.tier, 'powerful');
  assert.match(r.reason, /difficulty/);
});

test('chooseModelTier: difficulty exactly at the threshold escalates (inclusive)', () => {
  const r = chooseModelTier({
    budgetClass: 'standard',
    difficulty: DIFFICULTY_ESCALATION_THRESHOLD,
    lane: 'chore',
  });
  assert.equal(r.tier, 'powerful');
});

test('chooseModelTier: tiny/low-difficulty stays cheap', () => {
  const r = chooseModelTier({ budgetClass: 'tiny', difficulty: 0.1, lane: 'chore' });
  assert.equal(r.tier, 'cheap');
  assert.match(r.reason, /cheap/);
});

test('chooseModelTier: standard/mid-difficulty stays cheap', () => {
  const r = chooseModelTier({ budgetClass: 'standard', difficulty: 0.5, lane: 'feature' });
  assert.equal(r.tier, 'cheap');
});

test('chooseModelTier: malformed signals fall back to standard/cheap without throwing', () => {
  // @ts-expect-error deliberately malformed input
  const r = chooseModelTier({ budgetClass: 42, difficulty: 'nope', lane: 7 });
  assert.equal(r.tier, 'cheap');
  // non-string budgetClass falls back to 'standard'; non-string lane → 'unknown'
  // (but lane only surfaces in the powerful-path reason, so the cheap reason names the class)
  assert.match(r.reason, /standard class/);
});

test('chooseModelTier: null/undefined signals do not throw', () => {
  // @ts-expect-error deliberately malformed input
  assert.equal(chooseModelTier(null).tier, 'cheap');
  // @ts-expect-error deliberately malformed input
  assert.equal(chooseModelTier(undefined).tier, 'cheap');
});

test('chooseModelTier: non-finite difficulty is treated as 0 (no NaN escalation)', () => {
  const r = chooseModelTier({ budgetClass: 'standard', difficulty: Number.NaN, lane: 'feature' });
  assert.equal(r.tier, 'cheap');
});

test('difficultyFromBudgetClass: large=0.9, tiny=0.1, standard=0.5', () => {
  assert.equal(difficultyFromBudgetClass('large'), 0.9);
  assert.equal(difficultyFromBudgetClass('tiny'), 0.1);
  assert.equal(difficultyFromBudgetClass('standard'), 0.5);
});

test('deriveDifficulty: no ACs falls back to the budget-class proxy (#217)', () => {
  assert.equal(deriveDifficulty('large', 0), difficultyFromBudgetClass('large'));
  assert.equal(deriveDifficulty('standard', 0), difficultyFromBudgetClass('standard'));
  // non-finite / negative AC counts are treated as absent → fallback
  assert.equal(deriveDifficulty('tiny', Number.NaN), difficultyFromBudgetClass('tiny'));
  assert.equal(deriveDifficulty('tiny', -3), difficultyFromBudgetClass('tiny'));
});

test('deriveDifficulty: AC count is the primary signal, saturating at 1.0 (#217)', () => {
  assert.equal(deriveDifficulty('standard', 2), 2 / AC_DIFFICULTY_SATURATION);
  assert.equal(deriveDifficulty('standard', AC_DIFFICULTY_SATURATION), 1);
  assert.equal(deriveDifficulty('standard', AC_DIFFICULTY_SATURATION + 20), 1); // clamped
});

test('deriveDifficulty: a standard/tiny task with many ACs escalates the tier (#217)', () => {
  // 6 ACs → 6/8 = 0.75 ≥ threshold → powerful, independent of the budget class.
  const acs = Math.ceil(DIFFICULTY_ESCALATION_THRESHOLD * AC_DIFFICULTY_SATURATION);
  for (const cls of /** @type {const} */ (['tiny', 'standard'])) {
    const d = deriveDifficulty(cls, acs);
    assert.ok(d >= DIFFICULTY_ESCALATION_THRESHOLD, `${cls}: ${d}`);
    assert.equal(chooseModelTier({ budgetClass: cls, difficulty: d, lane: 'feature' }).tier, 'powerful');
  }
  // A low AC count keeps a standard task cheap (difficulty independently matters).
  assert.equal(
    chooseModelTier({ budgetClass: 'standard', difficulty: deriveDifficulty('standard', 2), lane: 'feature' }).tier,
    'cheap',
  );
});

test('difficultyFromBudgetClass feeds chooseModelTier consistently: large→powerful, tiny→cheap', () => {
  assert.equal(
    chooseModelTier({
      budgetClass: 'large',
      difficulty: difficultyFromBudgetClass('large'),
      lane: 'feature',
    }).tier,
    'powerful'
  );
  assert.equal(
    chooseModelTier({
      budgetClass: 'tiny',
      difficulty: difficultyFromBudgetClass('tiny'),
      lane: 'chore',
    }).tier,
    'cheap'
  );
});

test('gateway: pass-through records the tier and returns the call result unchanged', () => {
  /** @type {Array<{ tier: string, reason: string }>} */
  const recorded = [];
  const gw = createPassThroughGateway({ record: (e) => recorded.push(e) });
  const out = gw.route({ tier: 'powerful', reason: 'because' }, () => 'result-token');
  assert.equal(out, 'result-token');
  assert.deepEqual(recorded, [{ tier: 'powerful', reason: 'because' }]);
});

test('gateway: default record sink is a no-op (does not throw without a sink)', () => {
  const gw = createPassThroughGateway();
  const out = gw.route({ tier: 'cheap', reason: 'r' }, () => 99);
  assert.equal(out, 99);
});

test('gateway: a non-function record option is ignored, not called', () => {
  // @ts-expect-error deliberately wrong record type
  const gw = createPassThroughGateway({ record: 'not-a-function' });
  assert.equal(
    gw.route({ tier: 'cheap', reason: 'r' }, () => 'ok'),
    'ok'
  );
});

test('gateway: the call is invoked exactly once', () => {
  let calls = 0;
  const gw = createPassThroughGateway();
  gw.route({ tier: 'cheap', reason: 'r' }, () => {
    calls += 1;
    return calls;
  });
  assert.equal(calls, 1);
});
