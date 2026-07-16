// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/migrate-memory-path.mjs';
import { OLD_MEMORY_PATHS, resolveMemoryPath } from '../../lib/memory/paths.mjs';

/** @type {string} */
let baseDir;

before(() => {
  baseDir = join(tmpdir(), `migrate-memory-test-${Date.now()}`);
  mkdirSync(baseDir, { recursive: true });
});

after(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('migrate-memory-path main()', () => {
  it('returns 0 and writes nothing on --dry-run', async () => {
    const repoRoot = join(baseDir, 'dry');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, OLD_MEMORY_PATHS[0] ?? 'MEMORY.md'), 'x\n');

    const code = await main(['--dry-run'], repoRoot);

    assert.equal(code, 0);
    assert.equal(existsSync(resolveMemoryPath(repoRoot)), false);
  });

  it('returns 0 and migrates an existing old-path file', async () => {
    const repoRoot = join(baseDir, 'live');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, OLD_MEMORY_PATHS[0] ?? 'MEMORY.md'), 'FACT\n');

    const code = await main([], repoRoot);

    assert.equal(code, 0);
    assert.match(readFileSync(resolveMemoryPath(repoRoot), 'utf8'), /FACT/);
  });
});
