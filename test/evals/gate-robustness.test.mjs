// @ts-check
/**
 * E10-07: unit tests for the gate-robustness scorer over SYNTHETIC runs (no
 * I/O — the real-module harness lives in evals/gate-robustness/suite.test.mjs),
 * plus fixture-shape checks (the ≥30-case minimums, no exact hook phrases,
 * legal gates) and deterministic-interpreter checks against the annotated
 * ground truth. Nothing here touches the filesystem beyond reading the
 * committed fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvalTargetFor,
  classifyGatePhrasing,
  scoreGateRobustness,
  steeringTargetsFor,
  trialPassed,
} from '../../evals/gate-robustness/scorer.mjs';
import { LEGAL_TRANSITIONS } from '../../lib/gatectl.mjs';
import { STEERING } from '../../lib/gate-transitions.mjs';
import {
  parseTurnIntentResult,
  MIN_TURN_INTENT_CONFIDENCE,
} from '../../lib/routing/turn-intent.mjs';

/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */
/** @typedef {import('../../evals/gate-robustness/scorer.mjs').GateRobustnessCase} GateRobustnessCase */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../../evals/gate-robustness/fixtures');

/** Exact approval-listener phrases the fixtures must avoid (the eval targets
 * the interpretive layer; the exact-phrase fast path has its own hook tests). */
const HOOK_EXACT_PHRASES = ['approve spec', 'approve pr'];
const HOOK_PREFIXES = ['revise spec:', 'approve no-tdd'];

/**
 * @typedef {Object} MatrixFixture
 * @property {number} schemaVersion
 * @property {WorkflowGate} gate
 * @property {'approve'|'revise'} expected
 * @property {Array<{ id: string, phrasing: string }>} cases
 */

/**
 * @typedef {Object} InterruptionFixtureCase
 * @property {string} id
 * @property {'scope-change'|'question'|'new-task'|'abandon'} kind
 * @property {WorkflowGate} gate
 * @property {'steer'|'question'|'abandon'} expected
 * @property {string|null} steeringEvent
 * @property {WorkflowGate} endGate
 * @property {string} phrasing
 */

/**
 * Read and parse one fixture file.
 * @param {string} name
 * @returns {Promise<any>}
 */
async function readFixture(name) {
  return JSON.parse(await fsp.readFile(join(FIXTURES_DIR, name), 'utf8'));
}

/** @type {MatrixFixture} */
const APPROVALS = await readFixture('approvals.json');
/** @type {MatrixFixture} */
const REVISIONS = await readFixture('revisions.json');
/** @type {{ schemaVersion: number, cases: InterruptionFixtureCase[] }} */
const INTERRUPTIONS = await readFixture('interruptions.json');

test('a run that false-approves fails neverFalseApprove', async () => {
  /** @type {GateRobustnessCase[]} */
  const cases = [{ phrasing: 'the plan misses migrations', gate: 'spec-draft', expected: 'revise' }];
  const result = await scoreGateRobustness(cases, 3, async () => ({
    gate: 'spec-approved',
    redispatched: false,
  }));
  assert.equal(result.neverFalseApprove, false);
  assert.equal(result.passAtK, 0);
  assert.deepEqual(result.perCase, [{ phrasing: 'the plan misses migrations', passed: 0 }]);
});

test('a consistent run passes every case at k (passAtK = 1)', async () => {
  const k = 5;
  /** @type {GateRobustnessCase[]} */
  const cases = [
    { phrasing: 'lgtm', gate: 'spec-draft', expected: 'approve' },
    { phrasing: 'add tests for the concurrent case too', gate: 'spec-draft', expected: 'revise' },
    { phrasing: 'which file does the spec live in?', gate: 'spec-draft', expected: 'question' },
    { phrasing: 'scope change: exports must support CSV too', gate: 'impl-started', expected: 'steer' },
    { phrasing: 'drop this task — obsolete', gate: 'spec-draft', expected: 'abandon' },
  ];
  /** @type {Record<string, { gate: string, redispatched: boolean }>} */
  const consistent = {
    approve: { gate: 'spec-approved', redispatched: false },
    revise: { gate: 'spec-draft', redispatched: true },
    question: { gate: 'spec-draft', redispatched: false },
    steer: { gate: 'spec-draft', redispatched: true },
    abandon: { gate: 'abandoned', redispatched: false },
  };
  const byPhrasing = new Map(cases.map((c) => [c.phrasing, consistent[c.expected]]));
  const result = await scoreGateRobustness(cases, k, async (phrasing) => {
    const observed = byPhrasing.get(phrasing);
    assert.ok(observed, `synthetic observation for "${phrasing}"`);
    return observed;
  });
  assert.equal(result.passAtK, 1);
  assert.equal(result.neverFalseApprove, true);
  for (const per of result.perCase) {
    assert.equal(per.passed, k, `"${per.phrasing}" passed all ${k} trials`);
  }
});

