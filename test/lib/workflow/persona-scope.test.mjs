// @ts-check

/**
 * assertPersonaScope — completion-time persona edit-boundary guard. Verifies a
 * @fullstack dispatch's reported changedFiles stay inside its persona's
 * territory (delegates the semantics to filesOutsidePersonaScope). Fails closed
 * on an empty/unknown persona; a shared/unowned file is not a violation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPersonaScope } from '../../../lib/workflow/orchestrator.mjs';

/** @typedef {import('../../../lib/types.mjs').DevmateConfig} DevmateConfig */

/** @type {DevmateConfig} */
const config = {
  schemaVersion: 1,
  personas: [
    { persona: 'backend', editableGlobs: ['lib/**', 'src/**'], offLimitsGlobs: ['src/ui/**'] },
    { persona: 'frontend', editableGlobs: ['src/ui/**'] },
    { persona: 'editor', editableGlobs: ['docs/**', '*.md'] },
  ],
};

test('assertPersonaScope - all files owned → ok', () => {
  assert.deepEqual(assertPersonaScope('backend', ['lib/a.mjs', 'src/b.mjs'], config), { ok: true });
});

test('assertPersonaScope - out-of-territory file → not ok with violations', () => {
  const r = assertPersonaScope('backend', ['lib/a.mjs', 'src/ui/x.mjs'], config);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ['src/ui/x.mjs']);
  assert.match(r.error ?? '', /backend/);
});

test('assertPersonaScope - shared/unowned file is not a violation', () => {
  assert.deepEqual(assertPersonaScope('backend', ['lib/a.mjs', 'package.json'], config), { ok: true });
});

test('assertPersonaScope - unknown persona fails closed (distinct message, no violations)', () => {
  const r = assertPersonaScope('nope', ['lib/a.mjs'], config);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /unknown persona/i);
  assert.equal(r.violations, undefined);
});

test('assertPersonaScope - empty persona fails closed', () => {
  const r = assertPersonaScope('   ', ['lib/a.mjs'], config);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /persona is required/i);
});

test('assertPersonaScope - undefined/empty changedFiles → ok', () => {
  assert.deepEqual(assertPersonaScope('backend', undefined, config), { ok: true });
  assert.deepEqual(assertPersonaScope('backend', [], config), { ok: true });
});
