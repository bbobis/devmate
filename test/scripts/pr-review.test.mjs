// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/pr-review.mjs';

/**
 * Build a temp repo rooted by a `.devmate/` marker (so resolveRepoRoot anchors
 * there) that is deliberately NOT a git work tree.
 * @param {{ state?: unknown, malformed?: boolean }} cfg
 * @returns {Promise<{ repo: string, statePath: string }>}
 */
async function makeRepo(cfg) {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-prreview-cli-'));
  const stateDir = path.join(repo, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'task.json');
  if (cfg.malformed) {
    await fsp.writeFile(statePath, '{ not json', 'utf8');
  } else if (cfg.state !== undefined) {
    await fsp.writeFile(statePath, JSON.stringify(cfg.state, null, 2), 'utf8');
  }
  return { repo, statePath };
}

/**
 * Run `main` with cwd temporarily set to `cwd`, capturing stdout.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, out: string }>}
 */
async function runMain(args, cwd) {
  const origCwd = process.cwd();
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = /** @type {any} */ ((/** @type {string} */ c) => { out += c; return true; });
  process.chdir(cwd);
  try {
    const code = await main(args);
    return { code, out };
  } finally {
    process.chdir(origCwd);
    process.stdout.write = origWrite;
  }
}

const VALID_STATE = {
  taskId: 'cli-1',
  lane: 'feature',
  workflowGate: 'impl-started',
  artifactHashes: {},
  preImplStash: null,
  currentStep: 0,
  budget: 10,
  schemaVersion: 1,
};

test('exit 2 when the state file is missing', async () => {
  const { repo } = await makeRepo({});
  const missing = path.join(repo, '.devmate', 'state', 'nope.json');
  const { code } = await runMain(['--state-file', missing], repo);
  assert.equal(code, 2);
});

test('exit 2 when the state file is malformed', async () => {
  const { repo, statePath } = await makeRepo({ malformed: true });
  const { code } = await runMain(['--state-file', statePath], repo);
  assert.equal(code, 2);
});

test('non-git cwd — context written with git.available false, exit 0', async () => {
  const { repo, statePath } = await makeRepo({ state: VALID_STATE });
  const { code, out } = await runMain(['--state-file', statePath], repo);
  assert.equal(code, 0);

  const printed = JSON.parse(out.trim());
  assert.equal(printed.git.available, false);
  assert.equal(printed.taskId, 'cli-1');

  const written = JSON.parse(
    await fsp.readFile(path.join(repo, '.devmate', 'state', 'pr-review-context.json'), 'utf8'),
  );
  assert.equal(written.git.available, false);
  assert.equal(written.schemaVersion, 1);
});