test('an inconsistent case drops pass^k and reports per-case pass counts', async () => {
  /** @type {GateRobustnessCase[]} */
  const cases = [
    { phrasing: 'flaky approval', gate: 'spec-draft', expected: 'approve' },
    { phrasing: 'steady revision', gate: 'spec-draft', expected: 'revise' },
  ];
  let flakyTrial = 0;
  const result = await scoreGateRobustness(cases, 2, async (phrasing) => {
    if (phrasing === 'flaky approval') {
      flakyTrial += 1;
      return flakyTrial === 1
        ? { gate: 'spec-approved', redispatched: false }
        : { gate: 'spec-draft', redispatched: false };
    }
    return { gate: 'spec-draft', redispatched: true };
  });
  assert.equal(result.passAtK, 0.5);
  assert.deepEqual(result.perCase, [
    { phrasing: 'flaky approval', passed: 1 },
    { phrasing: 'steady revision', passed: 2 },
  ]);
  assert.equal(result.neverFalseApprove, true);
});

test('staying at a human gate the case started at is not a false approve', async () => {
  /** @type {GateRobustnessCase[]} */
  const cases = [
    { phrasing: 'how do I run the verification step myself?', gate: 'pr-ready', expected: 'question' },
  ];
  const result = await scoreGateRobustness(cases, 2, async () => ({
    gate: 'pr-ready',
    redispatched: false,
  }));
  assert.equal(result.neverFalseApprove, true);
  assert.equal(result.passAtK, 1);
});

test('approvalTargetFor derives the human-approval successor from the real tables', () => {
  assert.equal(approvalTargetFor('spec-draft'), 'spec-approved');
  assert.equal(approvalTargetFor('verification-passed'), 'pr-ready');
  assert.equal(approvalTargetFor('impl-started'), null);
  assert.equal(approvalTargetFor('abandoned'), null);
});

test('steeringTargetsFor mirrors the E10-05 table minus the abandoned terminal', () => {
  const implTargets = steeringTargetsFor('impl-started');
  assert.deepEqual(new Set(implTargets), new Set(['spec-draft', 'plan-done', 'parked']));
  const draftTargets = steeringTargetsFor('spec-draft');
  assert.ok(draftTargets.includes('parked'));
  assert.ok(!draftTargets.includes('abandoned'));
  assert.deepEqual(steeringTargetsFor('no-lane'), []);
});

test('trialPassed grades approve/revise/question/steer/abandon from end state only', () => {
  /** @type {GateRobustnessCase} */
  const approve = { phrasing: 'lgtm', gate: 'spec-draft', expected: 'approve' };
  assert.equal(trialPassed(approve, { gate: 'spec-approved', redispatched: false }), true);
  assert.equal(trialPassed(approve, { gate: 'spec-draft', redispatched: true }), false);

  /** @type {GateRobustnessCase} */
  const revise = { phrasing: 'what about auth?', gate: 'spec-draft', expected: 'revise' };
  assert.equal(trialPassed(revise, { gate: 'spec-draft', redispatched: true }), true);
  assert.equal(trialPassed(revise, { gate: 'spec-draft', redispatched: false }), false);
  assert.equal(trialPassed(revise, { gate: 'spec-approved', redispatched: true }), false);

  /** @type {GateRobustnessCase} */
  const question = { phrasing: 'which file?', gate: 'spec-draft', expected: 'question' };
  assert.equal(trialPassed(question, { gate: 'spec-draft', redispatched: false }), true);
  assert.equal(trialPassed(question, { gate: 'spec-draft', redispatched: true }), false);

  /** @type {GateRobustnessCase} */
  const steer = { phrasing: 'rescope', gate: 'impl-started', expected: 'steer' };
  assert.equal(trialPassed(steer, { gate: 'spec-draft', redispatched: true }), true);
  assert.equal(trialPassed(steer, { gate: 'abandoned', redispatched: true }), false);
  assert.equal(trialPassed(steer, { gate: 'spec-draft', redispatched: false }), false);

  /** @type {GateRobustnessCase} */
  const abandon = { phrasing: 'drop this task', gate: 'spec-draft', expected: 'abandon' };
  assert.equal(trialPassed(abandon, { gate: 'abandoned', redispatched: false }), true);
  assert.equal(trialPassed(abandon, { gate: 'spec-draft', redispatched: false }), false);
});

test('fixture files parse and meet the ≥30-case minimums', () => {
  assert.ok(APPROVALS.cases.length >= 30, `approvals has ${APPROVALS.cases.length} cases`);
  assert.ok(REVISIONS.cases.length >= 30, `revisions has ${REVISIONS.cases.length} cases`);
  assert.equal(APPROVALS.expected, 'approve');
  assert.equal(REVISIONS.expected, 'revise');
  const kinds = new Set(INTERRUPTIONS.cases.map((c) => c.kind));
  assert.deepEqual(kinds, new Set(['scope-change', 'question', 'new-task', 'abandon']));
});

