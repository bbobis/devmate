// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDiscoveryArtifact,
  validateDiscoveryArtifact,
} from '../lib/workflow/agents/discovery.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';

test('createDiscoveryArtifact / returns structured claims with confidence markers', () => {
  const artifact = createDiscoveryArtifact(
    [
      'Feature lane step 2 dispatches discovery | agents/orchestrator.agent.md#L162 | high',
      'Evidence pointer pattern exists | docs/PATTERNS.md#L57 | low',
    ],
    ['legacy assumption from prompt only'],
  );

  assert.equal(Array.isArray(artifact.claims), true);
  assert.equal(Array.isArray(artifact.unverified), true);
  assert.equal(artifact.claims.length, 2);
  assert.deepEqual(artifact.claims[0], {
    fact: 'Feature lane step 2 dispatches discovery',
    path: 'agents/orchestrator.agent.md#L162',
    confidence: 'high',
  });
  assert.equal(artifact.unverified[0].startsWith('[UNVERIFIED]'), true);
});

test('createDiscoveryArtifact / missing evidence path becomes unverified item', () => {
  const artifact = createDiscoveryArtifact(
    ['Discovery agent exists without evidence delimiter'],
    [],
  );

  assert.equal(artifact.claims.length, 0);
  assert.equal(artifact.unverified.length, 1);
  assert.equal(artifact.unverified[0].startsWith('[UNVERIFIED]'), true);
  assert.equal(artifact.unverified[0].includes('missing evidence path'), true);
});

test('validateDiscoveryArtifact / accepts a valid artifact', () => {
  const artifact = createDiscoveryArtifact(
    ['Dispatch guard defines discovery contract | lib/workflow/orchestrator.mjs#L54 | high'],
    ['manual follow-up needed'],
  );

  const verdict = validateDiscoveryArtifact(artifact);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test('validateDiscoveryArtifact / rejects malformed claims and unverified entries', () => {
  const verdict = validateDiscoveryArtifact({
    claims: [{ fact: '', path: '', confidence: 'certain' }],
    unverified: ['not tagged'],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('claims[0].fact')), true);
  assert.equal(verdict.errors.some((e) => e.includes('claims[0].path')), true);
  assert.equal(verdict.errors.some((e) => e.includes('confidence')), true);
  assert.equal(verdict.errors.some((e) => e.includes('unverified[0]')), true);
});

test('integration / discovery artifact satisfies orchestrator dispatch guard', () => {
  const payload = createDiscoveryArtifact(
    ['Discovery role is documented | docs/AGENTS.md#L229 | high'],
    [],
  );

  const dispatchVerdict = assertDispatchResult('discovery', {
    status: 'ok',
    payload,
  });

  assert.equal(dispatchVerdict.ok, true);
});

test('integration / malformed discovery payload fails orchestrator guard', () => {
  const dispatchVerdict = assertDispatchResult('discovery', {
    status: 'ok',
    payload: { evidencePointers: ['docs/AGENTS.md'] },
  });

  assert.equal(dispatchVerdict.ok, false);
  const message = dispatchVerdict.error ?? '';
  assert.equal(message.includes('discovery'), true);
  assert.equal(message.includes('claims/unverified'), true);
});
