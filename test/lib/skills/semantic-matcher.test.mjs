// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeQuery,
  scoreManifest,
  matchSkills,
} from '../../../lib/skills/semantic-matcher.mjs';
import { loadSkillManifests } from '../../../lib/skills/skill-manifest.mjs';

/**
 * Build a SkillManifest with sensible defaults.
 * @param {Partial<import('../../../lib/types.mjs').SkillManifest>} over
 * @returns {import('../../../lib/types.mjs').SkillManifest}
 */
function manifest(over) {
  return {
    skillId: 'demo',
    triggerFile: 'skills/demo/SKILL.md',
    refFiles: [],
    triggers: [],
    tags: [],
    negativeTriggers: [],
    triggerLineCount: 10,
    ...over,
  };
}

test('normalizeQuery / strips punctuation and lowercases', () => {
  assert.deepEqual(normalizeQuery('Fix the FAILING test!?'), ['fix', 'the', 'failing', 'test']);
});

test('normalizeQuery / handles empty string', () => {
  assert.deepEqual(normalizeQuery(''), []);
});

test('scoreManifest / exact trigger phrase → confidence >= 0.5', () => {
  const m = manifest({ skillId: 'tdd', triggers: ['debug'] });
  const r = scoreManifest(m, normalizeQuery('please debug this'));
  assert.ok(r.confidence >= 0.5, `expected >= 0.5, got ${r.confidence}`);
});

test('scoreManifest / negative trigger fires → confidence = 0.0, negativeTriggered = true', () => {
  const m = manifest({ triggers: ['debug'], negativeTriggers: ['research'] });
  const r = scoreManifest(m, normalizeQuery('research the debug topic'));
  assert.equal(r.confidence, 0);
  assert.equal(r.negativeTriggered, true);
});

test('scoreManifest / tag match contributes to score', () => {
  const m = manifest({ tags: ['testing'] });
  const r = scoreManifest(m, normalizeQuery('testing approaches'));
  assert.ok(r.confidence > 0, `tag match should add score, got ${r.confidence}`);
});

test('scoreManifest / no match → confidence = 0.0', () => {
  const m = manifest({ triggers: ['deploy'], tags: ['ops'] });
  const r = scoreManifest(m, normalizeQuery('totally unrelated words'));
  assert.equal(r.confidence, 0);
});

test('matchSkills / returns sorted results above minConfidence', () => {
  const ms = [
    manifest({ skillId: 'a', triggers: ['debug'] }),
    manifest({ skillId: 'b', tags: ['debug'] }),
    manifest({ skillId: 'c', triggers: ['deploy'] }),
  ];
  const results = matchSkills('debug now', ms);
  assert.ok(results.length >= 2);
  // descending order
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i - 1].confidence >= results[i].confidence);
  }
  assert.ok(results.every((r) => r.confidence >= 0.1));
});

test('matchSkills / "failing unit test" matches tdd-debug skill at top (real fixture)', async () => {
  const manifests = await loadSkillManifests(path.join(process.cwd(), 'skills'));
  const results = matchSkills('failing unit test', manifests);
  assert.ok(results.length > 0, 'should match at least one skill');
  assert.equal(results[0].skillId, 'tdd-debug');
  assert.ok(results[0].confidence >= 0.5, `expected >= 0.5, got ${results[0].confidence}`);
});

test('matchSkills / multiline frontmatter triggers parsed and matched', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sm-multiline-'));
  const dir = path.join(root, 'multi');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: multi',
      'triggers:',
      '  - migrate database',
      '  - schema change',
      'tags:',
      '  - database',
      '---',
      '',
      '# Multi',
    ].join('\n'),
  );
  const manifests = await loadSkillManifests(root);
  const results = matchSkills('migrate database now', manifests);
  assert.ok(results.length > 0, 'multiline triggers should parse and match');
  assert.equal(results[0].skillId, 'multi');
});

test('matchSkills / respects topN limit', () => {
  const ms = [];
  for (let i = 0; i < 8; i += 1) ms.push(manifest({ skillId: `s${i}`, triggers: ['debug'] }));
  const results = matchSkills('debug', ms, { topN: 3 });
  assert.equal(results.length, 3);
});
