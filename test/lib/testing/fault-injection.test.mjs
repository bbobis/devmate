// @ts-check
/**
 * Unit tests for the test-only fault seam (#8). These prove the two properties
 * the whole design rests on:
 *   1. The seam is INERT for every input except the exact `"<site>:<mode>"`
 *      grammar for a known site and mode — so a stray or mistyped env value can
 *      never fault a call site by accident.
 *   2. When armed, it enacts exactly the requested mode and nothing else
 *      (a distinct error type for `crash`; a bounded block for `timeout`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENV_VAR,
  FAULT_SITES,
  FAULT_MODES,
  InjectedFaultError,
  armedFaultFor,
  injectFaultIfArmed,
} from '../../../lib/testing/fault-injection.mjs';

/**
 * Build an env object naming only the seam variable — the seam reads nothing
 * else, so this is the whole surface.
 * @param {string|undefined} value
 * @returns {NodeJS.ProcessEnv}
 */
function envWith(value) {
  return value === undefined ? {} : /** @type {NodeJS.ProcessEnv} */ ({ [ENV_VAR]: value });
}

test('armedFaultFor › the known site+mode pairs arm exactly their mode', () => {
  for (const site of FAULT_SITES) {
    for (const mode of FAULT_MODES) {
      assert.equal(armedFaultFor(site, envWith(`${site}:${mode}`)), mode);
    }
  }
});

test('armedFaultFor › an unset or empty variable is inert', () => {
  assert.equal(armedFaultFor('gate-advance', envWith(undefined)), null);
  assert.equal(armedFaultFor('gate-advance', envWith('')), null);
});

test('armedFaultFor › a value for a DIFFERENT site does not arm this one', () => {
  assert.equal(armedFaultFor('gate-advance', envWith('some-other-site:crash')), null);
});

test('armedFaultFor › an unknown mode is inert even for a known site', () => {
  assert.equal(armedFaultFor('gate-advance', envWith('gate-advance:explode')), null);
});

test('armedFaultFor › an unknown ASKING site can never be armed', () => {
  // The asking site must itself be a known FAULT_SITES member, so a call site the
  // seam does not recognize is inert even if the env names it exactly.
  assert.equal(armedFaultFor('not-a-site', envWith('not-a-site:crash')), null);
});

test('armedFaultFor › a malformed value (no colon, edge colons) is inert', () => {
  for (const bad of ['gate-advance', 'gate-advance:', ':crash', 'gate-advance:crash:extra']) {
    assert.equal(armedFaultFor('gate-advance', envWith(bad)), null, `should be inert: ${JSON.stringify(bad)}`);
  }
});

test('injectFaultIfArmed › unarmed is a no-op that returns nothing', () => {
  assert.equal(injectFaultIfArmed('gate-advance', { env: envWith(undefined) }), undefined);
  assert.equal(injectFaultIfArmed('gate-advance', { env: envWith('gate-advance:explode') }), undefined);
});

test('injectFaultIfArmed › crash throws a typed InjectedFaultError naming the site', () => {
  assert.throws(
    () => injectFaultIfArmed('gate-advance', { env: envWith('gate-advance:crash') }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof InjectedFaultError);
      assert.equal(/** @type {InjectedFaultError} */ (err).site, 'gate-advance');
      assert.match(/** @type {Error} */ (err).message, /DEVMATE_FAULT/);
      return true;
    },
  );
});

test('injectFaultIfArmed › timeout blocks for the injected duration, then returns', () => {
  // A tiny sleepMs keeps the test fast; the real seam uses a 60s default so the
  // host timeout always fires first in production use.
  const start = Date.now();
  injectFaultIfArmed('gate-advance', { env: envWith('gate-advance:timeout'), sleepMs: 20 });
  assert.ok(Date.now() - start >= 15, 'timeout mode should have blocked briefly');
});
