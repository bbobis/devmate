// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAllowlist, isAllowed, findUnlistedFiles } from '../../lib/allowlist.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `allowlist-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('loadAllowlist', () => {
  it('parses a valid JSON allowlist and returns the correct entry count', () => {
    const p = join(fixtureDir, 'valid.json');
    writeFileSync(p, JSON.stringify({
      schemaVersion: 1,
      entries: [
        { path: 'docs/AGENTS.md', role: 'agent-loadable' },
        { path: 'hooks/hooks.json', role: 'agent-loadable' }
      ]
    }));
    const result = loadAllowlist(p);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.entries.length, 2);
  });

  it('throws a descriptive error on malformed JSON without overwriting the file', () => {
    const p = join(fixtureDir, 'bad.json');
    writeFileSync(p, '{ not valid json ]]]');
    assert.throws(
      () => loadAllowlist(p),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('malformed JSON'), `expected "malformed JSON" in: ${err.message}`);
        return true;
      }
    );
    // Verify the file was NOT overwritten
    assert.equal(readFileSync(p, 'utf8'), '{ not valid json ]]]');
  });
});

describe('isAllowed', () => {
  /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
  const entries = [
    { path: 'docs/*.md', role: 'agent-loadable' },
    { path: 'hooks/hooks.json', role: 'agent-loadable' },
    { path: 'docs/archive/**', role: 'archive' }
  ];

  it('returns true for a path matching a glob entry', () => {
    assert.equal(isAllowed('docs/AGENTS.md', entries), true);
  });

  it('returns false for a path matching no entry', () => {
    assert.equal(isAllowed('scripts/foo.mjs', entries), false);
  });

  it('handles ** glob patterns correctly (deep paths match)', () => {
    assert.equal(isAllowed('docs/archive/old-release.md', entries), true);
    assert.equal(isAllowed('docs/archive/nested/deep/file.txt', entries), true);
  });
});

describe('findUnlistedFiles', () => {
  it('returns an empty array when all files in a fixture directory are covered', async () => {
    const dir = join(fixtureDir, 'covered');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'AGENTS.md'), '# Agents');
    writeFileSync(join(dir, 'docs', 'README.md'), '# README');
    /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
    const entries = [
      { path: 'docs/AGENTS.md', role: 'agent-loadable' },
      { path: 'docs/README.md', role: 'agent-loadable' }
    ];
    const result = await findUnlistedFiles(['docs'], entries, dir);
    assert.deepEqual(result, []);
  });

  it('returns the correct unlisted paths when a file exists outside allowlist coverage', async () => {
    const dir = join(fixtureDir, 'uncovered');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'AGENTS.md'), '# Agents');
    writeFileSync(join(dir, 'docs', 'SECRET.md'), '# secret');
    /** @type {import('../../lib/types.mjs').AllowlistEntry[]} */
    const entries = [
      { path: 'docs/AGENTS.md', role: 'agent-loadable' }
    ];
    const result = await findUnlistedFiles(['docs'], entries, dir);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('SECRET.md'), `expected SECRET.md in results, got: ${JSON.stringify(result)}`);
  });
});

// ---------------------------------------------------------------------------
// Default-path branch (issue #50 regression): with no override args the lib
// must locate the repo's real docs/artifact-allowlist.json from its own
// module URL. Broken on Windows when derived via URL.pathname (/C:/... →
// C:\C:\...); every other test passes an override, so only these exercise it.
// ---------------------------------------------------------------------------
describe('default path resolution (no overrides)', () => {
  it('loadAllowlist() loads the repo allowlist from the module-relative default', () => {
    const result = loadAllowlist();
    assert.equal(typeof result.schemaVersion, 'number');
    assert.ok(Array.isArray(result.entries));
    assert.ok(result.entries.length > 0, 'expected the real repo allowlist to have entries');
  });

  it('findUnlistedFiles() scans from the module-relative repo root without throwing', async () => {
    const result = await findUnlistedFiles(['docs'], loadAllowlist().entries);
    assert.ok(Array.isArray(result));
  });
});
