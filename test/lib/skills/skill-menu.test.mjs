// @ts-check
/**
 * Tests for lib/skills/skill-menu.mjs — menu rendering, intent gating, and
 * catalog coverage (the model is always offered every skill on a menu turn).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildSkillMenu, shouldEmitMenu, MENU_INTENTS } from '../../../lib/skills/skill-menu.mjs';
import { loadSkillManifests } from '../../../lib/skills/skill-manifest.mjs';

/** @param {string} id @param {string} [description] */
function man(id, description = '') {
  return { skillId: id, description, triggerFile: '', refFiles: [], triggers: [], tags: [], negativeTriggers: [], triggerLineCount: 1 };
}

test('shouldEmitMenu › only new-task and steer-scope turns get the menu', () => {
  assert.equal(shouldEmitMenu('new-task'), true);
  assert.equal(shouldEmitMenu('steer-scope'), true);
  for (const intent of ['approve-gate', 'question', 'status', 'chat', 'abandon', null, undefined]) {
    assert.equal(shouldEmitMenu(/** @type {any} */ (intent)), false, `${intent} must not emit the menu`);
  }
  assert.deepEqual([...MENU_INTENTS].sort(), ['new-task', 'steer-scope']);
});

test('buildSkillMenu › one line per skill, wrapped in the block, id + summary', () => {
  const menu = buildSkillMenu([man('alpha', 'Does the alpha thing. More detail here.'), man('beta', 'Beta stuff.')]);
  assert.match(menu, /^<devmate-skills>/);
  assert.match(menu, /<\/devmate-skills>$/);
  assert.match(menu, /- alpha: Does the alpha thing\./);
  assert.ok(!menu.includes('More detail here'), 'only the first sentence is shown');
  assert.match(menu, /- beta: Beta stuff\./);
});

test('buildSkillMenu › advertises the plugin root so bundled-script commands are runnable', () => {
  // Skill bodies reference bundled scripts as ${PLUGIN_ROOT}/scripts/<x>.mjs,
  // and that token only expands inside hook registrations — the model's
  // terminal cannot resolve it. The menu is the one model-visible channel a
  // hook (which KNOWS the install path) can advertise it on; without this line
  // /devmate devmate-init cannot find init.mjs on a marketplace install.
  const root = 'C:\\Users\\u\\.vscode\\agent-plugins\\devmate';
  const menu = buildSkillMenu([man('alpha', 'A.')], { pluginRoot: root });
  assert.ok(menu.includes(`Bundled scripts root: ${root}`), `menu must carry the root:\n${menu}`);
  assert.ok(menu.includes('${PLUGIN_ROOT}'), 'menu must name the token it defines');
  assert.match(menu, /<\/devmate-skills>$/, 'root line stays inside the block');
});

test('buildSkillMenu › no pluginRoot (or blank) → no root line', () => {
  for (const opts of [undefined, {}, { pluginRoot: '' }]) {
    const menu = buildSkillMenu([man('alpha', 'A.')], opts);
    assert.ok(!menu.includes('Bundled scripts root:'), 'no root line without a resolved root');
  }
});

test('buildSkillMenu › a skill with no description still lists its id', () => {
  assert.match(buildSkillMenu([man('gamma', '')]), /- gamma$/m);
});

test('buildSkillMenu › empty catalog renders nothing', () => {
  assert.equal(buildSkillMenu([]), '');
});

test('buildSkillMenu › caps an overlong first sentence', () => {
  const long = 'x'.repeat(200);
  const menu = buildSkillMenu([man('big', long)]);
  const line = menu.split('\n').find((l) => l.startsWith('- big'));
  assert.ok(line && line.length < 140, 'line is length-capped');
  assert.match(menu, /\.\.\.$/m);
});

test('coverage › the real menu offers every skill, incl. the library skills paraphrases miss', async () => {
  const manifests = await loadSkillManifests(join(import.meta.dirname, '../../../skills'));
  const menu = buildSkillMenu(manifests);
  for (const m of manifests) {
    assert.ok(menu.includes(`- ${m.skillId}`), `menu offers ${m.skillId}`);
  }
  // The stateless-paraphrase-red skills must be present so the model can pick them.
  for (const id of ['app-security-handbook', 'coding-best-practices', 'pragmatic-programmer']) {
    assert.ok(menu.includes(`- ${id}: `), `${id} is offered with a description`);
  }
});

test('description › loadSkillManifests parses the frontmatter description', async () => {
  const manifests = await loadSkillManifests(join(import.meta.dirname, '../../../skills'));
  const tdd = manifests.find((m) => m.skillId === 'tdd-debug');
  assert.ok(tdd && typeof tdd.description === 'string' && tdd.description.length > 0, 'description populated');
});
