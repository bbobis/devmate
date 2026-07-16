// @ts-check
/**
 * Tests for loadMergedSkillManifests — the dual-root (plugin ∪ workspace) merge:
 * precedence, reserved-id protection, fault isolation, provenance tagging, and
 * the per-root canary counts. Temp dirs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMergedSkillManifests,
  RESERVED_SKILL_IDS,
} from '../../../lib/skills/skill-manifest.mjs';

/**
 * Write skill stubs under `<tmp>/skills/<id>/SKILL.md`; returns the skills dir.
 * @param {string} prefix
 * @param {Array<{ id: string, triggers: string[] }>} skills
 * @returns {Promise<string>}
 */
async function makeSkillsDir(prefix, skills) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const skillsDir = join(base, 'skills');
  await Promise.all(
    skills.map(async ({ id, triggers }) => {
      const dir = join(skillsDir, id);
      await mkdir(dir, { recursive: true });
      const fm = [
        '---',
        `name: ${id}`,
        `triggers: [${triggers.map((t) => `'${t}'`).join(', ')}]`,
        'priority: 3',
        '---',
        '',
        `# ${id}`,
        'body',
      ].join('\n');
      await writeFile(join(dir, 'SKILL.md'), fm + '\n', 'utf8');
    }),
  );
  return skillsDir;
}

test('merge › plugin-only load tags provenance and counts', async () => {
  const plugin = await makeSkillsDir('merge-plugin-', [{ id: 'alpha', triggers: ['a'] }]);
  const { manifests, sources } = await loadMergedSkillManifests([
    { dir: plugin, source: 'plugin' },
    { dir: join(plugin, '..', 'no-workspace'), source: 'workspace' },
  ]);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].skillId, 'alpha');
  assert.equal(manifests[0].source, 'plugin');
  assert.deepEqual(
    sources.map((s) => ({ source: s.source, count: s.count })),
    [{ source: 'plugin', count: 1 }, { source: 'workspace', count: 0 }],
  );
});

test('merge › workspace adds a new skill', async () => {
  const plugin = await makeSkillsDir('merge-p-', [{ id: 'alpha', triggers: ['a'] }]);
  const ws = await makeSkillsDir('merge-w-', [{ id: 'project-x', triggers: ['x'] }]);
  const { manifests } = await loadMergedSkillManifests([
    { dir: plugin, source: 'plugin' },
    { dir: ws, source: 'workspace' },
  ]);
  assert.deepEqual(manifests.map((m) => m.skillId), ['alpha', 'project-x']);
  assert.equal(manifests.find((m) => m.skillId === 'project-x')?.source, 'workspace');
});

test('merge › workspace overrides a non-reserved plugin skill', async () => {
  const plugin = await makeSkillsDir('merge-p-', [{ id: 'tdd-debug', triggers: ['plugin-trigger'] }]);
  const ws = await makeSkillsDir('merge-w-', [{ id: 'tdd-debug', triggers: ['workspace-trigger'] }]);
  const { manifests } = await loadMergedSkillManifests([
    { dir: plugin, source: 'plugin' },
    { dir: ws, source: 'workspace' },
  ]);
  const merged = manifests.find((m) => m.skillId === 'tdd-debug');
  assert.equal(merged?.source, 'workspace', 'workspace wins on a non-reserved id');
  assert.deepEqual(merged?.triggers, ['workspace-trigger']);
});

test('merge › workspace cannot shadow a reserved plugin skill', async () => {
  const reserved = RESERVED_SKILL_IDS[0];
  const plugin = await makeSkillsDir('merge-p-', [{ id: reserved, triggers: ['plugin-trigger'] }]);
  const ws = await makeSkillsDir('merge-w-', [{ id: reserved, triggers: ['evil-override'] }]);
  const { manifests } = await loadMergedSkillManifests([
    { dir: plugin, source: 'plugin' },
    { dir: ws, source: 'workspace' },
  ]);
  const merged = manifests.find((m) => m.skillId === reserved);
  assert.equal(merged?.source, 'plugin', 'plugin keeps ownership of a reserved id');
  assert.deepEqual(merged?.triggers, ['plugin-trigger']);
});

test('merge › a workspace-only reserved id is ignored', async () => {
  const reserved = RESERVED_SKILL_IDS[0];
  const ws = await makeSkillsDir('merge-w-', [
    { id: reserved, triggers: ['x'] },
    { id: 'project-y', triggers: ['y'] },
  ]);
  const { manifests } = await loadMergedSkillManifests([
    { dir: join(ws, '..', 'no-plugin'), source: 'plugin' },
    { dir: ws, source: 'workspace' },
  ]);
  assert.deepEqual(manifests.map((m) => m.skillId), ['project-y'], 'reserved id from workspace is dropped');
});

test('merge › a missing root is fault-isolated (never blanks the catalog)', async () => {
  const plugin = await makeSkillsDir('merge-p-', [{ id: 'alpha', triggers: ['a'] }]);
  const { manifests, sources } = await loadMergedSkillManifests([
    { dir: plugin, source: 'plugin' },
    { dir: '/definitely/not/a/real/path/skills', source: 'workspace' },
  ]);
  assert.deepEqual(manifests.map((m) => m.skillId), ['alpha']);
  assert.equal(sources.find((s) => s.source === 'workspace')?.count, 0);
});
