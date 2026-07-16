// @ts-check
/**
 * E9-21: pure scorer unit tests, including the regression case — a broken
 * mechanism (e.g. compaction shipping no pointers/decisions) must fail the
 * eval, never silently pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTokenBudget } from '../../evals/token-budget/scorer.mjs';

/** @returns {import('../../evals/token-budget/scorer.mjs').TokenBudgetObservations} */
function healthyObservations() {
  return {
    traceEvents: [
      { type: 'action' },
      { type: 'budget_warning' },
      { type: 'compaction' },
    ],
    resumeVerdict: { ok: true, missingFields: [] },
    estimatedTokens: 450,
    classThresholdTokens: 2000,
    promotedFactCount: 12,
  };
}

test('healthy trajectory scores 4/4', () => {
  const result = scoreTokenBudget(healthyObservations());
  assert.deepEqual(result, {
    budgetEventsFired: true,
    resumeSufficient: true,
    activeContextBounded: true,
    ledgerPromoted: true,
    score: 4,
  });
});

test('regression: breaking compaction fails the eval', () => {
  // Compaction shipping empty pointers/decisions → canResumeFromCompaction
  // reports the missing context and the eval must drop below 4/4.
  const obs = healthyObservations();
  obs.resumeVerdict = { ok: false, missingFields: ['evidencePointers|acceptedDecisions'] };
  const result = scoreTokenBudget(obs);
  assert.equal(result.resumeSufficient, false);
  assert.equal(result.score, 3);
});

test('missing budget_warning fails the budgetEventsFired invariant', () => {
  const obs = healthyObservations();
  obs.traceEvents = [{ type: 'action' }];
  const result = scoreTokenBudget(obs);
  assert.equal(result.budgetEventsFired, false);
  assert.equal(result.score, 3);
});

test('unbounded post-compaction context fails the bounded invariant', () => {
  const obs = healthyObservations();
  obs.estimatedTokens = 5000;
  const result = scoreTokenBudget(obs);
  assert.equal(result.activeContextBounded, false);
  assert.equal(result.score, 3);
});

test('unpromoted ledger fails the ledgerPromoted invariant', () => {
  const obs = healthyObservations();
  obs.promotedFactCount = 0;
  const result = scoreTokenBudget(obs);
  assert.equal(result.ledgerPromoted, false);
  assert.equal(result.score, 3);
});

test('non-finite token estimates never pass the bounded invariant', () => {
  const obs = healthyObservations();
  obs.estimatedTokens = Number.NaN;
  assert.equal(scoreTokenBudget(obs).activeContextBounded, false);
});
