// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-memory-path-refs.mjs';
import { MEMORY_PATH } from '../../lib/memory/paths.mjs';

/** @type {string} */
let baseDir;

before(() => {
  baseDir = join(tmpdir(), `check-memory-refs-test-${Date.now()}`);
  mkdirSync(baseDir, { recursive: true });
});

after(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('check-memory-path-refs main()', () => {
  it('returns 0 for a clean fixture directory', async () => {
    const repoRoot = join(baseDir, 'clean');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'consumer.mjs'), `import x from 'y'; const p = '${MEMORY_PATH}';\n`);

    const code = await main([], repoRoot);

    assert.equal(code, 0);
  });

  it('returns 1 and prints the violating file and line for a fixture with a non-canonical reference', async () => {
    const repoRoot = join(baseDir, 'dirty');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'consumer.mjs'), "line one\nconst p = 'state/MEMORY.md';\n");

    /** @type {string[]} */
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (/** @type {any} */ chunk) => { out.push(String(chunk)); return true; };
    let code;
    try {
      code = await main([], repoRoot);
    } finally {
      process.stdout.write = orig;
    }

    assert.equal(code, 1);
    const printed = out.join('');
    assert.match(printed, /consumer\.mjs:2/);
    assert.match(printed, /state\/MEMORY\.md/);
  });
});
