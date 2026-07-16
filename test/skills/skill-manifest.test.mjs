// @ts-check
/**
 * Unit tests for lib/skills/skill-manifest.mjs
 * Covers: frontmatter parsing of synonyms + priority, toNumber defaults,
 * and loadSkillManifests populating the new SkillManifest fields.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillManifests, validateSkillSplit, TRIGGER_LINE_BUDGET } from '../../lib/skills/skill-manifest.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal SKILL.md into a temp skills directory and return the dir.
 * @param {string} parentDir
 * @param {string} skillName
 * @param {string} frontmatter  Raw frontmatter string (between --- delimiters)
 * @param {string} [body]
 * @returns {Promise<string>}  Absolute path to the skills root.
 */
async function writeSkill(parentDir, skillName, frontmatter, body = '# Stub') {
  const skillDir = join(parentDir, skillName);
  await mkdir(skillDir, { recursive: true });
  const content = `---\n${frontmatter}---\n\n${body}\n`;
  await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');
  return parentDir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** @type {string} */
let tmpDir;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devmate-skill-manifest-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: synonyms parsing
// ---------------------------------------------------------------------------

describe('skill-manifest: synonyms frontmatter', () => {
  it('reads synonyms inline array from frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-syn-inline-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      "triggers: ['debug', 'fix']",
      "synonyms: ['crashes', 'blows up', 'panics']",
      "tags: ['debug']",
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests.length, 1);
    assert.deepEqual(manifests[0].synonyms, ['crashes', 'blows up', 'panics']);
  });

  it('reads synonyms multiline block list from frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-syn-block-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      'triggers:',
      '  - debug',
      'synonyms:',
      '  - crashes',
      '  - explodes',
      'tags:',
      '  - debug',
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests.length, 1);
    assert.deepEqual(manifests[0].synonyms, ['crashes', 'explodes']);
  });

  it('defaults synonyms to empty array when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-syn-absent-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      "triggers: ['debug']",
      "tags: ['debug']",
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests.length, 1);
    assert.deepEqual(manifests[0].synonyms, []);
  });
});

// ---------------------------------------------------------------------------
// Tests: priority parsing
// ---------------------------------------------------------------------------

describe('skill-manifest: priority frontmatter', () => {
  it('reads numeric priority from frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-pri-set-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      "triggers: ['debug']",
      'priority: 2',
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests[0].priority, 2);
  });

  it('defaults priority to 5 when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-pri-absent-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      "triggers: ['debug']",
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests[0].priority, 5);
  });

  it('defaults priority to 5 when value is non-numeric', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-pri-nan-'));
    await writeSkill(dir, 'my-skill', [
      'name: my-skill',
      "triggers: ['debug']",
      'priority: high',
    ].join('\n') + '\n');
    const manifests = await loadSkillManifests(dir);
    await rm(dir, { recursive: true, force: true });
    assert.equal(manifests[0].priority, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateSkillSplit
// ---------------------------------------------------------------------------

describe('skill-manifest: validateSkillSplit', () => {
  it('passes when all skills are within budget', () => {
    /** @type {import('../../lib/types.mjs').SkillManifest[]} */
    const manifests = [
      { skillId: 'a', triggerFile: 'a/SKILL.md', refFiles: [], triggers: [], tags: [], negativeTriggers: [], synonyms: [], priority: 5, triggerLineCount: 10 },
    ];
    const result = validateSkillSplit(manifests);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it('fails when a skill exceeds TRIGGER_LINE_BUDGET', () => {
    /** @type {import('../../lib/types.mjs').SkillManifest[]} */
    const manifests = [
      { skillId: 'fat-skill', triggerFile: 'fat-skill/SKILL.md', refFiles: [], triggers: [], tags: [], negativeTriggers: [], synonyms: [], priority: 5, triggerLineCount: TRIGGER_LINE_BUDGET + 1 },
    ];
    const result = validateSkillSplit(manifests);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].skillId, 'fat-skill');
  });
});
