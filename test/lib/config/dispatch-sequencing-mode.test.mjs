// @ts-check
/**
 * RC-3 (#231): the `dispatchSequencing` config knob — resolver default and
 * validation. Mirrors the delegation-floor / persona-scope off|warn|block
 * pattern; the default is 'warn' (advisory), like personaScope.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveDispatchSequencingMode,
  validateDevmateConfig,
} from '../../../lib/config/devmate-config.mjs';

test('dispatchSequencing › defaults to warn when unset or non-object', () => {
  assert.equal(resolveDispatchSequencingMode(null), 'warn');
  assert.equal(resolveDispatchSequencingMode(undefined), 'warn');
  assert.equal(resolveDispatchSequencingMode({}), 'warn');
  assert.equal(resolveDispatchSequencingMode('nope'), 'warn');
});

test('dispatchSequencing › honors an explicit off | warn | block', () => {
  assert.equal(resolveDispatchSequencingMode({ dispatchSequencing: 'off' }), 'off');
  assert.equal(resolveDispatchSequencingMode({ dispatchSequencing: 'warn' }), 'warn');
  assert.equal(resolveDispatchSequencingMode({ dispatchSequencing: 'block' }), 'block');
});

test('dispatchSequencing › an unrecognized value falls back to the warn default', () => {
  assert.equal(resolveDispatchSequencingMode({ dispatchSequencing: 'loud' }), 'warn');
});

/** A minimal otherwise-valid single-root config, so validation reaches the dispatchSequencing check. */
const BASE = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['src/**'] }] };

test('validateDevmateConfig › accepts a valid dispatchSequencing and an absent one', () => {
  assert.equal(validateDevmateConfig({ ...BASE, dispatchSequencing: 'block' }).ok, true);
  assert.equal(validateDevmateConfig({ ...BASE }).ok, true);
});

test('validateDevmateConfig › rejects an invalid dispatchSequencing with a named error', () => {
  const r = validateDevmateConfig({ ...BASE, dispatchSequencing: 'sometimes' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /dispatchSequencing must be one of 'off', 'warn', 'block'/);
});
