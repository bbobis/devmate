// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildStarterConfig, buildConfigFromPersonas, initConfig } from '../../../lib/config/init-config.mjs';
import { validateDevmateConfig } from '../../../lib/config/devmate-config.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'devmate-init-'));
}

test('buildStarterConfig - returns a schema-valid config', () => {
  const cfg = buildStarterConfig();
  const result = validateDevmateConfig(cfg);
  assert.equal(result.ok, true);
});

test('buildStarterConfig - has at least one persona with editable globs', () => {
  const cfg = buildStarterConfig();
  assert.ok(cfg.personas.length >= 1);
  // Verification is now a (possibly empty) checks list, not the legacy triplet.
  assert.ok(Array.isArray(cfg.verification?.checks));
  for (const p of cfg.personas) {
    assert.ok(typeof p.persona === 'string' && p.persona.length > 0);
    assert.ok(Array.isArray(p.editableGlobs) && p.editableGlobs.length > 0);
    assert.ok(Array.isArray(p.testGlobs) && p.testGlobs.length > 0);
  }
});

test('buildConfigFromPersonas - carries inferred verification checks through validation', () => {
  const checks = [
    { id: 'unit-test', command: 'npm test', category: 'unit-test', source: 'package.json#scripts.test' },
    { id: 'lint', command: 'npm run lint', category: 'lint', source: 'package.json#scripts.lint' },
  ];
  const cfg = buildConfigFromPersonas(
    [{ persona: 'app', editableGlobs: ['src/**'] }],
    { checks },
  );
  assert.deepEqual(cfg.verification?.checks, checks);
  assert.equal(validateDevmateConfig(cfg).ok, true);
});

test('buildConfigFromPersonas - defaults to the empty verification floor', () => {
  const cfg = buildConfigFromPersonas([{ persona: 'app', editableGlobs: ['src/**'] }]);
  assert.deepEqual(cfg.verification?.checks, []);
  assert.equal(validateDevmateConfig(cfg).ok, true);
});

test('initConfig - writes a valid file when none exists', () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    const result = initConfig({ configPath: path });
    assert.equal(result.ok, true);
    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(validateDevmateConfig(parsed).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initConfig - refuses to overwrite an existing file without force', () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"existing":true}', 'utf8');
    const result = initConfig({ configPath: path });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /already exists/);
    // original content untouched
    assert.match(readFileSync(path, 'utf8'), /existing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initConfig - overwrites with force', () => {
  const dir = tmp();
  try {
    const path = join(dir, '.devmate', 'devmate.config.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"existing":true}', 'utf8');
    const result = initConfig({ configPath: path, force: true });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(validateDevmateConfig(parsed).ok, true);
    assert.equal(parsed.existing, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
