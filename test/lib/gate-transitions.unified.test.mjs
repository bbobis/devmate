// @ts-check
/**
 * E9-14: cross-validates that the gatectl linear projection and the canonical
 * lane/event table can never disagree, and that no prose-only gate name
 * survives in the docs/agent files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGAL_TRANSITIONS, advanceGate, isLegalTransition, GateTransitionError } from '../../lib/gatectl.mjs';
import { TRANSITIONS, flattenTransitions, transitionGate } from '../../lib/gate-transitions.mjs';

/**
 * The authoritative gate name set — mirrors the module-private `VALID_GATES`
 * in `lib/task-state.mjs` (source of truth; do not diverge). Includes the
 * E10-05 steering gates `parked` and `abandoned`.
 * @type {readonly import('../../lib/types.mjs').WorkflowGate[]}
 */
const VALID_GATES = [
  'no-lane', 'lane-set', 'discovery-done', 'grill-done', 'plan-done',
  'plan-approved', 'spec-draft', 'spec-approved', 'spec-invalidated',
  'impl-started', 'verification-passed', 'pr-ready', 'done',
  'parked', 'abandoned',
];

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Minimal TaskState for transitionGate calls.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {TaskState}
 */
function stateAt(lane, gate) {
  return /** @type {TaskState} */ (/** @type {unknown} */ ({
    taskId: 't-unified',
    lane,
    workflowGate: gate,
    currentStep: 3,
  }));
}

test('gatectl transitions match gate-transitions for shared slice', () => {
  // Every lane/event pair in the canonical table must be legal in the
  // gatectl projection — the hook path can never reject what the CLI allows.
  for (const [lane, laneTable] of Object.entries(TRANSITIONS)) {
    for (const [gate, gateTable] of Object.entries(laneTable)) {
      for (const [event, next] of Object.entries(gateTable)) {
        assert.equal(
          isLegalTransition(/** @type {WorkflowGate} */ (gate), next),
          true,
          `${lane}: ${gate} --${event}--> ${next} must be legal under gatectl`
        );
      }
    }
  }
});

test('LEGAL_TRANSITIONS is exactly the canonical flattened projection', () => {
  const flat = flattenTransitions();
  assert.deepEqual(
    Object.fromEntries(Object.entries(LEGAL_TRANSITIONS).map(([k, v]) => [k, [...v].sort()])),
    Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, [...v].sort()]))
  );
  // And it exhaustively covers VALID_GATES.
  for (const gate of VALID_GATES) {
    assert.ok(gate in LEGAL_TRANSITIONS, `missing gate: ${gate}`);
  }
});

test('advanceGate rejects illegal transition', () => {
  assert.throws(
    () => advanceGate('spec-draft', 'done'),
    (err) => err instanceof GateTransitionError
  );
});

test('isLegalTransition agrees with transitionGate', async () => {
  // For every lane/gate/event triple: transitionGate ok => isLegalTransition true
  // for the produced pair; transitionGate error on a known gate => the event's
  // target is not reachable per the projection either.
  const events = /** @type {GateEvent[]} */ (['draft-spec', 'start-impl', 'pass-verification', 'mark-pr-ready', 'complete']);
  for (const lane of /** @type {Lane[]} */ (Object.keys(TRANSITIONS))) {
    for (const gate of VALID_GATES) {
      for (const event of events) {
        const result = await transitionGate(stateAt(lane, gate), event);
        if (result.ok && result.to !== undefined) {
          assert.equal(
            isLegalTransition(gate, result.to),
            true,
            `${lane}/${gate}/${event} ok under transitionGate but illegal under gatectl`
          );
        }
      }
    }
  }
});

test('no prose gate remains', () => {
  // The seven names E9-14 purged must not appear as bare backticked gate
  // tokens in the architecture doc or the orchestrator agent card.
  const proseGates = /`(intake|design-done|backend-ready|diagnosis-done|scope-written|change-complete|escalated)`/g;
  // @bounded-alloc — reads two checked-in docs.
  for (const rel of ['docs/ARCHITECTURE.md', 'agents/orchestrator.agent.md']) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const hits = text.match(proseGates) ?? [];
    assert.deepEqual(hits, [], `${rel} still references prose-only gates: ${hits.join(', ')}`);
  }
});

test('every gate named in the canonical table is a VALID_GATES member', () => {
  const flat = flattenTransitions();
  for (const [gate, successors] of Object.entries(flat)) {
    assert.ok(VALID_GATES.includes(/** @type {WorkflowGate} */ (gate)), `unknown gate key: ${gate}`);
    for (const next of successors) {
      assert.ok(VALID_GATES.includes(next), `unknown successor: ${gate} -> ${next}`);
    }
  }
});
