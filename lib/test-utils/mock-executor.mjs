// @ts-check

import assert from 'node:assert/strict';

import { getOwn } from '../object-utils.mjs';

/**
 * @typedef {{ agent: string, args: unknown }} MockCall
 */

/**
 * @typedef {{
 *   invoke: (agent: string, args: unknown) => unknown,
 *   dispatch: (input: { agent: string, [key: string]: unknown }) => unknown,
 * }} MockExecutor
 */

/**
 * Creates a mock executor for E2E lane tests.
 * @param {{ agents: string[], stubResults: Record<string, unknown> }} config
 * @returns {{ executor: MockExecutor, getCallLog: () => Array<{ agent: string, args: unknown }> }}
 */
export function createMockExecutor(config) {
  const allowedAgents = new Set(config.agents);
  /** @type {MockCall[]} */
  const callLog = [];

  /**
   * @param {string} agent
   * @returns {unknown}
   */
  function readStub(agent) {
    if (!allowedAgents.has(agent)) {
      throw new Error(`mock-executor: agent '${agent}' not registered`);
    }

    if (!Object.hasOwn(config.stubResults, agent)) {
      throw new Error(`mock-executor: no stub result for agent '${agent}'`);
    }

    return getOwn(config.stubResults, agent);
  }

  /**
   * @param {string} agent
   * @param {unknown} args
   * @returns {unknown}
   */
  function invoke(agent, args) {
    callLog.push({ agent, args });
    return readStub(agent);
  }

  /**
   * @param {{ agent: string, [key: string]: unknown }} input
   * @returns {unknown}
   */
  function dispatch(input) {
    const { agent } = input;
    callLog.push({ agent, args: input });
    return readStub(agent);
  }

  return {
    executor: { invoke, dispatch },
    getCallLog: () => [...callLog],
  };
}

/**
 * Asserts agents were called in the expected order.
 * @param {Array<{ agent: string }>} callLog
 * @param {string[]} expectedOrder
 * @returns {void}
 */
export function assertCallOrder(callLog, expectedOrder) {
  const actual = callLog.map((entry) => entry.agent);
  assert.ok(
    actual.length >= expectedOrder.length,
    `expected at least ${expectedOrder.length} calls, got ${actual.length}`,
  );

  for (let i = 0; i < expectedOrder.length; i += 1) {
    assert.equal(
      actual[i],
      expectedOrder[i],
      `expected call ${i + 1} to be '${expectedOrder[i]}', got '${actual[i] ?? 'none'}'`,
    );
  }
}

/**
 * Asserts no calls were made to forbidden agents.
 * @param {Array<{ agent: string }>} callLog
 * @param {string[]} forbiddenAgents
 * @returns {void}
 */
export function assertNoCalls(callLog, forbiddenAgents) {
  const forbidden = new Set(forbiddenAgents);
  const matches = callLog.filter((entry) => forbidden.has(entry.agent));
  assert.equal(
    matches.length,
    0,
    `expected no calls to [${forbiddenAgents.join(', ')}], got [${matches.map((m) => m.agent).join(', ')}]`,
  );
}
