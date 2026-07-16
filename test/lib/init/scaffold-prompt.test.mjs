// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVMATE_PROMPT_CONTENT,
  DEVMATE_PROMPT_RELPATH,
  ensureDevmatePromptFile,
} from '../../../lib/init/scaffold-prompt.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-scaffold-prompt-'));
}

test('ensureDevmatePromptFile - creates the prompt file with the canonical content', async () => {
  const dir = tmp();
  try {
    const result = await ensureDevmatePromptFile(dir);
    const abs = join(dir, DEVMATE_PROMPT_RELPATH);
    assert.equal(result.skipped, false);
    assert.equal(result.created, abs);
    assert.ok(existsSync(abs));
    assert.equal(readFileSync(abs, 'utf8'), DEVMATE_PROMPT_CONTENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDevmatePromptFile - is a create-only no-op when the file already exists', async () => {
  const dir = tmp();
  try {
    const abs = join(dir, DEVMATE_PROMPT_RELPATH);
    // Pre-seed a customised file; the scaffolder must never overwrite it.
    mkdirSync(join(dir, '.github', 'prompts'), { recursive: true });
    const custom = '---\nagent: orchestrator\n---\nmy own edits\n';
    writeFileSync(abs, custom, 'utf8');

    const result = await ensureDevmatePromptFile(dir);
    assert.equal(result.skipped, true);
    assert.equal(result.created, null);
    assert.equal(
      readFileSync(abs, 'utf8'),
      custom,
      'an existing prompt file must be left untouched',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('committed .github/prompts/devmate.prompt.md matches DEVMATE_PROMPT_CONTENT (no drift)', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const committed = readFileSync(join(repoRoot, DEVMATE_PROMPT_RELPATH), 'utf8');
  assert.equal(
    committed,
    DEVMATE_PROMPT_CONTENT,
    'The committed prompt file drifted from the scaffold source of truth. ' +
      'Regenerate it from DEVMATE_PROMPT_CONTENT in lib/init/scaffold-prompt.mjs.',
  );
});
