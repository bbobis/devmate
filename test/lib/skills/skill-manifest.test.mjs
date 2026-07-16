// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRIGGER_LINE_BUDGET,
  loadSkillManifests,
  validateSkillSplit,
} from '../../../lib/skills/skill-manifest.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/**
 * Build a temporary skills tree and return its root.
 * @returns {Promise<string>}
 */
async function makeTempSkills() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const tdd = path.join(root, 'tdd-debug');
  await fsp.mkdir(path.join(tdd, 'refs'), { recursive: true });
  const stub = [
    '---',
    'name: tdd-debug',
    'description: TDD skill.',
    "triggers: ['implement', 'fix']",
    "tags: ['tdd', 'testing']",
    "negative_triggers: ['research']",
    '---',
    '',
    '# TDD',
    '1. Red 2. Green 3. Refactor',
  ].join('\n');
  await fsp.writeFile(path.join(tdd, 'SKILL.md'), stub);
  await fsp.writeFile(path.join(tdd, 'refs', 'unit.md'), '# unit\n');
  await fsp.writeFile(path.join(tdd, 'refs', 'e2e.md'), '# e2e\n');
  return root;
}

test('loadSkillManifests / discovers SKILL.md and ref files in temp skills tree', async () => {
  const root = await makeTempSkills();
  const manifests = await loadSkillManifests(root);
  assert.equal(manifests.length, 1);
  const m = manifests[0];
  assert.equal(m.skillId, 'tdd-debug');
  assert.equal(m.triggerFile, path.join('tdd-debug', 'SKILL.md'));
  assert.deepEqual(m.refFiles, [
    path.join('refs', 'e2e.md'),
    path.join('refs', 'unit.md'),
  ]);
});

test('loadSkillManifests / parses triggers, tags, negativeTriggers from frontmatter', async () => {
  const root = await makeTempSkills();
  const [m] = await loadSkillManifests(root);
  assert.deepEqual(m.triggers, ['implement', 'fix']);
  assert.deepEqual(m.tags, ['tdd', 'testing']);
  assert.deepEqual(m.negativeTriggers, ['research']);
});

test('loadSkillManifests / counts triggerLineCount correctly', async () => {
  const root = await makeTempSkills();
  const [m] = await loadSkillManifests(root);
  const content = await fsp.readFile(
    path.join(root, 'tdd-debug', 'SKILL.md'),
    'utf8',
  );
  assert.equal(m.triggerLineCount, content.split('\n').length);
});

test('loadSkillManifests / sorts manifests by skillId', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'skills-sort-'));
  // @bounded-alloc — writes two skill fixtures.
  for (const id of ['zeta', 'alpha']) {
    const dir = path.join(root, id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${id}\n---\n# ${id}\n`,
    );
  }
  const manifests = await loadSkillManifests(root);
  assert.deepEqual(
    manifests.map((m) => m.skillId),
    ['alpha', 'zeta'],
  );
});

test('validateSkillSplit / ok: true when all stubs within budget', async () => {
  const root = await makeTempSkills();
  const manifests = await loadSkillManifests(root);
  const result = validateSkillSplit(manifests);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('validateSkillSplit / returns violation for stub over 30 lines', () => {
  /** @type {import('../../../lib/types.mjs').SkillManifest} */
  const big = {
    skillId: 'bloated',
    triggerFile: 'bloated/SKILL.md',
    refFiles: [],
    triggers: [],
    tags: [],
    negativeTriggers: [],
    triggerLineCount: TRIGGER_LINE_BUDGET + 5,
  };
  const result = validateSkillSplit([big]);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].skillId, 'bloated');
  assert.equal(result.violations[0].lineCount, TRIGGER_LINE_BUDGET + 5);
  assert.equal(result.violations[0].budget, TRIGGER_LINE_BUDGET);
});

test('validateSkillSplit / stub exactly at budget is not a violation', () => {
  /** @type {import('../../../lib/types.mjs').SkillManifest} */
  const exact = {
    skillId: 'exact',
    triggerFile: 'exact/SKILL.md',
    refFiles: [],
    triggers: [],
    tags: [],
    negativeTriggers: [],
    triggerLineCount: TRIGGER_LINE_BUDGET,
  };
  assert.equal(validateSkillSplit([exact]).ok, true);
});

test('validateSkillSplit / empty manifests list → ok: true', () => {
  const result = validateSkillSplit([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('skills/tdd-debug/SKILL.md / line count ≤ 30 (fs read in test)', async () => {
  const content = await fsp.readFile(
    path.join(REPO_ROOT, 'skills', 'tdd-debug', 'SKILL.md'),
    'utf8',
  );
  assert.ok(
    content.split('\n').length <= TRIGGER_LINE_BUDGET,
    `tdd-debug stub is ${content.split('\n').length} lines (budget ${TRIGGER_LINE_BUDGET})`,
  );
});

test('real skills / loadSkillManifests + validateSkillSplit pass on repo skills/', async () => {
  const manifests = await loadSkillManifests(path.join(REPO_ROOT, 'skills'));
  const ids = manifests.map((m) => m.skillId).sort();
  assert.ok(ids.includes('tdd-debug'), 'tdd-debug skill must be discovered');
  assert.equal(validateSkillSplit(manifests).ok, true);
});
