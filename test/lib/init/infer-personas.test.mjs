// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPersonas } from '../../../lib/init/infer-personas.mjs';
import { validateDevmateConfig } from '../../../lib/config/devmate-config.mjs';

/** @typedef {import('../../../lib/init/scan-repo-signals.mjs').RepoSignals} RepoSignals */

/**
 * Build a RepoSignals object with sensible empty defaults, overridable.
 * @param {Partial<RepoSignals>} [over]
 * @returns {RepoSignals}
 */
function signals(over = {}) {
  return {
    topLevelDirs: [],
    hasPackageJson: false,
    hasTsconfig: false,
    hasJavaBuild: false,
    srcSubdirs: [],
    srcChildren: [],
    ...over,
  };
}

/**
 * Assert the personas form a schema-valid config.
 * @param {import('../../../lib/types.mjs').PersonaEntry[]} personas
 */
function assertValid(personas) {
  const res = validateDevmateConfig({ schemaVersion: 1, personas });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
}

test('inferPersonas — TS/JS signals yield a frontend persona', () => {
  const personas = inferPersonas(signals({ hasPackageJson: true, hasTsconfig: true }));
  assert.ok(personas.some((p) => p.persona === 'frontend'));
  assert.ok(!personas.some((p) => p.persona === 'backend'));
  assertValid(personas);
});

test('inferPersonas — Java signals yield a backend persona', () => {
  const personas = inferPersonas(signals({ hasJavaBuild: true }));
  assert.ok(personas.some((p) => p.persona === 'backend'));
  assert.ok(!personas.some((p) => p.persona === 'frontend'));
  assertValid(personas);
});

test('inferPersonas — src/main/java alone yields a backend persona', () => {
  const personas = inferPersonas(signals({ srcSubdirs: ['main/java'] }));
  assert.ok(personas.some((p) => p.persona === 'backend'));
  assertValid(personas);
});

test('inferPersonas — both stacks yield two personas', () => {
  const personas = inferPersonas(
    signals({ hasPackageJson: true, hasJavaBuild: true, srcSubdirs: ['main/java', 'ui'] }),
  );
  assert.ok(personas.some((p) => p.persona === 'frontend'));
  assert.ok(personas.some((p) => p.persona === 'backend'));
  assert.equal(personas.length, 2);
  assertValid(personas);
});

test('inferPersonas — frontend globs are grounded in the real top-level layout', () => {
  const personas = inferPersonas(
    signals({ hasPackageJson: true, topLevelDirs: ['app', 'components', 'public', 'server'] }),
  );
  const frontend = personas.find((p) => p.persona === 'frontend');
  assert.ok(frontend);
  // Present UI dirs become editable globs; the present server dir is off-limits.
  assert.deepEqual(frontend.editableGlobs, ['app/**', 'components/**', 'public/**']);
  assert.ok(frontend.offLimitsGlobs?.includes('server/**'));
  assertValid(personas);
});

test('inferPersonas — no matching layout dirs fall back to the literal globs', () => {
  const personas = inferPersonas(signals({ hasPackageJson: true, topLevelDirs: ['docs', 'scripts'] }));
  const frontend = personas.find((p) => p.persona === 'frontend');
  assert.ok(frontend);
  assert.deepEqual(frontend.editableGlobs, ['src/**/*.{ts,tsx,js,jsx,css}', 'public/**']);
  assertValid(personas);
});

test('inferPersonas — backend adds src/main and src/test when present', () => {
  const personas = inferPersonas(
    signals({ hasJavaBuild: true, topLevelDirs: ['lib'], srcChildren: ['main', 'test'] }),
  );
  const backend = personas.find((p) => p.persona === 'backend');
  assert.ok(backend);
  assert.ok(backend.editableGlobs.includes('lib/**'));
  assert.ok(backend.editableGlobs.includes('src/main/**'));
  assert.ok(backend.editableGlobs.includes('src/test/**'));
  assertValid(personas);
});

test('inferPersonas — no recognizable stack falls back to default personas', () => {
  const personas = inferPersonas(signals());
  assert.ok(personas.length >= 1);
  assertValid(personas);
});

test('inferPersonas — deterministic: same input yields identical output', () => {
  const input = signals({ hasPackageJson: true, hasJavaBuild: true });
  const a = inferPersonas(input);
  const b = inferPersonas(input);
  assert.deepEqual(a, b);
});

test('inferPersonas — always returns at least one persona', () => {
  for (const over of [{}, { hasPackageJson: true }, { hasJavaBuild: true }]) {
    const personas = inferPersonas(signals(over));
    assert.ok(personas.length >= 1);
  }
});
