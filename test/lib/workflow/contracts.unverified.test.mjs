// @ts-check
/**
 * E9-17: [UNVERIFIED]-prefix enforcement in the WIRED validators — the ones
 * the PostToolUse hook and check-contracts actually import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGrillResult, validateCritiqueResult } from '../../../lib/workflow/contracts.mjs';
import { CONTRACT_ROUTES } from '../../../hooks/contract-validator.mjs';
import { main as checkContractsMain } from '../../../scripts/check-contracts.mjs';

/** @returns {Record<string, unknown>} */
function makeGrill() {
  return {
    taskId: 't-unv',
    mode: 'grill',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    assumptions: ['a'],
    missingRequirements: [],
    edgeCases: [],
    cornerCases: [],
    securityRisks: [],
    uxRisks: [],
    blockingQuestions: [],
    recommendedDecisions: [],
    unverifiedItems: ['[UNVERIFIED] setting X may not exist'],
  };
}

/** @returns {Record<string, unknown>} */
function makeCritique() {
  return {
    taskId: 't-unv',
    mode: 'critique',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    missingAcceptanceCriteria: [],
    missingTests: [],
    riskySequencing: [],
    unlistedFiles: [],
    backwardsCompatRisks: [],
    rollbackRisk: 'low',
    verdict: 'APPROVE_PLAN',
  };
}

test('validateGrillResult rejects unprefixed unverified item', () => {
  const g = makeGrill();
  g.unverifiedItems = ['this claim has no prefix'];
  const result = validateGrillResult(g);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('[UNVERIFIED]')));
});

test('accepts prefixed', () => {
  const result = validateGrillResult(makeGrill());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('missing unverifiedItems array is rejected', () => {
  const g = makeGrill();
  delete g.unverifiedItems;
  assert.equal(validateGrillResult(g).ok, false);
});

test('validateCritiqueResult rejects invalid verdict', () => {
  const c = makeCritique();
  c.verdict = 'LOOKS_FINE';
  const result = validateCritiqueResult(c);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('APPROVE_PLAN')));
  // REQUEST_REVISION with a reason is accepted.
  const rev = makeCritique();
  rev.verdict = 'REQUEST_REVISION: missing tests for AC2';
  assert.equal(validateCritiqueResult(rev).ok, true);
});

test('hook path rejects unprefixed artifact', () => {
  // The PostToolUse hook routes grill-result.json to this exact validator.
  const route = CONTRACT_ROUTES['.devmate/state/grill-result.json'];
  assert.ok(route, 'grill route registered');
  const g = makeGrill();
  g.unverifiedItems = ['no prefix here'];
  const result = route.validator(g);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('[UNVERIFIED]')));
});

test('check-contracts rejects unprefixed artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-unv-'));
  await mkdir(join(root, '.devmate', 'state'), { recursive: true });
  const bad = makeGrill();
  bad.unverifiedItems = ['no prefix here'];
  await writeFile(join(root, '.devmate', 'state', 'grill-result.json'), JSON.stringify(bad), 'utf8');

  const prevCwd = process.cwd();
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  /** @type {string[]} */
  const captured = [];
  process.stderr.write = /** @type {typeof process.stderr.write} */ ((c) => {
    captured.push(String(c));
    return true;
  });
  process.stdout.write = /** @type {typeof process.stdout.write} */ ((c) => {
    captured.push(String(c));
    return true;
  });
  let code;
  try {
    process.chdir(root);
    code = await checkContractsMain([]);
  } finally {
    process.chdir(prevCwd);
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }
  assert.equal(code, 1, 'CI check fails on the unprefixed artifact');
  assert.ok(captured.join('').includes('[UNVERIFIED]'), 'violation names the prefix rule');
});
