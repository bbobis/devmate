// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateDevmateConfig,
  loadDevmateConfig,
} from '../../../lib/config/devmate-config.mjs';

/**
 * Create an isolated repo-root fixture with a .devmate/devmate.config.json.
 * @param {unknown} config
 * @returns {{ repoRoot: string, configPath: string, cleanup: () => void }}
 */
function writeConfigFixture(config) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'devmate-multiroot-'));
  const configPath = join(repoRoot, '.devmate', 'devmate.config.json');
  mkdirSync(join(repoRoot, '.devmate'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return { repoRoot, configPath, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

const MULTI_ROOT_CONFIG = {
  schemaVersion: 2,
  mode: 'multi-root',
  primary: 'portals-api',
  repos: ['portals-api', 'portals-ui'],
  personas: [
    { persona: 'backend', repo: 'portals-api', editableGlobs: [] },
    { persona: 'frontend', repo: 'portals-ui', editableGlobs: [] },
  ],
};

test('loadDevmateConfig - multi-root resolves an absolute repoPath per persona', () => {
  const { repoRoot, configPath, cleanup } = writeConfigFixture(MULTI_ROOT_CONFIG);
  try {
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.personas[0].repoPath, resolve(repoRoot, 'portals-api'));
    assert.equal(result.config.personas[1].repoPath, resolve(repoRoot, 'portals-ui'));
  } finally {
    cleanup();
  }
});

test('loadDevmateConfig - multi-root preserves top-level fields', () => {
  const { repoRoot, configPath, cleanup } = writeConfigFixture(MULTI_ROOT_CONFIG);
  try {
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.schemaVersion, 2);
    assert.equal(result.config.mode, 'multi-root');
    assert.equal(result.config.primary, 'portals-api');
    assert.deepEqual(result.config.repos, ['portals-api', 'portals-ui']);
  } finally {
    cleanup();
  }
});

test('loadDevmateConfig - multi-root preserves existing per-persona fields', () => {
  const { repoRoot, configPath, cleanup } = writeConfigFixture(MULTI_ROOT_CONFIG);
  try {
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.personas[0].persona, 'backend');
    assert.equal(result.config.personas[0].repo, 'portals-api');
    assert.deepEqual(result.config.personas[0].editableGlobs, []);
  } finally {
    cleanup();
  }
});

test('loadDevmateConfig - multi-root derives repoRoot from configPath when omitted', () => {
  const { repoRoot, configPath, cleanup } = writeConfigFixture(MULTI_ROOT_CONFIG);
  try {
    // No explicit repoRoot: derived as dirname twice from configPath (the repo root).
    const result = loadDevmateConfig(configPath);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.personas[0].repoPath, resolve(repoRoot, 'portals-api'));
    assert.equal(result.config.personas[1].repoPath, resolve(repoRoot, 'portals-ui'));
  } finally {
    cleanup();
  }
});

test('loadDevmateConfig - single-root config is unchanged (no repoPath added)', () => {
  const singleRoot = {
    schemaVersion: 1,
    personas: [
      { persona: 'backend', editableGlobs: ['src/api/**'], testGlobs: ['**/*.spec.ts'] },
    ],
    verification: { unitTest: 'run-unit-tests' },
  };
  const { repoRoot, configPath, cleanup } = writeConfigFixture(singleRoot);
  try {
    // Passing a repoRoot must have no effect in single-root mode.
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.config, singleRoot);
    assert.equal('repoPath' in result.config.personas[0], false);
  } finally {
    cleanup();
  }
});

test('loadDevmateConfig - mode other than multi-root is treated as single-root', () => {
  const oddMode = {
    schemaVersion: 1,
    mode: 'single-root',
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
  };
  const { configPath, cleanup } = writeConfigFixture(oddMode);
  try {
    const result = loadDevmateConfig(configPath);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal('repoPath' in result.config.personas[0], false);
  } finally {
    cleanup();
  }
});

