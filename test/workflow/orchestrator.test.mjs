// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLane, PERSONA_MAP, assertDispatchResult } from '../../lib/workflow/orchestrator.mjs';

test('normalizeLane - lowercase string', () => {
  const result = normalizeLane('FEATURE');
  assert.equal(result, 'feature');
});

test('normalizeLane - already lowercase string', () => {
  const result = normalizeLane('bug');
  assert.equal(result, 'bug');
});

test('normalizeLane - mixed case with whitespace', () => {
  const result = normalizeLane('  ChOrE  ');
  assert.equal(result, 'chore');
});

test('normalizeLane - undefined returns empty string', () => {
  const result = normalizeLane(undefined);
  assert.equal(result, '');
});

test('normalizeLane - null returns empty string', () => {
  const result = normalizeLane(null);
  assert.equal(result, '');
});

test('normalizeLane - number returns empty string', () => {
  const result = normalizeLane(123);
  assert.equal(result, '');
});

test('normalizeLane - object returns empty string', () => {
  const result = normalizeLane({ lane: 'feature' });
  assert.equal(result, '');
});

test('normalizeLane - array returns empty string', () => {
  const result = normalizeLane(['feature']);
  assert.equal(result, '');
});

test('normalizeLane - empty string returns empty string', () => {
  const result = normalizeLane('');
  assert.equal(result, '');
});

test('normalizeLane - whitespace-only string returns empty string', () => {
  const result = normalizeLane('   ');
  assert.equal(result, '');
});

test('PERSONA_MAP - frontend resolves to fullstack', () => {
  assert.equal(PERSONA_MAP.frontend, 'fullstack');
});

test('PERSONA_MAP - backend resolves to fullstack', () => {
  assert.equal(PERSONA_MAP.backend, 'fullstack');
});

test('PERSONA_MAP - editor resolves to fullstack', () => {
  assert.equal(PERSONA_MAP.editor, 'fullstack');
});

test('assertDispatchResult - frontend persona with valid frontend agentName in result', () => {
  const result = {
    status: 'ok',
    agentName: 'frontend',
    payload: { changedFiles: ['src/App.tsx'] },
  };
  const assertion = assertDispatchResult('frontend', result);
  assert.equal(assertion.ok, true);
});

test('assertDispatchResult - frontend persona with canonical fullstack agentName in result', () => {
  // The real @fullstack agent returns agentName: 'fullstack', but we dispatched it as 'frontend'.
  // Both the dispatched name and the resolved canonical name must be accepted.
  const result = {
    status: 'ok',
    agentName: 'fullstack',
    payload: { changedFiles: ['src/App.tsx'] },
  };
  const assertion = assertDispatchResult('frontend', result);
  assert.equal(assertion.ok, true, 'canonical agentName fullstack must be accepted when dispatched as frontend');
});

test('assertDispatchResult - backend persona with canonical fullstack agentName in result', () => {
  const result = {
    status: 'ok',
    agentName: 'fullstack',
    payload: { verification: 'passed', summary: 'Backend updated' },
  };
  const assertion = assertDispatchResult('backend', result);
  assert.equal(assertion.ok, true, 'canonical agentName fullstack must be accepted when dispatched as backend');
});

test('assertDispatchResult - editor persona with canonical fullstack agentName in result', () => {
  const result = {
    status: 'ok',
    agentName: 'fullstack',
    payload: { summary: 'Chore completed' },
  };
  const assertion = assertDispatchResult('editor', result);
  assert.equal(assertion.ok, true, 'canonical agentName fullstack must be accepted when dispatched as editor');
});

test('assertDispatchResult - backend persona with valid backend agentName in result', () => {
  const result = {
    status: 'ok',
    agentName: 'backend',
    payload: { verification: 'passed', summary: 'Backend updated' },
  };
  const assertion = assertDispatchResult('backend', result);
  assert.equal(assertion.ok, true);
});

test('assertDispatchResult - editor persona with valid editor agentName in result', () => {
  const result = {
    status: 'ok',
    agentName: 'editor',
    payload: { summary: 'Chore completed' },
  };
  const assertion = assertDispatchResult('editor', result);
  assert.equal(assertion.ok, true);
});

test('assertDispatchResult - unrelated agentName in result is rejected', () => {
  // dispatched 'frontend' but result came back as 'diagnose' — clear mismatch
  const result = {
    status: 'ok',
    agentName: 'diagnose',
    payload: { changedFiles: ['src/App.tsx'] },
  };
  const assertion = assertDispatchResult('frontend', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.includes('does not match'));
});

test('assertDispatchResult - unknown agent rejects persona resolution', () => {
  const result = {
    status: 'ok',
    agentName: 'unknown',
    payload: { someData: true },
  };
  const assertion = assertDispatchResult('unknown', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.includes('no validator registered'));
});

// #353: @router is validated against its own { lane, budgetClass, confidence }
// contract (no status/payload wrapper) rather than the generic dispatch guard,
// which previously halted every lane's Step 0 with "no validator registered for
// agent".
test('assertDispatchResult - router with valid RouterResult passes', () => {
  const result = {
    agentName: 'router',
    lane: 'bug',
    budgetClass: 'standard',
    confidence: 0.92,
  };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, true);
});

test('assertDispatchResult - router accepts a valid result even without a status field', () => {
  // The router contract has no status; the generic guard would reject this at
  // the status check before ever reaching the validator.
  const result = { lane: 'feature', budgetClass: 'large', confidence: 0.99 };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, true);
});

test('assertDispatchResult - router with invalid lane is rejected by its own validator', () => {
  const result = {
    agentName: 'router',
    lane: 'hotfix',
    budgetClass: 'standard',
    confidence: 0.9,
  };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.startsWith('router:'));
  assert(assertion.error?.includes('lane'));
  assert(!assertion.error?.includes('no validator registered'));
});

test('assertDispatchResult - router missing budgetClass is rejected', () => {
  const result = { lane: 'bug', confidence: 0.9 };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.includes('budgetClass'));
  assert(!assertion.error?.includes('no validator registered'));
});

test('assertDispatchResult - router with out-of-range confidence is rejected', () => {
  const result = { lane: 'bug', budgetClass: 'standard', confidence: 1.5 };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.includes('confidence'));
  assert(!assertion.error?.includes('no validator registered'));
});

test('assertDispatchResult - router with non-number confidence is rejected', () => {
  const result = { lane: 'bug', budgetClass: 'standard', confidence: 'high' };
  const assertion = assertDispatchResult('router', result);
  assert.equal(assertion.ok, false);
  assert(assertion.error?.includes('confidence'));
  assert(!assertion.error?.includes('no validator registered'));
});

test('assertDispatchResult - router with empty result object is rejected without generic message', () => {
  const assertion = assertDispatchResult('router', {});
  assert.equal(assertion.ok, false);
  assert(!assertion.error?.includes('no validator registered'));
});

test('assertDispatchResult - router with null result is rejected', () => {
  const assertion = assertDispatchResult('router', null);
  assert.equal(assertion.ok, false);
  assert(!assertion.error?.includes('no validator registered'));
});
