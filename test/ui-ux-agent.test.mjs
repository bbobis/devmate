// @ts-check

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createUiBriefArtifact,
  persistUiBriefArtifact,
  readUiBriefArtifact,
  validateUiBriefArtifact,
  writeUiBriefArtifact,
} from '../lib/workflow/agents/ui-ux.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';

/**
 * @returns {string}
 */
function makeTmpRepo() {
  return mkdtempSync(join(tmpdir(), 'devmate-ui-ux-'));
}

test('createUiBriefArtifact / returns typed sections and unverified normalization', () => {
  const artifact = createUiBriefArtifact({
    featureDescription: 'Checkout page update',
    planArtifact: {
      screens: [' Checkout ', '[UNVERIFIED] Guest checkout modal'],
      interactions: ['Submit order', 'Retry payment'],
      errorStates: ['Card decline'],
      components: ['PaymentForm', 'OrderSummary'],
      unverified: ['needs legacy flow verification'],
    },
  });

  assert.deepEqual(artifact.screens, ['Checkout', '[UNVERIFIED] Guest checkout modal']);
  assert.deepEqual(artifact.interactions, ['Submit order', 'Retry payment']);
  assert.deepEqual(artifact.errorStates, ['Card decline']);
  assert.deepEqual(artifact.components, ['PaymentForm', 'OrderSummary']);
  assert.equal(artifact.unverified.includes('[UNVERIFIED] Guest checkout modal'), true);
  assert.equal(artifact.unverified.includes('[UNVERIFIED] needs legacy flow verification'), true);
});

test('createUiBriefArtifact / defaults to empty arrays when planArtifact is absent', () => {
  const artifact = createUiBriefArtifact({ featureDescription: 'Minimal feature' });

  assert.deepEqual(artifact.screens, []);
  assert.deepEqual(artifact.interactions, []);
  assert.deepEqual(artifact.errorStates, []);
  assert.deepEqual(artifact.components, []);
  assert.deepEqual(artifact.unverified, []);
});

test('validateUiBriefArtifact / accepts valid artifact', () => {
  const artifact = createUiBriefArtifact({
    featureDescription: 'Orders dashboard',
    planArtifact: {
      screens: ['Orders dashboard'],
      interactions: ['Filter by status'],
      errorStates: ['Empty result', 'Network timeout'],
      components: ['OrdersTable', 'StatusFilter'],
      unverified: ['server-side sorting details pending'],
    },
  });

  const verdict = validateUiBriefArtifact(artifact);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test('validateUiBriefArtifact / rejects malformed sections and invalid unverified tag', () => {
  const verdict = validateUiBriefArtifact({
    screens: ['Home'],
    interactions: ['Open details'],
    errorStates: [''],
    components: ['CardList'],
    unverified: ['missing prefix'],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('errorStates[0]')), true);
  assert.equal(verdict.errors.some((e) => e.includes('unverified[0]')), true);
});

test('integration / ui-ux artifact satisfies orchestrator dispatch guard', () => {
  const payload = createUiBriefArtifact({
    featureDescription: 'Profile edit flow',
    planArtifact: {
      screens: ['Profile editor'],
      interactions: ['Save profile'],
      errorStates: ['Validation message'],
      components: ['ProfileForm'],
    },
  });

  const dispatchVerdict = assertDispatchResult('ui-ux', {
    status: 'ok',
    payload,
  });

  assert.equal(dispatchVerdict.ok, true);
});

test('negative / empty ui-ux payload blocks dispatch progression', () => {
  const dispatchVerdict = assertDispatchResult('ui-ux', {
    status: 'ok',
    payload: {},
  });

  assert.equal(dispatchVerdict.ok, false);
  const message = dispatchVerdict.error ?? '';
  assert.equal(message.toLowerCase().includes('ui-ux'), true);
});

test('regression / ui brief keeps concrete screens, states, and components', () => {
  const payload = createUiBriefArtifact({
    featureDescription: 'Cart flow improvements',
    planArtifact: {
      screens: ['Cart summary'],
      interactions: ['Apply coupon'],
      errorStates: ['Coupon expired'],
      components: ['CouponInput', 'CartTotals'],
    },
  });

  for (const screen of payload.screens) {
    assert.equal(screen.trim().length >= 2, true);
  }
  for (const state of payload.errorStates) {
    assert.equal(state.trim().length >= 2, true);
  }
  for (const component of payload.components) {
    assert.equal(component.trim().length >= 2, true);
  }
});

test('integration / write and read ui-brief artifact round-trip', async () => {
  const repoRoot = makeTmpRepo();
  try {
    const taskId = 'T-UI-BRIEF-ROUNDTRIP';
    const artifact = createUiBriefArtifact({
      featureDescription: 'Notifications panel',
      planArtifact: {
        screens: ['Notifications panel'],
        interactions: ['Mark all as read'],
        errorStates: ['Unable to load notifications'],
        components: ['NotificationList', 'ToolbarActions'],
      },
    });

    const writeResult = await writeUiBriefArtifact(taskId, artifact, { repoRoot });
    const readResult = await readUiBriefArtifact(taskId, { repoRoot });

    assert.equal(writeResult.path, join(repoRoot, '.devmate', 'session', taskId, 'ui-brief.json'));
    assert.deepEqual(readResult, artifact);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('integration / persistUiBriefArtifact writes ui-brief.json for agent flow', async () => {
  const repoRoot = makeTmpRepo();
  try {
    const taskId = 'T-UI-BRIEF-PERSIST';
    const persisted = await persistUiBriefArtifact(
      taskId,
      {
        featureDescription: 'Search results refinements',
        planArtifact: {
          screens: ['Search results'],
          interactions: ['Sort by relevance'],
          errorStates: ['No results found'],
          components: ['ResultsList', 'SortMenu'],
        },
      },
      { repoRoot },
    );

    const expectedPath = join(repoRoot, '.devmate', 'session', taskId, 'ui-brief.json');
    assert.equal(persisted.path, expectedPath);
    assert.equal(existsSync(expectedPath), true);

    const onDisk = JSON.parse(readFileSync(expectedPath, 'utf8'));
    assert.deepEqual(onDisk, persisted.artifact);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
