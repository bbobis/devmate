// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDevmateReady, checkGateGuardActive } from '../lib/startup.mjs';

/**
 * Seed a temp dir that looks like a devmate PLUGIN install: a hooks manifest
 * registering the gate-guard, plus the script it references.
 * @param {string} pluginRoot
 * @param {{ withScript?: boolean }} [opts]
 * @returns {void}
 */
function seedPluginRoot(pluginRoot, opts = {}) {
  const { withScript = true } = opts;
  const hooksDir = join(pluginRoot, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, 'hooks.json'),
    JSON.stringify({
      schemaVersion: 1,
      hooks: {
        PreToolUse: [
          {
            type: 'command',
            command: 'node "${PLUGIN_ROOT}/scripts/gate-guard.mjs"',
            windows: 'node "${PLUGIN_ROOT}\\scripts\\gate-guard.mjs"',
            timeout: 10,
          },
        ],
      },
    }),
  );

  if (withScript) {
    const scriptsDir = join(pluginRoot, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'gate-guard.mjs'), '// gate-guard script\n');
  }
}

/**
 * Seed a temp dir that looks like a CONSUMER repo: a `.devmate/` config and
 * nothing else. Deliberately has no `hooks/` or `scripts/` — that is exactly
 * what a repo which merely installs the devmate plugin looks like.
 * @param {string} repoRoot
 * @returns {void}
 */
function seedConsumerRepo(repoRoot) {
  const configDir = join(repoRoot, '.devmate');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [
        {
          persona: 'frontend',
          editableGlobs: ['src/ui/**'],
        },
      ],
    }),
  );
}

/**
 * @returns {{ dir: string, cleanup: () => void }}
 */
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'devmate-startup-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

// ---- The regression: a consumer repo has no hooks/ of its own ----

test('assertDevmateReady - consumer repo with NO hooks/ dir is ready (regression: #72)', () => {
  // The bug: the gate-guard check resolved `hooks/hooks.json` against the
  // USER's repo root. `hooks/hooks.json` is plugin-shipped, so it is never
  // there — readiness failed for every plugin consumer and SessionStart
  // returned 1 before seeding the layout, injecting memory, or emitting the
  // resume plan / state anchor.
  const { dir: repoRoot, cleanup } = makeTmp();
  try {
    seedConsumerRepo(repoRoot);
    assert.equal(existsSync(join(repoRoot, 'hooks')), false, 'fixture must have no hooks/ dir');

    // No pluginRoot passed — resolves to the real plugin root (this repo),
    // which is exactly what happens at runtime inside a plugin install.
    const result = assertDevmateReady(repoRoot);

    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('assertDevmateReady - gate-guard resolves against pluginRoot, config against repoRoot', () => {
  // The two roots are independent: a valid plugin + a config-less repo must
  // report ONLY the config error, and never a hooks error.
  const { dir: pluginRoot, cleanup: cleanPlugin } = makeTmp();
  const { dir: repoRoot, cleanup: cleanRepo } = makeTmp();
  try {
    seedPluginRoot(pluginRoot);
    // repoRoot intentionally has no .devmate/ config.

    const result = assertDevmateReady(repoRoot, pluginRoot);

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? '', /config/i);
    assert.ok(
      !result.errors.some((e) => /hooks manifest|gate-guard/i.test(e)),
      `hooks error leaked from repoRoot: ${JSON.stringify(result.errors)}`,
    );
  } finally {
    cleanRepo();
    cleanPlugin();
  }
});

// ---- Fail-closed: a broken PLUGIN install is still fatal ----

test('checkGateGuardActive - no argument resolves the real plugin root', () => {
  const result = checkGateGuardActive();
  assert.equal(result.ok, true, `real plugin root must be ready: ${result.error}`);
});

test('checkGateGuardActive - valid plugin root returns ok:true', () => {
  const { dir, cleanup } = makeTmp();
  try {
    seedPluginRoot(dir);
    assert.equal(checkGateGuardActive(dir).ok, true);
  } finally {
    cleanup();
  }
});

test('checkGateGuardActive - plugin root with no manifest returns ok:false', () => {
  const { dir, cleanup } = makeTmp();
  try {
    const result = checkGateGuardActive(dir);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /hooks manifest/i);
  } finally {
    cleanup();
  }
});

test('checkGateGuardActive - registered gate-guard whose script is missing returns ok:false', () => {
  const { dir, cleanup } = makeTmp();
  try {
    seedPluginRoot(dir, { withScript: false });
    const result = checkGateGuardActive(dir);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not found|gate-guard/i);
  } finally {
    cleanup();
  }
});

test('assertDevmateReady - broken plugin install fails closed even with a valid repo', () => {
  const { dir: pluginRoot, cleanup: cleanPlugin } = makeTmp();
  const { dir: repoRoot, cleanup: cleanRepo } = makeTmp();
  try {
    seedConsumerRepo(repoRoot);
    // pluginRoot has no hooks.json at all — a corrupt/incomplete install.

    const result = assertDevmateReady(repoRoot, pluginRoot);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /hooks manifest|gate-guard/i.test(e)));
  } finally {
    cleanRepo();
    cleanPlugin();
  }
});

test('assertDevmateReady - corrupt plugin hooks.json fails closed', () => {
  const { dir: pluginRoot, cleanup: cleanPlugin } = makeTmp();
  const { dir: repoRoot, cleanup: cleanRepo } = makeTmp();
  try {
    mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
    writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), '{bad json');
    seedConsumerRepo(repoRoot);

    const result = assertDevmateReady(repoRoot, pluginRoot);

    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  } finally {
    cleanRepo();
    cleanPlugin();
  }
});

test('assertDevmateReady - broken plugin AND missing config reports both errors', () => {
  const { dir: pluginRoot, cleanup: cleanPlugin } = makeTmp();
  const { dir: repoRoot, cleanup: cleanRepo } = makeTmp();
  try {
    const result = assertDevmateReady(repoRoot, pluginRoot);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2, 'Should have at least 2 errors');
  } finally {
    cleanRepo();
    cleanPlugin();
  }
});
