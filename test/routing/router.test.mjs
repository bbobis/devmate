// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRouterResult, classifyLane } from '../../lib/routing/router.mjs';

test('parseRouterResult - valid feature result returns ok:true', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 0.95,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.lane, 'feature');
    assert.equal(result.result.budgetClass, 'standard');
    assert.equal(result.result.confidence, 0.95);
  }
});

test('parseRouterResult - valid bug result with tiny budget returns ok:true', () => {
  const result = parseRouterResult({
    lane: 'bug',
    budgetClass: 'tiny',
    confidence: 0.85,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.lane, 'bug');
    assert.equal(result.result.budgetClass, 'tiny');
  }
});

test('parseRouterResult - valid chore result with large budget returns ok:true', () => {
  const result = parseRouterResult({
    lane: 'chore',
    budgetClass: 'large',
    confidence: 0.72,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.lane, 'chore');
    assert.equal(result.result.budgetClass, 'large');
  }
});

test('parseRouterResult - invalid lane returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'hotfix',
    budgetClass: 'standard',
    confidence: 0.9,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('lane'));
});

test('parseRouterResult - missing lane returns ok:false', () => {
  const result = parseRouterResult({
    budgetClass: 'standard',
    confidence: 0.9,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('lane'));
});

test('parseRouterResult - invalid budgetClass returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'enormous',
    confidence: 0.9,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('budgetClass'));
});

test('parseRouterResult - missing budgetClass returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    confidence: 0.9,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('budgetClass'));
});

test('parseRouterResult - confidence out of range (>1) returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 1.5,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('confidence'));
});

test('parseRouterResult - confidence out of range (<0) returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: -0.1,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('confidence'));
});

test('parseRouterResult - non-finite confidence returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: Infinity,
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('confidence'));
});

test('parseRouterResult - confidence as string returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 'high',
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('confidence'));
});

test('parseRouterResult - missing confidence returns ok:false', () => {
  const result = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
  });
  assert.equal(result.ok, false);
  assert(result.error?.includes('confidence'));
});

test('parseRouterResult - null input returns ok:false', () => {
  const result = parseRouterResult(null);
  assert.equal(result.ok, false);
  assert(result.error?.includes('object'));
});

test('parseRouterResult - array input returns ok:false', () => {
  const result = parseRouterResult(['feature', 'standard', 0.9]);
  assert.equal(result.ok, false);
  assert(result.error?.includes('object'));
});

test('parseRouterResult - string input returns ok:false', () => {
  const result = parseRouterResult('feature');
  assert.equal(result.ok, false);
  assert(result.error?.includes('object'));
});

test('classifyLane - no dispatch provided returns ok:false', async () => {
  const result = await classifyLane('add dark mode');
  assert.equal(result.ok, false);
  assert(result.error?.includes('dispatch'));
});

test('classifyLane - dispatch returns valid result', async () => {
  const mockDispatch = /** @type {(agent: string, input: unknown) => Promise<unknown>} */ (async (_agent, _input) => ({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 0.95,
  }));
  
  const result = await classifyLane('add dark mode', { dispatch: mockDispatch });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.lane, 'feature');
    assert.equal(result.result.confidence, 0.95);
  }
});

test('classifyLane - dispatch returns malformed result', async () => {
  const mockDispatch = /** @type {(agent: string, input: unknown) => Promise<unknown>} */ (async (_agent, _input) => ({
    lane: 'unknown',
    budgetClass: 'huge',
  }));
  
  const result = await classifyLane('add dark mode', { dispatch: mockDispatch });
  assert.equal(result.ok, false);
  assert(result.error !== undefined);
});

test('classifyLane - dispatch throws error', async () => {
  const mockDispatch = /** @type {(agent: string, input: unknown) => Promise<unknown>} */ (async (_agent, _input) => {
    throw new Error('Network error');
  });
  
  const result = await classifyLane('add dark mode', { dispatch: mockDispatch });
  assert.equal(result.ok, false);
  assert(result.error?.includes('dispatch failed'));
});

test('classifyLane - dispatch returns null', async () => {
  const mockDispatch = /** @type {(agent: string, input: unknown) => Promise<unknown>} */ (async (_agent, _input) => null);
  
  const result = await classifyLane('add dark mode', { dispatch: mockDispatch });
  assert.equal(result.ok, false);
  assert(result.error !== undefined);
});

test('classifyLane - dispatch returns empty object', async () => {
  const mockDispatch = /** @type {(agent: string, input: unknown) => Promise<unknown>} */ (async (_agent, _input) => ({}));
  
  const result = await classifyLane('add dark mode', { dispatch: mockDispatch });
  assert.equal(result.ok, false);
  assert(result.error !== undefined);
});

test('parseRouterResult - confidence at boundary values (0 and 1)', () => {
  const resultZero = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 0,
  });
  assert.equal(resultZero.ok, true);

  const resultOne = parseRouterResult({
    lane: 'feature',
    budgetClass: 'standard',
    confidence: 1,
  });
  assert.equal(resultOne.ok, true);
});

test('parseRouterResult - low confidence edge case (0.74)', () => {
  const result = parseRouterResult({
    lane: 'bug',
    budgetClass: 'tiny',
    confidence: 0.74,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.confidence, 0.74);
  }
});
