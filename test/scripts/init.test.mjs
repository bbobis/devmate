// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/init.mjs';
import { validateDevmateConfig } from '../../lib/config/devmate-config.mjs';
import { CONTRACT_VERSION } from '../../lib/config/contract-version.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-init-cli-'));
}

test('init main - writes config and returns 0', async () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    const code = await main(['--path', path]);
    assert.equal(code, 0);
    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(validateDevmateConfig(parsed).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init main - returns 1 when file exists and no --force', async () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    await main(['--path', path]);
    const code = await main(['--path', path]);
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init main - --force overwrites and returns 0', async () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    await main(['--path', path]);
    const code = await main(['--path', path, '--force']);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build an injectable IO collector for main(args, io). Avoids monkeypatching the
 * global stdout stream (which races with the test reporter's own output).
 * @returns {{ io: { out: (s: string) => void, err: (s: string) => void }, out: () => string, err: () => string }}
 */
function makeIO() {
  /** @type {string[]} */
  const outChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  return {
    io: {
      out: (s) => outChunks.push(s),
      err: (s) => errChunks.push(s),
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/**
 * Create a temp dir that looks like a repo (package.json + real scripts) and
 * chdir into it, so resolveRepoRoot resolves there and the proposal / evidence /
 * config all land under this temp root — never the real repo. The scripts give
 * the verification scan real commands to ground checks in.
 * @returns {{ dir: string, restore: () => void }}
 */
function inferRepoCwd() {
  const origCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'devmate-init-infer-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-repo', scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc -p .' } }),
  );
  process.chdir(dir);
  return {
    dir,
    restore: () => {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('init main - --infer generates a grounded proposal + evidence and writes no config', async () => {
  const { dir, restore } = inferRepoCwd();
  try {
    const cap = makeIO();
    const code = await main(['--infer'], cap.io);
    assert.equal(code, 0);
    // No real config written in generate mode.
    assert.equal(existsSync(join(dir, '.devmate', 'devmate.config.json')), false);
    // Proposal + evidence drafts written and valid.
    const proposalPath = join(dir, '.devmate', 'state', 'init-proposal.json');
    const evidencePath = join(dir, '.devmate', 'state', 'init-evidence.json');
    assert.ok(existsSync(proposalPath));
    assert.ok(existsSync(evidencePath));
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
    assert.equal(validateDevmateConfig(proposal).ok, true);
    // Verification checks are grounded in the repo's real package.json scripts.
    const ids = (proposal.verification?.checks ?? []).map((/** @type {{id:string}} */ c) => c.id);
    assert.ok(ids.includes('unit-test'), `expected a unit-test check, got: ${ids.join(', ')}`);
    // stdout is a digest, not the full config JSON.
    assert.match(cap.out(), /proposal:/);
    assert.throws(() => JSON.parse(cap.out()));
  } finally {
    restore();
  }
});

test('init main - --infer is deterministic (same repo yields byte-identical proposal)', async () => {
  const { dir, restore } = inferRepoCwd();
  try {
    await main(['--infer'], makeIO().io);
    const proposalPath = join(dir, '.devmate', 'state', 'init-proposal.json');
    const first = readFileSync(proposalPath, 'utf8');
    await main(['--infer'], makeIO().io);
    const second = readFileSync(proposalPath, 'utf8');
    assert.equal(first, second);
  } finally {
    restore();
  }
});

test('init main - --infer --write applies the REVIEWED proposal (honors edits, not a recompute)', async () => {
  const { dir, restore } = inferRepoCwd();
  try {
    await main(['--infer'], makeIO().io);
    const proposalPath = join(dir, '.devmate', 'state', 'init-proposal.json');
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
    // Simulate human/LLM enrichment on disk.
    proposal.personas[0].persona = 'enriched-persona';
    proposal.verification.checks.push({ id: 'audit', command: 'npm audit', category: 'audit', source: '[UNVERIFIED]' });
    writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

    const code = await main(['--infer', '--write'], makeIO().io);
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(join(dir, '.devmate', 'devmate.config.json'), 'utf8'));
    // The reviewed edits survived — the write did NOT recompute from scratch.
    assert.ok(written.personas.some((/** @type {{persona:string}} */ p) => p.persona === 'enriched-persona'));
    assert.ok((written.verification.checks ?? []).some((/** @type {{id:string}} */ c) => c.id === 'audit'));
  } finally {
    restore();
  }
});

test('init main - --infer --write with no proposal writes a fresh valid floor', async () => {
  const { dir, restore } = inferRepoCwd();
  try {
    const code = await main(['--infer', '--write'], makeIO().io);
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(join(dir, '.devmate', 'devmate.config.json'), 'utf8'));
    assert.equal(validateDevmateConfig(written).ok, true);
  } finally {
    restore();
  }
});

test('init main - --infer --write refuses to overwrite without --force', async () => {
  const { restore } = inferRepoCwd();
  try {
    await main(['--infer', '--write'], makeIO().io);
    const code = await main(['--infer', '--write'], makeIO().io);
    assert.equal(code, 1);
  } finally {
    restore();
  }
});

test('init main - --infer --write --force overwrites and returns 0', async () => {
  const { restore } = inferRepoCwd();
  try {
    await main(['--infer', '--write'], makeIO().io);
    const code = await main(['--infer', '--write', '--force'], makeIO().io);
    assert.equal(code, 0);
  } finally {
    restore();
  }
});

/**
 * Create a temp dir that looks like a repo root (package.json marker) and chdir
 * into it so resolveRepoRoot resolves there — the scaffolded prompt file lands
 * under this temp root, never the real repo.
 * @returns {{ dir: string, restore: () => void }}
 */
function tmpRepoCwd() {
  const origCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'devmate-init-scaffold-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-repo' }));
  process.chdir(dir);
  return {
    dir,
    restore: () => {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a temp dir that looks like a monoroot-generated multi-root workspace
 * root (a .devmate direct child with a merged config + session handshake) and
 * chdir into it so resolveRepoRoot short-circuits there. main([]) then takes
 * the multi-root guard branch, never the single-root init flow.
 * @param {Record<string, unknown>} configExtras  Merged into the multi-root config.
 * @returns {{ dir: string, restore: () => void }}
 */
function multiRootRepoCwd(configExtras = {}) {
  const origCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'devmate-init-multiroot-'));
  const devmateDir = join(dir, '.devmate');
  const config = {
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'api',
    repos: ['api'],
    personas: [{ persona: 'api-dev', repo: 'api', editableGlobs: ['src/**'], source: 'repo' }],
    ...configExtras,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ws' }));
  mkdirSync(devmateDir, { recursive: true });
  writeFileSync(join(devmateDir, 'devmate.config.json'), JSON.stringify(config));
  writeFileSync(
    join(devmateDir, 'session.json'),
    JSON.stringify({
      schemaVersion: 2,
      branchName: 'ws',
      createdAt: 't',
      workspaceFile: 'ws.code-workspace',
      devmate: { mode: 'multi-root', primary: 'api', configPath: '.devmate/devmate.config.json' },
      worktrees: [],
    }),
  );
  process.chdir(dir);
  return {
    dir,
    restore: () => {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Pinned to the constant, not a literal: a contract bump must not silently turn
// the "matching stamp" case into a skew case (or vice versa).
test('init main - multi-root with a matching contractVersion stamp emits no skew nudge', async () => {
  const { restore } = multiRootRepoCwd({ contractVersion: CONTRACT_VERSION });
  try {
    const cap = makeIO();
    const code = await main([], cap.io);
    assert.equal(code, 0);
    assert.match(cap.out(), /multi-root workspace detected/);
    assert.doesNotMatch(cap.out(), /contract version skew/);
  } finally {
    restore();
  }
});

test('init main - multi-root with a differing contractVersion stamp nudges but still exits 0 (fail-open)', async () => {
  const stamped = CONTRACT_VERSION - 1;
  const { restore } = multiRootRepoCwd({ contractVersion: stamped });
  try {
    const cap = makeIO();
    const code = await main([], cap.io);
    assert.equal(code, 0);
    assert.match(cap.out(), /contract version skew/);
    assert.ok(cap.out().includes(`v${stamped}`), 'nudge names the stamped version');
    assert.ok(cap.out().includes(`v${CONTRACT_VERSION}`), 'nudge names the targeted version');
    assert.match(cap.out(), /Re-sync devmate/);
  } finally {
    restore();
  }
});

test('init main - multi-root with no contractVersion stamp (older producer) emits no skew nudge', async () => {
  const { restore } = multiRootRepoCwd();
  try {
    const cap = makeIO();
    const code = await main([], cap.io);
    assert.equal(code, 0);
    assert.doesNotMatch(cap.out(), /contract version skew/);
  } finally {
    restore();
  }
});

test('init main - static write scaffolds the /devmate prompt file into the repo root', async () => {
  const { dir, restore } = tmpRepoCwd();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    const code = await main(['--path', path], makeIO().io);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, '.github', 'prompts', 'devmate.prompt.md')), true);
  } finally {
    restore();
  }
});

test('init main - --infer --write scaffolds the /devmate prompt file', async () => {
  const { dir, restore } = tmpRepoCwd();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    const code = await main(['--infer', '--write', '--path', path], makeIO().io);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, '.github', 'prompts', 'devmate.prompt.md')), true);
  } finally {
    restore();
  }
});

test('init main - re-run leaves a customised /devmate prompt file untouched', async () => {
  const { dir, restore } = tmpRepoCwd();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    const promptAbs = join(dir, '.github', 'prompts', 'devmate.prompt.md');
    await main(['--path', path], makeIO().io);
    // User customises the scaffolded file, then re-inits with --force.
    const custom = '---\nagent: orchestrator\n---\ncustomised\n';
    writeFileSync(promptAbs, custom, 'utf8');
    const code = await main(['--path', path, '--force'], makeIO().io);
    assert.equal(code, 0);
    assert.equal(readFileSync(promptAbs, 'utf8'), custom);
  } finally {
    restore();
  }
});
