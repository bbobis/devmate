// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTechDesignArtifact,
  validateTechDesignArtifact,
} from '../lib/workflow/agents/tech-design.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';

/**
 * Execute a minimal feature-lane progression for tech-design gate assertions.
 * @param {Record<string, unknown>|undefined} discovery
 * @param {Record<string, unknown>|undefined} techDesign
 * @param {(name: string) => void} [onGateAdvance]
 * @returns {{ ok: boolean, error?: string }}
 */
function runFeatureLane(discovery, techDesign, onGateAdvance = () => {}) {
  const discoveryCheck = assertDispatchResult('discovery', discovery);
  if (!discoveryCheck.ok) return discoveryCheck;

  onGateAdvance('discovery-done');

  const techDesignCheck = assertDispatchResult('tech-design', techDesign);
  if (!techDesignCheck.ok) return techDesignCheck;

  onGateAdvance('plan-done');
  return { ok: true };
}

test('createTechDesignArtifact / returns typed sections and normalized unverified markers', () => {
  const artifact = createTechDesignArtifact({
    dataModel: { entity: 'Order' },
    apiContracts: [
      {
        name: 'CreateOrder',
        method: 'POST',
        path: '/api/orders',
        purpose: 'Create a new order',
      },
      {
        name: 'GetOrder',
        method: 'GET',
        path: '/api/orders/:id',
        purpose: 'Fetch order detail',
        confidence: 'low',
      },
    ],
    layerBoundaries: ['UI -> API via HTTP'],
    assumptions: ['legacy auth token still accepted'],
    risks: ['[UNVERIFIED] partial migration can break caching'],
  });

  assert.equal(Array.isArray(artifact.apiContracts), true);
  assert.equal(Array.isArray(artifact.layerBoundaries), true);
  assert.equal(Array.isArray(artifact.assumptions), true);
  assert.equal(Array.isArray(artifact.risks), true);
  assert.equal(Array.isArray(artifact.unverified), true);
  assert.equal(artifact.apiContracts[0]?.confidence, 'high');
  assert.equal(artifact.apiContracts[1]?.confidence, 'low');
  assert.equal(artifact.assumptions[0]?.startsWith('[UNVERIFIED]'), true);
  assert.equal(artifact.risks[0]?.startsWith('[UNVERIFIED]'), true);
  assert.equal(artifact.unverified.length, 2);
});

test('createTechDesignArtifact / provides default sections when omitted', () => {
  const artifact = createTechDesignArtifact({});

  assert.equal(typeof artifact.dataModel, 'object');
  assert.equal(Array.isArray(artifact.apiContracts), true);
  assert.equal(Array.isArray(artifact.layerBoundaries), true);
  assert.equal(Array.isArray(artifact.assumptions), true);
  assert.equal(Array.isArray(artifact.risks), true);
  assert.equal(Array.isArray(artifact.unverified), true);
  assert.equal(artifact.layerBoundaries.length, 0);
  assert.equal(artifact.apiContracts.length, 0);
});

test('validateTechDesignArtifact / accepts valid artifact', () => {
  const artifact = createTechDesignArtifact({
    dataModel: { aggregate: 'Order' },
    apiContracts: [
      {
        name: 'CreateOrder',
        method: 'POST',
        path: '/api/orders',
        purpose: 'Create order',
      },
    ],
    layerBoundaries: ['Domain does not access transport'],
    assumptions: ['auth middleware remains stable'],
    risks: ['backward compatibility needs migration plan'],
  });

  const verdict = validateTechDesignArtifact(artifact);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test('validateTechDesignArtifact / rejects malformed shapes and missing marker', () => {
  const verdict = validateTechDesignArtifact({
    dataModel: null,
    apiContracts: [{ name: 'X', method: '', path: '', purpose: 'p', confidence: 'medium' }],
    layerBoundaries: ['service -> repository'],
    assumptions: ['[UNVERIFIED] assumption ok'],
    risks: ['[UNVERIFIED] risk ok'],
    unverified: ['untagged'],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('apiContracts[0].method')), true);
  assert.equal(verdict.errors.some((e) => e.includes('apiContracts[0].path')), true);
  assert.equal(verdict.errors.some((e) => e.includes('confidence')), true);
  assert.equal(verdict.errors.some((e) => e.includes('unverified[0]')), true);
  assert.equal(verdict.errors.some((e) => e.includes('at least one of dataModel or apiContracts')), true);
});

test('integration / tech-design artifact satisfies orchestrator dispatch guard', () => {
  const payload = createTechDesignArtifact({
    apiContracts: [
      {
        name: 'CreateOrder',
        method: 'POST',
        path: '/api/orders',
        purpose: 'Create order',
      },
    ],
    assumptions: ['contract may need versioning'],
    risks: ['cache invalidation details unresolved'],
  });

  const dispatchVerdict = assertDispatchResult('tech-design', {
    status: 'ok',
    payload,
  });

  assert.equal(dispatchVerdict.ok, true);
});

test('integration / empty tech-design payload blocks progression to planning', () => {
  /** @type {string[]} */
  const gates = [];

  const verdict = runFeatureLane(
    {
      status: 'ok',
      payload: {
        claims: [{ fact: 'feature dispatch exists', path: 'docs/workflow.md#L75', confidence: 'high' }],
        unverified: ['[UNVERIFIED] none'],
      },
    },
    {},
    (gate) => gates.push(gate),
  );

  assert.equal(verdict.ok, false);
  const message = verdict.error ?? '';
  assert.equal(message.toLowerCase().includes('tech-design'), true);
  assert.deepEqual(gates, ['discovery-done']);
});
