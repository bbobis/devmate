// @ts-check

/**
 * PRR-3 integration: the config-gated pr-review precondition wired into the
 * `verification-passed --mark-pr-ready--> pr-ready` transition, exercised
 * end-to-end through the real `transitionGate` (no injected precondition) for
 * the feature and bug lanes. acCoverageGate stays off, so the pr-ready entry's
 * other sub-check is a no-op here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transitionGate } from '../../lib/gate-transitions.mjs';

/**
 * @param {'feature'|'bug'} lane
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function verifiedState(lane) {
  return {
    taskId: 't',
    lane,
    workflowGate: 'verification-passed',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 3,
    budget: 10,
    schemaVersion: 1,
  };
}

/**
 * @param {{ verdict?: string, lane?: string, taskId?: string }} [opts]
 * @returns {Record<string, unknown>}
 */
function prReviewArtifact(opts = {}) {
  return {
    taskId: opts.taskId ?? 't',
    lane: opts.lane ?? 'feature',
    schemaVersion: 1,
    returnedAt: '2026-07-05T00:00:00.000Z',
    contextDigest: 'ctx-digest-abc',
    verdict: opts.verdict ?? 'APPROVE',
    findings: [],
    alignment: { ok: true, outOfScopeFiles: [], unlistedFiles: [], missingRegressionTest: false },
    unverified: [],
  };
}

/**
 * @param {{ mode?: string, result?: unknown }} [opts]
 */
function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prtrans-'));
  const devmate = join(root, '.devmate');
  const stateDir = join(devmate, 'state');
  mkdirSync(join(stateDir, 'trace'), { recursive: true });

  /** @type {Record<string, unknown>} */
  const config = { schemaVersion: 1, personas: [{ persona: 'backend', editableGlobs: ['**'] }] };
  if (opts.mode !== undefined) config.prReviewGate = opts.mode;
  writeFileSync(join(devmate, 'devmate.config.json'), JSON.stringify(config), 'utf8');

  if (opts.result !== undefined) {
    writeFileSync(join(stateDir, 'pr-review-result.json'), JSON.stringify(opts.result), 'utf8');
  }
  return { stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const lane of /** @type {const} */ (['feature', 'bug'])) {
  test(`transitionGate mark-pr-ready / ${lane} / gate off (no key) + no verdict → allowed`, async () => {
    const fx = makeFixture({});
    try {
      const r = await transitionGate(verifiedState(lane), 'mark-pr-ready', { stateDir: fx.stateDir });
      assert.equal(r.ok, true);
      assert.equal(r.state?.workflowGate, 'pr-ready');
    } finally {
      fx.cleanup();
    }
  });

  test(`transitionGate mark-pr-ready / ${lane} / block + APPROVE verdict → allowed`, async () => {
    const fx = makeFixture({ mode: 'block', result: prReviewArtifact({ lane }) });
    try {
      const r = await transitionGate(verifiedState(lane), 'mark-pr-ready', { stateDir: fx.stateDir });
      assert.equal(r.ok, true);
      assert.equal(r.state?.workflowGate, 'pr-ready');
    } finally {
      fx.cleanup();
    }
  });

  test(`transitionGate mark-pr-ready / ${lane} / block + missing verdict → refused`, async () => {
    const fx = makeFixture({ mode: 'block' });
    try {
      const r = await transitionGate(verifiedState(lane), 'mark-pr-ready', { stateDir: fx.stateDir });
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /pr-ready/);
      assert.match(r.error ?? '', /pr-review:/);
    } finally {
      fx.cleanup();
    }
  });

  test(`transitionGate mark-pr-ready / ${lane} / block + REQUEST_CHANGES → refused`, async () => {
    const fx = makeFixture({
      mode: 'block',
      result: prReviewArtifact({ lane, verdict: 'REQUEST_CHANGES: findings open' }),
    });
    try {
      const r = await transitionGate(verifiedState(lane), 'mark-pr-ready', { stateDir: fx.stateDir });
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /not APPROVE/);
    } finally {
      fx.cleanup();
    }
  });

  test(`transitionGate mark-pr-ready / ${lane} / warn + missing verdict → allowed`, async () => {
    const fx = makeFixture({ mode: 'warn' });
    try {
      const r = await transitionGate(verifiedState(lane), 'mark-pr-ready', { stateDir: fx.stateDir });
      assert.equal(r.ok, true);
      assert.equal(r.state?.workflowGate, 'pr-ready');
    } finally {
      fx.cleanup();
    }
  });
}
