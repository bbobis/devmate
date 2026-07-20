// @ts-check
/**
 * E16-4: discovery component eval suite. Auto-runs under `node --test` (and so
 * `npm run verify`). Grades a captured discovery.json against a committed rubric
 * in isolation from the lane, so a discovery regression fails THIS suite on its
 * own (attributability) — planner/security suites read different fixtures and
 * stay green. Mirrors evals/skill-matching/suite.test.mjs (fixture + committed
 * baseline, pure scorer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreComponent } from './scorer.mjs';

const HERE = import.meta.dirname;
const FIX = join(HERE, '..', 'fixtures', 'discovery');

/** @param {string} name */
async function load(name) {
  return JSON.parse(await readFile(join(FIX, name), 'utf8'));
}

test('discovery scorer › known-good and known-bad outputs score correctly (no fixture)', () => {
  const rubric = { requiredPointers: ['a.mjs#L1', 'b.mjs'], groundedPaths: ['a.mjs', 'b.mjs'] };

  const good = scoreComponent({ claims: [{ path: 'a.mjs#L1' }, { path: 'b.mjs' }] }, rubric);
  assert.equal(good.score, 1);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.spurious, []);

  // Drops required b.mjs (coverage 1/2) and adds an ungrounded claim (groundedness 1/2).
  const bad = scoreComponent({ claims: [{ path: 'a.mjs#L1' }, { path: 'ghost.mjs#L9' }] }, rubric);
  assert.equal(bad.score, 0.25);
  assert.deepEqual(bad.missing, ['b.mjs']);
  assert.deepEqual(bad.spurious, ['ghost.mjs#L9']);
});

test('discovery scorer › empty edges do not throw', () => {
  assert.deepEqual(scoreComponent({}, { requiredPointers: [], groundedPaths: [] }), {
    score: 1,
    missing: [],
    spurious: [],
  });
  // A file-only requirement is covered by any same-file claim regardless of line.
  const r = scoreComponent(
    { claims: [{ path: 'x.mjs#L99' }] },
    { requiredPointers: ['x.mjs'], groundedPaths: ['x.mjs'] },
  );
  assert.equal(r.score, 1);
});

test('discovery eval › good fixture meets the committed baseline', async () => {
  const [output, rubric] = await Promise.all([load('good.json'), load('rubric.json')]);
  const { score, missing, spurious } = scoreComponent(output, rubric);
  assert.equal(score, rubric.expectedGoodScore, 'good-fixture score drifted from the committed baseline');
  assert.ok(score >= rubric.passThreshold, `score ${score} below threshold ${rubric.passThreshold}`);
  assert.deepEqual(missing, [], 'good fixture should cover every required pointer');
  assert.deepEqual(spurious, [], 'good fixture should ground every claim');
});

test('discovery eval › degraded fixture fails this suite (attributable regression)', async () => {
  const [output, rubric] = await Promise.all([load('degraded.json'), load('rubric.json')]);
  const { score, missing, spurious } = scoreComponent(output, rubric);
  assert.ok(score < rubric.passThreshold, `degraded score ${score} should fall below ${rubric.passThreshold}`);
  assert.ok(missing.length > 0 || spurious.length > 0, 'degraded output should surface a defect');
});
