// @ts-check
/**
 * E16-4: planner component eval suite. Auto-runs under `node --test` (and so
 * `npm run verify`). Grades a captured plan.json against a committed rubric in
 * isolation from the lane, so a planner regression fails THIS suite on its own
 * (attributability). Mirrors evals/ac-coverage + evals/skill-matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreComponent } from './scorer.mjs';

const HERE = import.meta.dirname;
const FIX = join(HERE, '..', 'fixtures', 'planner');

/** @param {string} name */
async function load(name) {
  return JSON.parse(await readFile(join(FIX, name), 'utf8'));
}

test('planner scorer › known-good and known-bad outputs score correctly (no fixture)', () => {
  const rubric = { requiredAcs: ['AC one', 'AC two'] };

  const good = scoreComponent(
    { tasks: [{ ac: ['AC one', 'AC two'], tddApproach: 'unit tests' }] },
    rubric,
  );
  assert.equal(good.score, 1);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.spurious, []);

  // Task lists AC two but plans no test (empty tddApproach) → unmapped; AC one absent.
  const bad = scoreComponent(
    { tasks: [{ ac: ['AC two', 'AC extra'], tddApproach: '' }] },
    rubric,
  );
  assert.equal(bad.score, 0);
  assert.deepEqual(bad.missing, ['AC one', 'AC two']);
  assert.deepEqual(bad.spurious, ['AC extra']);
});

test('planner scorer › an AC listed without a TDD approach is unmapped', () => {
  const r = scoreComponent(
    { tasks: [{ ac: ['Only AC'], tddApproach: '   ' }] },
    { requiredAcs: ['Only AC'] },
  );
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing, ['Only AC']);
});

test('planner eval › good fixture meets the committed baseline', async () => {
  const [output, rubric] = await Promise.all([load('good.json'), load('rubric.json')]);
  const { score, missing } = scoreComponent(output, rubric);
  assert.equal(score, rubric.expectedGoodScore, 'good-fixture score drifted from the committed baseline');
  assert.ok(score >= rubric.passThreshold, `score ${score} below threshold ${rubric.passThreshold}`);
  assert.deepEqual(missing, [], 'good fixture should map every required AC to a planned test');
});

test('planner eval › degraded fixture fails this suite (attributable regression)', async () => {
  const [output, rubric] = await Promise.all([load('degraded.json'), load('rubric.json')]);
  const { score, missing } = scoreComponent(output, rubric);
  assert.ok(score < rubric.passThreshold, `degraded score ${score} should fall below ${rubric.passThreshold}`);
  assert.ok(missing.length > 0, 'degraded plan should leave a required AC unmapped');
});
