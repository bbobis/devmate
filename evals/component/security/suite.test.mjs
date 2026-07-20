// @ts-check
/**
 * E16-4: security component eval suite. Auto-runs under `node --test` (and so
 * `npm run verify`). Grades a captured security.json as a classifier (precision/
 * recall) against a committed rubric in isolation from the lane, so a security
 * regression fails THIS suite on its own (attributability). Mirrors
 * evals/skill-matching (recall/precision against a committed baseline).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreComponent } from './scorer.mjs';

const HERE = import.meta.dirname;
const FIX = join(HERE, '..', 'fixtures', 'security');

/** @param {string} name */
async function load(name) {
  return JSON.parse(await readFile(join(FIX, name), 'utf8'));
}

test('security scorer › known-good and known-bad outputs score correctly (no fixture)', () => {
  const rubric = { knownVulns: ['a.mjs#L1', 'b.mjs#L2'], cleanPaths: ['clean.mjs'] };

  // Flags both known vulns, nothing on clean paths → precision 1, recall 1 → F1 1.
  const good = scoreComponent(
    { findings: [{ path: 'a.mjs#L1' }, { path: 'b.mjs#L2' }] },
    rubric,
  );
  assert.equal(good.score, 1);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.spurious, []);

  // Misses b.mjs (recall 1/2) and flags a clean path (precision 1/2) → F1 0.5.
  const bad = scoreComponent(
    { findings: [{ path: 'a.mjs#L1' }, { path: 'clean.mjs#L7' }] },
    rubric,
  );
  assert.equal(bad.score, 0.5);
  assert.deepEqual(bad.missing, ['b.mjs#L2']);
  assert.deepEqual(bad.spurious, ['clean.mjs#L7']);
});

test('security scorer › a finding on an unknown file is neither credited nor penalized', () => {
  const r = scoreComponent(
    { findings: [{ path: 'a.mjs#L1' }, { path: 'unknown.mjs#L3' }] },
    { knownVulns: ['a.mjs#L1'], cleanPaths: ['clean.mjs'] },
  );
  assert.equal(r.score, 1); // recall 1, no false positive counted for the unknown file
  assert.deepEqual(r.spurious, []);
});

test('security scorer › closedWorld penalizes a finding on any undeclared file (#220)', () => {
  // Same input as the open-world case above, but closedWorld makes the
  // undeclared-file finding a false positive → precision 1/2, F1 0.6667.
  const r = scoreComponent(
    { findings: [{ path: 'a.mjs#L1' }, { path: 'unknown.mjs#L3' }] },
    { knownVulns: ['a.mjs#L1'], cleanPaths: ['clean.mjs'], closedWorld: true },
  );
  assert.deepEqual(r.spurious, ['unknown.mjs#L3']);
  assert.equal(r.score, 0.6667); // recall 1, precision 1/2 → F1 = 2*.5*1/1.5
});

test('security scorer › closedWorld leaves a clean pass perfect', () => {
  // Flags exactly the known vulns, nothing else → no false positive even in closed-world.
  const r = scoreComponent(
    { findings: [{ path: 'a.mjs#L1' }, { path: 'b.mjs#L2' }] },
    { knownVulns: ['a.mjs#L1', 'b.mjs#L2'], cleanPaths: [], closedWorld: true },
  );
  assert.equal(r.score, 1);
  assert.deepEqual(r.spurious, []);
});

test('security eval › good fixture meets the committed baseline', async () => {
  const [output, rubric] = await Promise.all([load('good.json'), load('rubric.json')]);
  const { score, missing, spurious } = scoreComponent(output, rubric);
  assert.equal(score, rubric.expectedGoodScore, 'good-fixture score drifted from the committed baseline');
  assert.ok(score >= rubric.passThreshold, `score ${score} below threshold ${rubric.passThreshold}`);
  assert.deepEqual(missing, [], 'good fixture should flag every known vuln');
  assert.deepEqual(spurious, [], 'good fixture should not flag a clean path');
});

test('security eval › degraded fixture fails this suite (attributable regression)', async () => {
  const [output, rubric] = await Promise.all([load('degraded.json'), load('rubric.json')]);
  const { score, missing, spurious } = scoreComponent(output, rubric);
  assert.ok(score < rubric.passThreshold, `degraded score ${score} should fall below ${rubric.passThreshold}`);
  assert.ok(missing.length > 0 || spurious.length > 0, 'degraded output should surface a false negative or positive');
});
