// @ts-check
/**
 * E9-08: evaluateGuard denies non-cleanup source edits while the
 * budget-critical marker is present and keeps reads/cleanup allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGuard } from '../../lib/gate-guard-core.mjs';

/** @typedef {import('../../lib/types.mjs').BudgetCriticalMarker} BudgetCriticalMarker */

/** @type {BudgetCriticalMarker} */
const MARKER = {
  at: '2026-07-03T00:00:00.000Z',
  field: 'session-total',
  current: 5000,
  limit: 4000,
};

const STATE = /** @type {any} */ ({
  taskId: 't-bc',
  lane: 'feature',
  workflowGate: 'impl-started',
  currentStep: 0,
  artifactHashes: {},
  preImplStash: null,
  budget: 10,
  schemaVersion: 1,
});

const CONFIG_OK = /** @type {any} */ ({ ok: true, config: { schemaVersion: 1, personas: [] } });

/**
 * #92: at impl-started the guard now requires the lane's edit boundary (Rule 6,
 * fail-closed), so every fixture that expects an ALLOW must carry the contract
 * it is editing under. Wide enough to cover both the cleanup path and the test
 * file below — the boundary under test here is the budget marker, not scope.
 */
const SCOPE = /** @type {any} */ ({
  lane: 'feature',
  allowedPaths: [],
  allowedGlobs: ['.devmate/**', '**/*.test.mjs'],
});

test('evaluateGuard denies source edit while marker present', () => {
  const decision = evaluateGuard(
    /** @type {any} */ ({ tool_name: 'write_file', path: 'lib/app.mjs' }),
    STATE,
    CONFIG_OK,
    { budgetCritical: MARKER }
  );
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /CRITICAL/i);
  assert.match(decision.reason ?? '', /compact/i, 'actionable: names compaction');
});

test('evaluateGuard allows reads while marker present', () => {
  const decision = evaluateGuard(
    /** @type {any} */ ({ tool_name: 'read_file', path: 'lib/app.mjs' }),
    STATE,
    CONFIG_OK,
    { budgetCritical: MARKER }
  );
  assert.equal(decision.decision, 'allow');
});

test('evaluateGuard allows cleanup writes into .devmate while marker present', () => {
  // #93: the cleanup path may not run through `.devmate/state/**` any more —
  // that is the gate's own storage, and Rule 4 now denies every agent write to
  // it. Nothing is lost: compaction artifacts are written by the PreCompact HOOK
  // (scripts/compact-session.mjs), which is not a tool call and never meets this
  // guard. The rule under test is the budget marker's cleanup exemption, so this
  // fixture exercises it on a `.devmate/` path that is not a session artifact.
  const decision = evaluateGuard(
    /** @type {any} */ ({ tool_name: 'write_file', path: '.devmate/memory/tasks/t-bc.jsonl' }),
    STATE,
    CONFIG_OK,
    { budgetCritical: MARKER, scope: SCOPE }
  );
  assert.equal(decision.decision, 'allow');
});

test('evaluateGuard denies a session-artifact write even on the cleanup path', () => {
  const decision = evaluateGuard(
    /** @type {any} */ ({ tool_name: 'write_file', path: '.devmate/state/task.json' }),
    STATE,
    CONFIG_OK,
    { budgetCritical: MARKER, scope: SCOPE }
  );
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /session artifact/i);
});

test('evaluateGuard behaves normally when marker absent', () => {
  // A test-file write at impl-started passes every rule (TDD allows test
  // writes) — the same call with the marker present is denied.
  const payload = /** @type {any} */ ({ tool_name: 'write_file', path: 'test/app.test.mjs' });
  const without = evaluateGuard(payload, STATE, CONFIG_OK, { scope: SCOPE });
  assert.equal(without.decision, 'allow');
  const withMarker = evaluateGuard(payload, STATE, CONFIG_OK, {
    budgetCritical: MARKER,
    scope: SCOPE,
  });
  assert.equal(withMarker.decision, 'deny');
});