test('validateDevmateConfig - multi-root persona missing repo = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    repos: ['portals-api'],
    personas: [{ persona: 'backend', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('repo'));
  }
});

test('validateDevmateConfig - multi-root persona with empty repo = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    repos: ['portals-api'],
    personas: [{ persona: 'backend', repo: '   ', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - multi-root missing personas = fail (existing rule still applies)', () => {
  const result = validateDevmateConfig({ schemaVersion: 2, mode: 'multi-root', repos: [] });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - multi-root persona missing editableGlobs = fail (existing rule still applies)', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    repos: ['portals-api'],
    personas: [{ persona: 'backend', repo: 'portals-api' }],
  });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - multi-root missing primary = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    repos: ['portals-api'],
    personas: [{ persona: 'backend', repo: 'portals-api', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('primary must be a non-empty string in multi-root mode'));
  }
});

test('validateDevmateConfig - multi-root missing repos = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'portals-api',
    personas: [{ persona: 'backend', repo: 'portals-api', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('repos must be a non-empty array of strings in multi-root mode'));
  }
});

test('validateDevmateConfig - multi-root empty repos array = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'portals-api',
    repos: [],
    personas: [{ persona: 'backend', repo: 'portals-api', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
});

test('validateDevmateConfig - multi-root non-string repos entry = fail', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'portals-api',
    repos: ['portals-api', 42],
    personas: [{ persona: 'backend', repo: 'portals-api', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('repos[1] must be a string'));
  }
});

test('validateDevmateConfig - primary not listed in repos = ok with a warning, never an error', () => {
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    primary: 'payments',
    repos: ['portals-api'],
    personas: [{ persona: 'backend', repo: 'portals-api', editableGlobs: [] }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const warnings = result.warnings ?? [];
  assert.ok(
    warnings.some((w) => w.includes("primary 'payments' is not listed in repos")),
    `expected a primary-not-in-repos warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('validateDevmateConfig - primary listed in repos = no drift warning', () => {
  const result = validateDevmateConfig(MULTI_ROOT_CONFIG);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const warnings = result.warnings ?? [];
  assert.ok(!warnings.some((w) => w.includes('not listed in repos')));
});

test('validateDevmateConfig - a persona missing repo still fails on the repo check, not the primary/repos check', () => {
  // Order guarantee: the per-persona and dup-persona checks run BEFORE the
  // primary/repos enforcement, so pre-existing fixtures keep their reason.
  const result = validateDevmateConfig({
    schemaVersion: 2,
    mode: 'multi-root',
    personas: [{ persona: 'backend', editableGlobs: [] }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('repo must be a non-empty string in multi-root mode'));
  }
});

test('validateDevmateConfig - single-root persona is NOT required to have repo', () => {
  const result = validateDevmateConfig({
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
  });
  assert.equal(result.ok, true);
});

test('loadDevmateConfig - multi-root missing file handled exactly as before', () => {
  const result = loadDevmateConfig('/nonexistent/.devmate/devmate.config.json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes('devmate init') || result.error.includes('not found'));
  }
});

test('loadDevmateConfig - multi-root malformed JSON handled exactly as before', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'devmate-multiroot-'));
  const configPath = join(repoRoot, '.devmate', 'devmate.config.json');
  mkdirSync(join(repoRoot, '.devmate'), { recursive: true });
  writeFileSync(configPath, '{ invalid json }', 'utf8');
  try {
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('resolveMultiRootConfig - does not mutate the validated config personas', () => {
  const { repoRoot, configPath, cleanup } = writeConfigFixture(MULTI_ROOT_CONFIG);
  try {
    const result = loadDevmateConfig(configPath, repoRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Original literal must remain free of repoPath (shallow-copy guarantee).
    assert.equal('repoPath' in MULTI_ROOT_CONFIG.personas[0], false);
  } finally {
    cleanup();
  }
});
