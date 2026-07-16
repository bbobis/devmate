// @ts-check
/**
 * E7-6: tests for the issue-quality eval entrypoint threshold logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCases, main } from '../../scripts/run-issue-quality-evals.mjs';

const GOOD_BODY = [
  '## Add a thing',
  '## Acceptance criteria',
  '- One.',
  '- Two.',
  '## Dependencies',
  'Blocked by #38.',
  'Token/context impact: minimal.',
  '## Upstream contracts (inlined)',
  '```js',
  'export const CONTRACT = Object.freeze({ verified: true });',
  '```',
  'Source of truth: #38 — do not diverge.',
  '## Background & evidence',
  'See ws1-artifact-audit.md:10 and https://docs.github.com/x',
].join('\n');

const WEAK_BODY = '## Hook registration\nVague text.';

test('run-issue-quality-evals › exits 0 when all positive cases pass and all defects caught', async () => {
  // The real bundled cases must satisfy the threshold.
  const code = await main(['--no-write']);
  assert.equal(code, 0);
});

test('run-issue-quality-evals › exits 1 when a positive case scores below 7/7', () => {
  // A "positive" case that is actually weak → positive accuracy < 1.0.
  const summary = evaluateCases([{ id: 'weak', body: WEAK_BODY }], []);
  assert.equal(summary.passed, false);
  assert.ok(summary.positiveAccuracy < 1.0);
});

test('run-issue-quality-evals › exits 1 when negative case defect not caught', () => {
  // A negative case claims a defect the body does NOT actually have → missed.
  const summary = evaluateCases(
    [{ id: 'ok', body: GOOD_BODY }],
    [{ id: 'mislabeled', defect: 'titleImperative', body: GOOD_BODY }]
  );
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.negativesMissed, ['mislabeled']);
});
