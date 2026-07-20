// @ts-check
/**
 * #202 — unit coverage for the test-only CAS-conflict seam. The seam's whole job
 * is to make a version conflict DETERMINISTIC; these tests pin its grammar and
 * its per-attempt budget with an INJECTED bump (no task.json needed), then the
 * handler-integration tests (test/hooks/cas-conflict-coverage.test.mjs) prove the
 * real loops retry and exhaust.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedConflictCount,
  forceConflictIfArmed,
  resetCasConflictSeam,
  CAS_CONFLICT_ENV,
} from '../../../lib/testing/cas-conflict-seam.mjs';

test('armedConflictCount — parses "<site>:<n>" for a known site targeting itself', () => {
  const env = { [CAS_CONFLICT_ENV]: 'gate-advance:3' };
  assert.equal(armedConflictCount('gate-advance', env), 3);
  assert.equal(armedConflictCount('approve-plan', { [CAS_CONFLICT_ENV]: 'approve-plan:1' }), 1);
});

test('armedConflictCount — inert (0) for every non-matching or malformed case', () => {
  const cases = [
    ['gate-advance', {}],                                          // unset
    ['gate-advance', { [CAS_CONFLICT_ENV]: '' }],                  // empty
    ['gate-advance', { [CAS_CONFLICT_ENV]: 'gate-advance' }],      // no colon
    ['gate-advance', { [CAS_CONFLICT_ENV]: 'gate-advance:' }],     // no count
    ['gate-advance', { [CAS_CONFLICT_ENV]: 'gate-advance:0' }],    // count must be positive
    ['gate-advance', { [CAS_CONFLICT_ENV]: 'gate-advance:x' }],    // non-numeric
    ['gate-advance', { [CAS_CONFLICT_ENV]: 'gate-advance:-1' }],   // negative
    ['approve-plan', { [CAS_CONFLICT_ENV]: 'gate-advance:2' }],    // spec targets a DIFFERENT site
    ['unknown-site', { [CAS_CONFLICT_ENV]: 'unknown-site:2' }],    // site not in the allow-set
  ];
  for (const [site, env] of cases) {
    assert.equal(
      armedConflictCount(/** @type {string} */ (site), /** @type {any} */ (env)),
      0,
      `expected inert for site=${site} env=${JSON.stringify(env)}`,
    );
  }
});

test('forceConflictIfArmed — does nothing when unarmed (no bump, no throw)', async () => {
  resetCasConflictSeam();
  let bumps = 0;
  await forceConflictIfArmed('gate-advance', '/tmp/whatever', {
    env: {},
    bumpVersion: async () => { bumps += 1; },
  });
  assert.equal(bumps, 0, 'an unarmed seam performs no bump');
});

test('forceConflictIfArmed — bumps exactly N times then stops (budget exhaustion)', async () => {
  resetCasConflictSeam();
  let bumps = 0;
  const opts = {
    env: { [CAS_CONFLICT_ENV]: 'gate-advance:2' },
    bumpVersion: async () => { bumps += 1; },
  };
  // Four attempts, budget 2 → only the first two bump.
  await forceConflictIfArmed('gate-advance', '/s', opts);
  await forceConflictIfArmed('gate-advance', '/s', opts);
  await forceConflictIfArmed('gate-advance', '/s', opts);
  await forceConflictIfArmed('gate-advance', '/s', opts);
  assert.equal(bumps, 2, 'the seam bumps exactly its armed budget, then lets commits land');
});

test('forceConflictIfArmed — per-site budgets are independent', async () => {
  resetCasConflictSeam();
  let ga = 0;
  let ap = 0;
  await forceConflictIfArmed('gate-advance', '/s', {
    env: { [CAS_CONFLICT_ENV]: 'gate-advance:1' },
    bumpVersion: async () => { ga += 1; },
  });
  await forceConflictIfArmed('approve-plan', '/s', {
    env: { [CAS_CONFLICT_ENV]: 'approve-plan:1' },
    bumpVersion: async () => { ap += 1; },
  });
  assert.equal(ga, 1);
  assert.equal(ap, 1);
});

test('resetCasConflictSeam — clears a spent budget so a later run re-arms', async () => {
  resetCasConflictSeam();
  let bumps = 0;
  const opts = {
    env: { [CAS_CONFLICT_ENV]: 'gate-advance:1' },
    bumpVersion: async () => { bumps += 1; },
  };
  await forceConflictIfArmed('gate-advance', '/s', opts); // bumps → 1
  await forceConflictIfArmed('gate-advance', '/s', opts); // budget spent → no bump
  assert.equal(bumps, 1);
  resetCasConflictSeam();
  await forceConflictIfArmed('gate-advance', '/s', opts); // re-armed → bumps → 2
  assert.equal(bumps, 2);
});
