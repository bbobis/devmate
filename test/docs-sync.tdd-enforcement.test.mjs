// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} relPath
 * @returns {string}
 */
function readRepoFile(relPath) {
  const fullPath = join(REPO_ROOT, relPath);
  assert.ok(existsSync(fullPath), `Expected file to exist: ${relPath}`);
  return readFileSync(fullPath, 'utf8');
}

test('docs-sync/tdd-enforcement › buildDispatchPayload exported from correct path', () => {
  const source = readRepoFile('lib/workflow/build-dispatch-payload.mjs');
  assert.match(source, /export function buildDispatchPayload\(/);
});

test('docs-sync/tdd-enforcement › assertTddContract exported from correct path', () => {
  const source = readRepoFile('lib/workflow/tdd-contract.mjs');
  assert.match(source, /export function assertTddContract\(/);
});

test('docs-sync/tdd-enforcement › assertTestFileTouched exported from correct path', () => {
  const source = readRepoFile('hooks/post-tool-use.mjs');
  assert.match(source, /export function assertTestFileTouched\(/);
});

test('docs-sync/tdd-enforcement › orchestrator.agent.md references buildDispatchPayload', () => {
  const source = readRepoFile('agents/orchestrator.agent.md');
  assert.match(source, /buildDispatchPayload/);
});

test('docs-sync/tdd-enforcement › fullstack.agent.md contains Pre-flight section', () => {
  const source = readRepoFile('agents/fullstack.agent.md');
  assert.match(source, /^## Pre-flight/m);
});

test('docs-sync/tdd-enforcement › config schema includes verification key', () => {
  const source = readRepoFile('lib/config/devmate-config.mjs');
  assert.match(source, /verification/);
  // Legacy key still accepted (back-compat), and the load-bearing TDD-gate
  // command now resolves through the canonical resolver over verification.checks.
  assert.match(source, /verification\.unitTest/);
  assert.match(source, /resolveUnitTestCommand/);
});
