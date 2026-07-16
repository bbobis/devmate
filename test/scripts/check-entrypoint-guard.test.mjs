// @ts-check
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKEN_ENTRY_GUARD } from '../../lib/entry-guard-lint.mjs';
import { main } from '../../scripts/check-entrypoint-guard.mjs';

// Assembled from parts so this test file never contains the flagged
// substring itself (the lint scans test/ too).
const BROKEN_LINE = 'if (import.meta.url === `' + BROKEN_ENTRY_GUARD + '`) {\n}\n';

describe('check-entrypoint-guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-entry-guard-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('exits 0 on a tree with only correct guards', async () => {
    const dir = join(root, 'clean');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'scripts', 'ok.mjs'),
      '// @ts-check\nif (isMainModule(import.meta.url)) {\n}\n',
    );
    assert.equal(await main([], { rootOverride: dir }), 0);
  });

  it('exits 1 when a broken guard is deliberately reintroduced', async () => {
    const dir = join(root, 'dirty');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'regressed.mjs'), '// @ts-check\n' + BROKEN_LINE);
    assert.equal(await main([], { rootOverride: dir }), 1);
  });

  it('exits 0 against this repository (no broken guard remains in-tree)', async () => {
    assert.equal(await main([]), 0);
  });
});
