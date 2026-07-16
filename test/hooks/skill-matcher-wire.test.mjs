// @ts-check
/**
 * E9-20: the UserPromptSubmit path runs the semantic skill matcher and
 * persists ranked matches to .devmate/state/skill-matches.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUserPromptSubmit } from '../../hooks/approval-listener.mjs';
import { writeTaskState, STATE_PATH } from '../../lib/task-state.mjs';

/**
 * Build a repo root with skill stubs.
 * @param {Array<{ id: string, triggers: string[], tags?: string[], negativeTriggers?: string[] }>} skills
 * @returns {Promise<string>}
 */
async function makeRoot(skills) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'skill-wire-'));
  await fsp.mkdir(join(root, '.devmate', 'state'), { recursive: true });
  // The hook resolves plugin skills from PLUGIN_ROOT (falling back to its
  // own location). Point it at this tmp root so the fixtures written under
  // <root>/skills below are the plugin catalog — exercising the real resolution
  // path. node --test isolates each file in its own process, so this env write
  // is scoped to this test file.
  process.env.PLUGIN_ROOT = root;
  // @bounded-alloc — writes one skill fixture per entry the test declares.
  for (const skill of skills) {
    const dir = join(root, 'skills', skill.id);
    await fsp.mkdir(dir, { recursive: true });
    const fm = [
      '---',
      `name: ${skill.id}`,
      `description: ${skill.id} skill`,
      `triggers: [${skill.triggers.map((t) => `'${t}'`).join(', ')}]`,
      `tags: [${(skill.tags ?? []).map((t) => `'${t}'`).join(', ')}]`,
      ...(skill.negativeTriggers
        ? [`negative_triggers: [${skill.negativeTriggers.map((t) => `'${t}'`).join(', ')}]`]
        : []),
      'priority: 3',
      '---',
      '',
      `# ${skill.id}`,
      'Common path.',
    ].join('\n');
    await fsp.writeFile(join(dir, 'SKILL.md'), fm + '\n', 'utf8');
  }
  return root;
}

/**
 * @param {string} root
 * @returns {Promise<any|null>}
 */
async function readMatches(root) {
  try {
    return JSON.parse(await fsp.readFile(join(root, '.devmate', 'state', 'skill-matches.json'), 'utf8'));
  } catch {
    return null;
  }
}

test('writes ranked skill-matches on prompt submit', async () => {
  const root = await makeRoot([
    { id: 'tdd-debug', triggers: ['failing test', 'debug', 'fix'], tags: ['tdd'] },
    { id: 'security-review', triggers: ['security', 'vulnerability'], tags: ['security'] },
  ]);
  const result = await handleUserPromptSubmit({ prompt: 'fix the failing test in checkout', root });
  assert.equal(result.action, 'passthrough', 'normal prompt passes through');
  const summary = await readMatches(root);
  assert.notEqual(summary, null, 'skill-matches.json written');
  assert.ok(summary.matches.length >= 1);
  assert.equal(summary.matches[0].skillId, 'tdd-debug');
  assert.ok(summary.matches[0].confidence > 0);
  assert.match(summary.hint, /tdd-debug/);
  // Ranked descending.
  const confidences = summary.matches.map((/** @type {any} */ m) => m.confidence);
  assert.deepEqual(confidences, [...confidences].sort((a, b) => b - a));
});

test('filters below minConfidence and heavy skills are not auto-listed', async () => {
  const root = await makeRoot([
    { id: 'heavy-rare', triggers: ['obscure ritual'], tags: ['rare'] },
  ]);
  await handleUserPromptSubmit({ prompt: 'update the readme wording please', root });
  const summary = await readMatches(root);
  assert.notEqual(summary, null);
  assert.deepEqual(summary.matches, [], 'unmatched heavy skill is not surfaced');
  assert.match(summary.hint, /No skills matched/);
});

test('respects topN', async () => {
  const skills = Array.from({ length: 6 }, (_, i) => ({
    id: `skill-${i}`,
    triggers: ['deploy'],
    tags: ['deploy'],
  }));
  const root = await makeRoot(skills);
  await handleUserPromptSubmit({ prompt: 'deploy the service', root });
  const summary = await readMatches(root);
  assert.ok(summary.matches.length <= 3, `topN cap respected (got ${summary.matches.length})`);
});

test('no match yields empty list not error', async () => {
  const root = await makeRoot([]);
  const result = await handleUserPromptSubmit({ prompt: 'hello there', root });
  assert.equal(result.action, 'passthrough');
  const summary = await readMatches(root);
  assert.notEqual(summary, null);
  assert.deepEqual(summary.matches, []);
});

test('negative triggers suppress a skill', async () => {
  const root = await makeRoot([
    {
      id: 'tdd-debug',
      triggers: ['test', 'fix'],
      tags: ['tdd'],
      negativeTriggers: ['design doc'],
    },
  ]);
  await handleUserPromptSubmit({ prompt: 'write the design doc for the test fix', root });
  const summary = await readMatches(root);
  assert.deepEqual(summary.matches, [], 'negative trigger hard-excludes the skill');
});

test('skill menu: emitted on a new-task turn', async () => {
  const root = await makeRoot([
    { id: 'tdd-debug', triggers: ['debug'] },
    { id: 'security-review', triggers: ['security'] },
  ]);
  // Fresh session (no task state) → new-task → the menu is emitted to stdout.
  let out = '';
  const stdout = /** @type {any} */ ({ write: (/** @type {string} */ s) => { out += s; return true; } });
  await handleUserPromptSubmit({ prompt: 'help me start something new here', root, stdout });
  assert.match(out, /<devmate-skills>/, 'menu emitted on a new-task turn');
  assert.match(out, /- tdd-debug/, 'menu lists the skills');
});

test('state re-rank: a debug paraphrase surfaces tdd-debug at impl-started via the workflowGate', async () => {
  // A bug task at impl-started; a paraphrase with no trigger tokens. The gate
  // boost (from the durable workflowGate field) must surface tdd-debug and the
  // lane force-include must surface the bug lane skill.
  const root = await makeRoot([
    { id: 'tdd-debug', triggers: ['failing test', 'debug'] },
    { id: 'orchestrator-bug-lane', triggers: ['bug', 'broken'] },
    { id: 'unrelated', triggers: ['deploy'] },
  ]);
  await writeTaskState(
    {
      schemaVersion: 1,
      taskId: 'bug-1',
      lane: 'bug',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
    },
    join(root, STATE_PATH),
  );
  await handleUserPromptSubmit({ prompt: 'why is this value undefined at runtime', root });
  const summary = await readMatches(root);
  const ids = summary.matches.map((/** @type {any} */ m) => m.skillId);
  assert.ok(ids.includes('tdd-debug'), 'gate boost surfaces tdd-debug');
  assert.ok(ids.includes('orchestrator-bug-lane'), 'lane force-include surfaces the bug lane skill');
});