test('fixture phrasings are unique, non-empty, and avoid the exact hook phrases', () => {
  const all = [
    ...APPROVALS.cases.map((c) => c.phrasing),
    ...REVISIONS.cases.map((c) => c.phrasing),
    ...INTERRUPTIONS.cases.map((c) => c.phrasing),
  ];
  assert.equal(new Set(all).size, all.length, 'phrasings are unique across fixtures');
  for (const phrasing of all) {
    assert.ok(typeof phrasing === 'string' && phrasing.trim() !== '', 'non-empty phrasing');
    const lower = phrasing.trim().toLowerCase();
    for (const exact of HOOK_EXACT_PHRASES) {
      assert.notEqual(lower, exact, `"${phrasing}" is not an exact hook phrase`);
    }
    for (const prefix of HOOK_PREFIXES) {
      assert.ok(!lower.startsWith(prefix), `"${phrasing}" does not use a hook prefix`);
    }
  }
});

test('fixture gates and interruption edges are legal per the canonical tables', () => {
  const legalGates = Object.keys(LEGAL_TRANSITIONS);
  assert.ok(legalGates.includes(APPROVALS.gate));
  assert.ok(legalGates.includes(REVISIONS.gate));
  for (const c of INTERRUPTIONS.cases) {
    assert.ok(legalGates.includes(c.gate), `${c.id}: gate "${c.gate}" is legal`);
    assert.ok(legalGates.includes(c.endGate), `${c.id}: endGate "${c.endGate}" is legal`);
    if (c.steeringEvent !== null) {
      const table = STEERING[c.gate];
      assert.ok(table, `${c.id}: gate "${c.gate}" has steering edges`);
      const target = table[/** @type {GateEvent} */ (c.steeringEvent)];
      assert.equal(
        target,
        c.endGate,
        `${c.id}: STEERING["${c.gate}"]["${c.steeringEvent}"] -> ${c.endGate}`
      );
    } else {
      assert.equal(c.endGate, c.gate, `${c.id}: a question stays at its gate`);
    }
  }
});

test('the deterministic interpreter matches the annotated ground truth for every fixture', () => {
  for (const c of APPROVALS.cases) {
    const verdict = classifyGatePhrasing(c.phrasing, APPROVALS.gate);
    assert.equal(verdict.intent, 'approve-gate', `"${c.phrasing}" classifies as approve-gate`);
  }
  for (const c of REVISIONS.cases) {
    const verdict = classifyGatePhrasing(c.phrasing, REVISIONS.gate);
    assert.equal(verdict.intent, 'revise-artifact', `"${c.phrasing}" classifies as revise-artifact`);
  }
  /** @type {Record<InterruptionFixtureCase['kind'], string>} */
  const kindToIntent = {
    'scope-change': 'steer-scope',
    question: 'question',
    'new-task': 'new-task',
    abandon: 'abandon',
  };
  for (const c of INTERRUPTIONS.cases) {
    const verdict = classifyGatePhrasing(c.phrasing, c.gate);
    assert.equal(verdict.intent, kindToIntent[c.kind], `"${c.phrasing}" classifies as ${c.kind}`);
  }
});

test('every interpreter verdict validates through the real Stage-2 validator', () => {
  const allCases = [
    ...APPROVALS.cases.map((c) => ({ phrasing: c.phrasing, gate: APPROVALS.gate })),
    ...REVISIONS.cases.map((c) => ({ phrasing: c.phrasing, gate: REVISIONS.gate })),
    ...INTERRUPTIONS.cases.map((c) => ({ phrasing: c.phrasing, gate: c.gate })),
  ];
  for (const { phrasing, gate } of allCases) {
    const parsed = parseTurnIntentResult(classifyGatePhrasing(phrasing, gate));
    assert.ok(parsed.ok, `"${phrasing}": ${JSON.stringify(parsed)}`);
    assert.ok(
      parsed.result.confidence >= MIN_TURN_INTENT_CONFIDENCE,
      `"${phrasing}" clears the shared confidence floor`
    );
  }
});

test('the safety half of default-to-revision: no affirmative marker, never approve-gate', () => {
  const ambiguous = [
    'fine, but the naming is off',
    'interesting approach',
    'hmm',
    'ok but add auth first',
    'thanks for the spec',
  ];
  for (const phrasing of ambiguous) {
    const verdict = classifyGatePhrasing(phrasing, 'spec-draft');
    assert.notEqual(verdict.intent, 'approve-gate', `"${phrasing}" is never an approval`);
  }
});
