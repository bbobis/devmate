// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-artifact-allowlist.mjs';

/** @type {string} */
let fixtureDir;

/**
 * Build a minimal fixture repo with an allowlist and optional extra docs files.
 * @param {string} baseDir
 * @param {import('../../lib/types.mjs').AllowlistEntry[]} entries
 * @param {string[]} [extraFiles]  Extra repo-relative paths to create (empty content).
 */
function buildFixture(baseDir, entries, extraFiles = []) {
  mkdirSync(join(baseDir, 'docs'), { recursive: true });
  const allowlistPath = join(baseDir, 'allowlist.json');
  writeFileSync(allowlistPath, JSON.stringify({ schemaVersion: 1, entries }));
  // @bounded-alloc — writes the fixture files declared by this test case.
  for (const f of extraFiles) {
    const full = join(baseDir, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  }
  return allowlistPath;
}

before(() => {
  fixtureDir = join(tmpdir(), `check-allowlist-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('check-artifact-allowlist main()', () => {
  it('returns 0 for a fixture with no unlisted files', async () => {
    const dir = join(fixtureDir, 'clean');
    /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
    const entries = [{ path: 'docs/AGENTS.md', role: 'agent-loadable' }];
    const allowlistPath = buildFixture(dir, entries, ['docs/AGENTS.md']);
    const code = await main(['--dirs', 'docs'], allowlistPath, dir);
    assert.equal(code, 0);
  });

  it('returns 1 and prints a compact violation table for a fixture with an unlisted file', async () => {
    const dir = join(fixtureDir, 'violation');
    /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
    const entries = [{ path: 'docs/AGENTS.md', role: 'agent-loadable' }];
    const allowlistPath = buildFixture(dir, entries, ['docs/AGENTS.md', 'docs/UNLISTED.md']);
    const code = await main(['--dirs', 'docs'], allowlistPath, dir);
    assert.equal(code, 1);
  });

  it('--dirs flag overrides the default watched directories', async () => {
    const dir = join(fixtureDir, 'override-dirs');
    // Put a file only in 'hooks/', which is the default. Use --dirs docs so hooks is not scanned.
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'surprise.json'), '{}');
    writeFileSync(join(dir, 'docs', 'AGENTS.md'), '# Agents');
    /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
    const entries = [{ path: 'docs/AGENTS.md', role: 'agent-loadable' }];
    const allowlistPath = join(dir, 'allowlist.json');
    writeFileSync(allowlistPath, JSON.stringify({ schemaVersion: 1, entries }));
    // Scan only docs/ — the unlisted hooks/surprise.json should NOT be seen
    const code = await main(['--dirs', 'docs'], allowlistPath, dir);
    assert.equal(code, 0, 'Expected 0 because hooks/ is not in the scanned dirs');
  });
});
