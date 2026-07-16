// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  loadPersonaInstructions,
  checkPersonaInstructionFiles,
} from '../../lib/persona-instructions.mjs';

/** @typedef {import('../../lib/types.mjs').PersonaEntry} PersonaEntry */

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'persona-instr-'));
}

// ---- loadPersonaInstructions ----

test('persona-instructions - instructionFile=null returns empty string', async () => {
  /** @type {PersonaEntry} */
  const persona = { persona: 'backend', editableGlobs: ['src/**'], instructionFile: null };
  const out = await loadPersonaInstructions('/nonexistent', persona);
  assert.equal(out, '');
});

test('persona-instructions - omitted instructionFile returns empty string', async () => {
  /** @type {PersonaEntry} */
  const persona = { persona: 'backend', editableGlobs: ['src/**'] };
  const out = await loadPersonaInstructions('/nonexistent', persona);
  assert.equal(out, '');
});

test('persona-instructions - instructionFile pointing to existing file returns content', async () => {
  const root = makeTempRoot();
  try {
    const rel = 'docs/devmate/backend-instructions.md';
    const abs = join(root, rel);
    const dir = dirname(abs);
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, '# Backend persona\nYou are a Java/Spring Boot expert.', 'utf8');
    /** @type {PersonaEntry} */
    const persona = { persona: 'backend', editableGlobs: ['src/**'], instructionFile: rel };
    const out = await loadPersonaInstructions(root, persona);
    assert.equal(out, '# Backend persona\nYou are a Java/Spring Boot expert.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persona-instructions - instructionFile pointing to missing file returns empty string (no throw)', async () => {
  const root = makeTempRoot();
  try {
    /** @type {PersonaEntry} */
    const persona = {
      persona: 'backend',
      editableGlobs: ['src/**'],
      instructionFile: 'docs/does-not-exist.md',
    };
    const out = await loadPersonaInstructions(root, persona);
    assert.equal(out, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persona-instructions - whitespace-only instructionFile returns empty string', async () => {
  /** @type {PersonaEntry} */
  const persona = {
    persona: 'backend',
    editableGlobs: ['src/**'],
    instructionFile: '   ',
  };
  const out = await loadPersonaInstructions('/tmp', persona);
  assert.equal(out, '');
});

// ---- checkPersonaInstructionFiles ----

test('checkPersonaInstructionFiles - skips personas with null instructionFile', () => {
  /** @type {PersonaEntry[]} */
  const personas = [
    { persona: 'backend', editableGlobs: ['src/**'], instructionFile: null },
    { persona: 'frontend', editableGlobs: ['src/**'] },
  ];
  const result = checkPersonaInstructionFiles('/tmp', personas, () => false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.present, []);
});

test('checkPersonaInstructionFiles - reports missing files', () => {
  /** @type {PersonaEntry[]} */
  const personas = [
    { persona: 'backend', editableGlobs: ['src/**'], instructionFile: 'docs/backend.md' },
    { persona: 'frontend', editableGlobs: ['src/**'], instructionFile: 'docs/frontend.md' },
  ];
  const result = checkPersonaInstructionFiles('/tmp', personas, () => false);
  assert.deepEqual(result.missing.sort(), ['backend', 'frontend']);
  assert.deepEqual(result.present, []);
});

test('checkPersonaInstructionFiles - reports present files', () => {
  /** @type {PersonaEntry[]} */
  const personas = [
    { persona: 'backend', editableGlobs: ['src/**'], instructionFile: 'docs/backend.md' },
  ];
  const result = checkPersonaInstructionFiles('/tmp', personas, () => true);
  assert.deepEqual(result.present, ['backend']);
  assert.deepEqual(result.missing, []);
});

test('checkPersonaInstructionFiles - integration with real existsSync', () => {
  const root = makeTempRoot();
  try {
    const abs = join(root, 'present.md');
    writeFileSync(abs, 'hello', 'utf8');
    /** @type {PersonaEntry[]} */
    const personas = [
      { persona: 'backend', editableGlobs: ['src/**'], instructionFile: 'present.md' },
      { persona: 'frontend', editableGlobs: ['src/**'], instructionFile: 'missing.md' },
    ];
    const result = checkPersonaInstructionFiles(root, personas, existsSync);
    assert.deepEqual(result.present, ['backend']);
    assert.deepEqual(result.missing, ['frontend']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
