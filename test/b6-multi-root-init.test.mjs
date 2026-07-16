// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  detectMultiRootMode,
  validateMultiRootInit,
} from '../lib/init/multi-root-init.mjs';

/**
 * Create a fresh temp directory for a test case.
 * The caller must call cleanup() in a finally block.
 *
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeTmp() {
  const root = mkdtempSync(join(tmpdir(), 'b6-test-'));
  return { root: resolve(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Write a devmate.config.json under `root/.devmate/`.
 * @param {string} root
 * @param {unknown} config
 */
function writeConfig(root, config) {
  mkdirSync(join(root, '.devmate'), { recursive: true });
  writeFileSync(join(root, '.devmate', 'devmate.config.json'), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// detectMultiRootMode
// ---------------------------------------------------------------------------

test('detectMultiRootMode — returns false when config is absent', async () => {
  const { root, cleanup } = makeTmp();
  try {
    assert.equal(await detectMultiRootMode(root), false);
  } finally {
    cleanup();
  }
});

test('detectMultiRootMode — returns false when config has no mode field', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, { schemaVersion: 1, personas: [{ persona: 'api', editableGlobs: [] }] });
    assert.equal(await detectMultiRootMode(root), false);
  } finally {
    cleanup();
  }
});

test('detectMultiRootMode — returns false when mode is "single-root"', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, { schemaVersion: 1, mode: 'single-root', personas: [{ persona: 'api', editableGlobs: [] }] });
    assert.equal(await detectMultiRootMode(root), false);
  } finally {
    cleanup();
  }
});

test('detectMultiRootMode — returns true when mode is "multi-root"', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, {
      schemaVersion: 1,
      mode: 'multi-root',
      personas: [
        { persona: 'api', repo: 'portals-api', editableGlobs: [] },
        { persona: 'frontend', repo: 'portals-ui', editableGlobs: [] },
      ],
    });
    assert.equal(await detectMultiRootMode(root), true);
  } finally {
    cleanup();
  }
});

test('detectMultiRootMode — returns false (does not throw) when config JSON is malformed', async () => {
  const { root, cleanup } = makeTmp();
  try {
    mkdirSync(join(root, '.devmate'), { recursive: true });
    writeFileSync(join(root, '.devmate', 'devmate.config.json'), '{not valid json');
    assert.equal(await detectMultiRootMode(root), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// validateMultiRootInit
// ---------------------------------------------------------------------------

/** @returns {object} Minimal valid multi-root config */
function validMultiRootConfig() {
  return {
    schemaVersion: 1,
    mode: 'multi-root',
    primary: 'portals-api',
    repos: ['portals-api', 'portals-ui'],
    personas: [
      { persona: 'api', repo: 'portals-api', editableGlobs: ['src/**'] },
      { persona: 'frontend', repo: 'portals-ui', editableGlobs: ['src/**'] },
    ],
  };
}

test('validateMultiRootInit — returns ok: true and errors: [] for a valid config', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, validMultiRootConfig());
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — returns ok: false when personas have duplicate names', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, {
      schemaVersion: 1,
      mode: 'multi-root',
      personas: [
        { persona: 'editor', repo: 'portals-api', editableGlobs: [] },
        { persona: 'editor', repo: 'portals-ui', editableGlobs: [] },
      ],
    });
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, 'expected at least one error');
    assert.ok(result.errors[0].includes('editor'), 'error should name the duplicate persona');
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — returns ok: false when a persona is missing the repo field in multi-root mode', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, {
      schemaVersion: 1,
      mode: 'multi-root',
      personas: [
        { persona: 'api', editableGlobs: [] }, // missing repo
      ],
    });
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — creates .devmate/state/ when absent; records path in created', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, validMultiRootConfig());
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, true);
    const stateDirAbs = join(root, '.devmate', 'state');
    assert.ok(result.created.includes(stateDirAbs), 'created should include state dir path');
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — creates MEMORY.md scaffold when absent; records path in created', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, validMultiRootConfig());
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, true);
    const memoryAbs = join(root, '.devmate', 'MEMORY.md');
    assert.ok(result.created.includes(memoryAbs), 'created should include MEMORY.md path');
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — does NOT overwrite existing MEMORY.md; created does not include MEMORY.md path', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, validMultiRootConfig());
    // Pre-create MEMORY.md with custom content.
    const memoryAbs = join(root, '.devmate', 'MEMORY.md');
    writeFileSync(memoryAbs, '# Existing memory\n');
    const result = await validateMultiRootInit(root);
    assert.equal(result.ok, true);
    assert.ok(!result.created.includes(memoryAbs), 'should not overwrite existing MEMORY.md');
    // Content must be unchanged.
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(memoryAbs, 'utf8'), '# Existing memory\n');
  } finally {
    cleanup();
  }
});

test('validateMultiRootInit — calling twice on the same root is idempotent (created is empty on second call)', async () => {
  const { root, cleanup } = makeTmp();
  try {
    writeConfig(root, validMultiRootConfig());
    await validateMultiRootInit(root); // first call — creates artefacts
    const second = await validateMultiRootInit(root); // second call — nothing to create
    assert.equal(second.ok, true);
    assert.deepEqual(second.created, []);
  } finally {
    cleanup();
  }
});
