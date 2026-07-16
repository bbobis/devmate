// @ts-check
/**
 * FO-3: CLI tests for scripts/discovery-scan.mjs — spawns the real script
 * (mirrors test/scripts/orch-assert-floor.test.mjs conventions).
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/discovery-scan.mjs', import.meta.url));

/**
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Build a minimal fixture repo with one matchable file.
 * @returns {Promise<string>}
 */
async function buildFixtureRepo() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'discovery-scan-cli-'));
  await fsp.mkdir(join(root, 'lib'), { recursive: true });
  await fsp.writeFile(join(root, 'lib', 'widget.mjs'), 'export function widget() { return 1; }\n', 'utf8');
  return root;
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

test('discovery-scan CLI › missing --terms exits 1 with a stderr reason', skipUnlessNode(24), () => {
  const { exitCode, stderr } = run([]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--terms/);
});

test('discovery-scan CLI › runs against a fixture repo and writes a valid artifact', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const outPath = join(root, 'out', 'candidates.json');
    const { exitCode, stdout } = run(['--terms', 'widget', '--repo-root', root, '--out', outPath]);
    assert.equal(exitCode, 0);
    // ≤10-line digest.
    assert.ok(stdout.trim().split('\n').length <= 10);
    assert.match(stdout, /candidate/);

    const artifact = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    assert.equal(artifact.schemaVersion, 1);
    assert.deepEqual(artifact.seedTerms, ['widget']);
    assert.equal(typeof artifact.generatedAt, 'string');
    assert.ok(Array.isArray(artifact.candidates));
    assert.ok(artifact.candidates.some((/** @type {{path: string}} */ c) => c.path === 'lib/widget.mjs'));
    assert.equal(typeof artifact.dropped, 'number');
    assert.equal(typeof artifact.insufficient, 'boolean');
    assert.ok(Array.isArray(artifact.violations));

    // No stray .tmp file left behind — the atomic rename completed cleanly.
    const dirEntries = await fsp.readdir(join(root, 'out'));
    assert.deepEqual(dirEntries, ['candidates.json']);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › --seed-files and --max-sources are honored', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const outPath = join(root, 'candidates.json');
    const { exitCode } = run([
      '--terms',
      'widget',
      '--seed-files',
      'lib/widget.mjs',
      '--max-sources',
      '1',
      '--repo-root',
      root,
      '--out',
      outPath,
    ]);
    assert.equal(exitCode, 0);
    const artifact = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    assert.ok(artifact.candidates.length <= 1);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › default --out path is .devmate/state/discovery-candidates.json', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const { exitCode, stdout } = run(['--terms', 'widget', '--repo-root', root]);
    assert.equal(exitCode, 0);
    const defaultPath = join(root, '.devmate', 'state', 'discovery-candidates.json');
    assert.match(stdout, /discovery-candidates\.json/);
    const stat = await fsp.stat(defaultPath);
    assert.ok(stat.isFile());
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › negative --max-sources exits 1 with a stderr reason', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const { exitCode, stderr } = run(['--terms', 'widget', '--repo-root', root, '--max-sources', '-1']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--max-sources/);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › empty --max-sources value exits 1 rather than silently using 0', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const { exitCode, stderr } = run(['--terms', 'widget', '--repo-root', root, '--max-sources', '']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--max-sources/);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › --min-success-rate out of range exits 1 with a stderr reason', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const { exitCode, stderr } = run(['--terms', 'widget', '--repo-root', root, '--min-success-rate', '1.5']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--min-success-rate/);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › --min-success-rate is accepted and forwarded', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const outPath = join(root, 'candidates.json');
    const { exitCode } = run([
      '--terms',
      'widget',
      '--repo-root',
      root,
      '--min-success-rate',
      '0.1',
      '--out',
      outPath,
    ]);
    assert.equal(exitCode, 0);
    const artifact = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    assert.equal(artifact.insufficient, false);
  } finally {
    await cleanup(root);
  }
});

test('discovery-scan CLI › --out escaping --repo-root exits 1 with a stderr reason', skipUnlessNode(24), async () => {
  const root = await buildFixtureRepo();
  try {
    const { exitCode, stderr } = run([
      '--terms',
      'widget',
      '--repo-root',
      root,
      '--out',
      '../outside.json',
    ]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--out/);
  } finally {
    await cleanup(root);
  }
});
