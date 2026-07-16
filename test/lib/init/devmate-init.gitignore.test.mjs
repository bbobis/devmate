// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDevmateLayout } from '../../../lib/init/devmate-init.mjs';
import { STATE_DIRS } from '../../../lib/init/layout.mjs';
import { MEMORY_PATH } from '../../../lib/memory/paths.mjs';

/**
 * Seed a complete .devmate layout with a caller-supplied .gitignore body.
 * @param {string} gitignoreBody
 * @returns {{ root: string, gitignorePath: string, cleanup: () => void }}
 */
function seedLayout(gitignoreBody) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-init-gi-'));
  for (const dir of STATE_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, MEMORY_PATH), '# Memory\n', 'utf8');
  const gitignorePath = join(root, '.devmate', '.gitignore');
  writeFileSync(gitignorePath, gitignoreBody, 'utf8');
  return { root, gitignorePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const STALE_GITIGNORE = ['state/', 'session/', '', '!MEMORY.md', ''].join('\n');

test('ensureDevmateLayout appends memory/tasks/ to a stale .gitignore', async () => {
  const { root, gitignorePath, cleanup } = seedLayout(STALE_GITIGNORE);
  try {
    const result = await ensureDevmateLayout(root);
    const body = readFileSync(gitignorePath, 'utf8');
    assert.equal(body.split('\n').includes('memory/tasks/'), true);
    // Pre-existing entries are preserved.
    assert.equal(body.includes('state/'), true);
    assert.equal(body.includes('!MEMORY.md'), true);
    // A repair is a change, not a skip.
    assert.equal(result.skipped, false);
  } finally {
    cleanup();
  }
});

test('ensureDevmateLayout leaves an already-complete .gitignore untouched (idempotent)', async () => {
  const complete = ['state/', 'session/', 'memory/tasks/', '', '!MEMORY.md', ''].join('\n');
  const { root, gitignorePath, cleanup } = seedLayout(complete);
  try {
    const before = readFileSync(gitignorePath, 'utf8');
    const result = await ensureDevmateLayout(root);
    const after = readFileSync(gitignorePath, 'utf8');
    assert.equal(after, before, 'complete .gitignore must not be rewritten');
    assert.equal(result.skipped, true);
  } finally {
    cleanup();
  }
});
