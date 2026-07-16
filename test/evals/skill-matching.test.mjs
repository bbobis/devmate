// @ts-check
/**
 * Scorer unit tests + fixture-shape invariants for the skill-matching eval.
 * The pure scorer is tested over synthetic `run` closures; the fixtures are
 * validated for shape and against the REAL manifest set so a fixture can never
 * reference a skill that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreSkillMatching } from '../../evals/skill-matching/scorer.mjs';
import { loadSkillManifests } from '../../lib/skills/skill-manifest.mjs';

const FIXTURES = join(import.meta.dirname, '../../evals/skill-matching/fixtures');

/** @typedef {import('../../evals/skill-matching/scorer.mjs').SkillMatchingCase} SkillMatchingCase */

/**
 * Build a fake match result with just a skillId (other fields unused by the scorer).
 * @param {string} skillId
 * @returns {import('../../lib/types.mjs').MatchResult}
 */
function hit(skillId) {
  return { skillId, confidence: 1, reason: '', triggerFile: '', refFiles: [], negativeTriggered: false };
}

test('scorer › recall counts surfaced match-cases', () => {
  /** @type {SkillMatchingCase[]} */
  const cases = [
    { phrasing: 'a', skillId: 'x', expect: 'match', bucket: 'b1' },
    { phrasing: 'b', skillId: 'x', expect: 'match', bucket: 'b1' },
  ];
  const score = scoreSkillMatching(cases, (p) => (p === 'a' ? [hit('x')] : []));
  assert.equal(score.recall, 0.5);
  assert.equal(score.perBucket.b1.recall, 0.5);
});

test('scorer › precision counts correctly-excluded no-match cases', () => {
  /** @type {SkillMatchingCase[]} */
  const cases = [
    { phrasing: 'a', skillId: 'x', expect: 'no-match', bucket: 'b1' },
    { phrasing: 'b', skillId: 'x', expect: 'no-match', bucket: 'b1' },
  ];
  // 'a' wrongly surfaces x (precision miss); 'b' correctly excludes it.
  const score = scoreSkillMatching(cases, (p) => (p === 'a' ? [hit('x')] : [hit('y')]));
  assert.equal(score.precision, 0.5);
});

test('scorer › suppressRate and neverFalseSuppress track zero-result match-cases', () => {
  /** @type {SkillMatchingCase[]} */
  const cases = [
    { phrasing: 'a', skillId: 'x', expect: 'match', bucket: 'b1' },
    { phrasing: 'b', skillId: 'x', expect: 'match', bucket: 'b1' },
  ];
  // 'a' returns nothing (suppressed); 'b' returns a wrong skill (present:false but not suppressed).
  const score = scoreSkillMatching(cases, (p) => (p === 'a' ? [] : [hit('y')]));
  assert.equal(score.suppressRate, 0.5);
  assert.equal(score.neverFalseSuppress, false);
});

test('scorer › empty corpus is vacuously perfect and non-suppressing', () => {
  const score = scoreSkillMatching([], () => []);
  assert.equal(score.recall, 1);
  assert.equal(score.precision, 1);
  assert.equal(score.neverFalseSuppress, true);
});

test('scorer › passes per-case context through to the run closure', () => {
  /** @type {SkillMatchingCase[]} */
  const cases = [{ phrasing: 'p', skillId: 'x', expect: 'match', bucket: 'state-rescue', context: { lane: 'bug', gate: 'impl-started' } }];
  let seen = null;
  const score = scoreSkillMatching(cases, (_p, ctx) => {
    seen = ctx;
    return [hit('x')];
  });
  assert.deepEqual(seen, { lane: 'bug', gate: 'impl-started' });
  assert.equal(score.recall, 1);
});

test('fixtures › shape is valid and skillIds resolve to real manifests', async () => {
  const manifests = await loadSkillManifests(join(import.meta.dirname, '../../skills'));
  const realIds = new Set(manifests.map((m) => m.skillId));

  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'at least one fixture file exists');
  const docs = await Promise.all(
    files.map(async (f) => ({ f, doc: JSON.parse(await readFile(join(FIXTURES, f), 'utf8')) })),
  );

  const seen = new Set();
  for (const { f, doc } of docs) {
    assert.equal(typeof doc.skillId, 'string', `${f}: has a skillId`);
    assert.ok(realIds.has(doc.skillId), `${f}: skillId '${doc.skillId}' is a real skill`);
    assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0, `${f}: has cases`);
    for (const c of doc.cases) {
      assert.ok(typeof c.phrasing === 'string' && c.phrasing.length > 0, `${f}: non-empty phrasing`);
      assert.ok(c.expect === 'match' || c.expect === 'no-match', `${f}: expect is match|no-match`);
      assert.ok(typeof c.bucket === 'string' && c.bucket.length > 0, `${f}: has a bucket`);
      if (c.context !== undefined) {
        assert.ok('lane' in c.context && 'gate' in c.context, `${f}: context has lane and gate`);
      }
      const key = `${doc.skillId}::${c.phrasing}`;
      assert.ok(!seen.has(key), `duplicate case: ${key}`);
      seen.add(key);
    }
  }
});
