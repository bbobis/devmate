// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepoSignals } from '../../../lib/init/scan-repo-signals.mjs';

/**
 * Make a throwaway temp repo root.
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'scan-signals-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('scanRepoSignals — detects a TS/JS frontend layout', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src', 'ui'), { recursive: true });

    const s = await scanRepoSignals(root);
    assert.equal(s.hasPackageJson, true);
    assert.equal(s.hasTsconfig, true);
    assert.equal(s.hasJavaBuild, false);
    assert.ok(s.topLevelDirs.includes('public'));
    assert.ok(s.topLevelDirs.includes('src'));
    assert.ok(s.srcSubdirs.includes('ui'));
    assert.deepEqual(s.srcChildren, ['ui']);
  } finally {
    cleanup();
  }
});

test('scanRepoSignals — detects a Java backend layout (pom.xml + src/main/java)', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'pom.xml'), '<project/>');
    mkdirSync(join(root, 'src', 'main', 'java'), { recursive: true });
    mkdirSync(join(root, 'src', 'test', 'java'), { recursive: true });

    const s = await scanRepoSignals(root);
    assert.equal(s.hasJavaBuild, true);
    assert.equal(s.hasPackageJson, false);
    assert.ok(s.srcSubdirs.includes('main/java'));
    assert.ok(s.srcSubdirs.includes('test/java'));
    assert.deepEqual(s.srcChildren, ['main', 'test']);
  } finally {
    cleanup();
  }
});

test('scanRepoSignals — build.gradle counts as a Java build', async () => {
  const { root, cleanup } = makeRoot();
  try {
    writeFileSync(join(root, 'build.gradle'), '');
    const s = await scanRepoSignals(root);
    assert.equal(s.hasJavaBuild, true);
  } finally {
    cleanup();
  }
});

test('scanRepoSignals — empty repo yields empty/false signals', async () => {
  const { root, cleanup } = makeRoot();
  try {
    const s = await scanRepoSignals(root);
    assert.equal(s.hasPackageJson, false);
    assert.equal(s.hasTsconfig, false);
    assert.equal(s.hasJavaBuild, false);
    assert.deepEqual(s.srcSubdirs, []);
    assert.deepEqual(s.topLevelDirs, []);
    assert.deepEqual(s.srcChildren, []);
  } finally {
    cleanup();
  }
});

test('scanRepoSignals — topLevelDirs lists only directories, sorted', async () => {
  const { root, cleanup } = makeRoot();
  try {
    mkdirSync(join(root, 'zeta'), { recursive: true });
    mkdirSync(join(root, 'alpha'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# x'); // file, must be excluded

    const s = await scanRepoSignals(root);
    assert.deepEqual(s.topLevelDirs, ['alpha', 'zeta']);
    assert.ok(!s.topLevelDirs.includes('README.md'));
  } finally {
    cleanup();
  }
});
