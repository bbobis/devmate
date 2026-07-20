// @ts-check
/**
 * DENIAL-RECOVERY MATRIX (issue #137).
 *
 * Closes the loop the original audit opened: "does a gate-guard denial say
 * 'delegate to @fullstack' when the dispatch gate would ALSO deny that
 * delegation?" For every `evaluateGuard` deny whose reason names a recovery, this
 * cross-checks that the named recovery is genuinely available from that exact
 * `(lane, gate)` — so no denial ever strands the caller in a hard deadlock (a
 * refusal whose only escape is itself blocked).
 *
 * Pure and fast: `evaluateGuard` and `evaluateImplementationDispatch` are both
 * pure (all facts injected, no I/O), so this needs no subprocess.
 *
 * Finding (recorded, not a hard deadlock): the pre-implementation Rule 3 denials
 * DO name "@fullstack" at gates where `evaluateImplementationDispatch` also denies
 * an @fullstack dispatch (the gate is not `impl-started`). But they name the
 * lane's real next move FIRST (`approve spec` / `approve plan` / "advances on its
 * own") — the @fullstack clause describes who edits ONCE the gate opens, not a
 * claim that @fullstack is dispatchable now. The genuinely-available recovery is
 * present, so it is a message-clarity ambiguity, not a deadlock. This suite pins
 * exactly that: every @fullstack-naming deny co-names an available recovery.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGuard } from '../../lib/gate-guard-core.mjs';
import { evaluateImplementationDispatch, isImplementationDispatch } from '../../lib/workflow/dispatch-gate.mjs';

/** @typedef {import('../../lib/types.mjs').Lane} Lane */

/** The deny reason as a definite string (GuardDecision.reason is optional).
 * @param {import('../../lib/types.mjs').GuardDecision} dec @returns {string} */
const reasonOf = (dec) => dec.reason ?? '';

const CONFIG_OK = /** @type {any} */ ({ ok: true, config: { schemaVersion: 1, personas: [] } });
/** A scopeable source-edit via a recognized file tool. */
const EDIT = /** @type {any} */ ({ tool_name: 'create_file', path: 'repo-a/lib/x.mjs' });

/**
 * A task state at (lane, gate) with the TDD guard optionally pre-satisfied and the
 * spec metadata optionally present.
 * @param {Lane} lane
 * @param {string} gate
 * @param {{ tddSatisfied?: boolean, withSpec?: boolean }} [o]
 * @returns {any}
 */
function stateAt(lane, gate, o = {}) {
  return {
    taskId: 't-drm',
    lane,
    workflowGate: gate,
    currentStep: 0,
    artifactHashes: o.withSpec ? { spec: '.devmate/session/spec.md', specDigest: 'abc' } : {},
    preImplStash: null,
    budget: 10,
    tddGuard: { testFileWritten: o.tddSatisfied ?? true, consecutiveNonTestWrites: 0, overrideGranted: false },
    schemaVersion: 1,
  };
}

/** The lane's immediately-available next move, named in a Rule 3 denial. */
const NEXT_MOVE = {
  feature: /approve spec/i,
  bug: /approve plan/i,
  chore: /impl-started|on its own/i,
};

const LANES = /** @type {Lane[]} */ (['feature', 'bug', 'chore']);
/** Gates before implementation, where a source edit is refused (Rule 3). */
const PRE_IMPL_GATES = ['no-lane', 'lane-set', 'plan-approved', 'spec-draft', 'spec-approved'];

// ── The deadlock class: every @fullstack-naming deny co-names an available recovery ──

for (const lane of LANES) {
  for (const gate of PRE_IMPL_GATES) {
    test(`Rule 3 deny at ${lane}/${gate}: names @fullstack only alongside an available next move`, () => {
      const d = evaluateGuard(EDIT, stateAt(lane, gate), CONFIG_OK, {});
      assert.equal(d.decision, 'deny', `expected a pre-impl edit deny at ${lane}/${gate}`);
      if (/@fullstack/i.test(reasonOf(d))) {
        // The @fullstack delegate is NOT dispatchable at a pre-impl gate — the
        // dispatch gate refuses it (workflowGate must be impl-started).
        const disp = evaluateImplementationDispatch({
          agentName: 'fullstack',
          stateResult: { ok: true, state: stateAt(lane, gate, { withSpec: true }) },
          scope: { present: true, nonEmpty: true },
          diagnosisValid: true,
        });
        assert.equal(disp.decision, 'denied', `@fullstack should be blocked pre-impl at ${lane}/${gate}`);
        // …so the denial MUST also name the immediately-available recovery, or the
        // caller is stranded. It does (the lane next move).
        assert.match(reasonOf(d), NEXT_MOVE[lane], `deny at ${lane}/${gate} names @fullstack with no available recovery:\n${reasonOf(d)}`);
        // #177: since @fullstack is NOT dispatchable here, the mention must be
        // QUALIFIED as the editor once the gate opens — never an immediately-
        // available action. Pin that @fullstack is tied to impl-started in the same
        // sentence, so a revert to unqualified "delegate to @fullstack" fails here.
        assert.match(
          reasonOf(d),
          /@fullstack[^.]*impl-started/i,
          `#177 — the @fullstack clause at ${lane}/${gate} must be qualified as post-impl-started, not immediately-available:\n${reasonOf(d)}`,
        );
      }
    });
  }
}

// ── The other recoveries denials name are genuinely available ──

test('Rule 1 (no config) names `devmate init` — a real CLI, not a blocked dispatch', () => {
  const d = evaluateGuard(EDIT, stateAt('feature', 'impl-started'), /** @type {any} */ ({ ok: false, error: 'missing' }), {});
  assert.equal(d.decision, 'deny');
  assert.match(reasonOf(d), /devmate init/i);
});

test('Rule 2 (no active task) names @orchestrator — always available to start a task', () => {
  const d = evaluateGuard(EDIT, /** @type {any} */ (null), CONFIG_OK, {});
  assert.equal(d.decision, 'deny');
  assert.match(reasonOf(d), /@orchestrator/i);
});

test('@fullstack IS dispatchable once the gate opens — the R3b terminal-edit recovery is real at impl-started', () => {
  // A terminal source edit at impl-started is refused (unscopeable) and told to
  // delegate to @fullstack — and there, unlike pre-impl, @fullstack IS allowed.
  const d = evaluateGuard(
    /** @type {any} */ ({ tool_name: 'run_in_terminal', command: "sed -i 's/a/b/' repo-a/lib/x.mjs" }),
    stateAt('feature', 'impl-started', { withSpec: true }),
    CONFIG_OK,
    {},
  );
  assert.equal(d.decision, 'deny');
  assert.match(reasonOf(d), /@fullstack/i);
  const disp = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: { ok: true, state: stateAt('feature', 'impl-started', { withSpec: true }) },
    scope: { present: true, nonEmpty: true },
    diagnosisValid: true,
  });
  assert.equal(disp.decision, 'allowed', 'the named @fullstack recovery is genuinely available at impl-started');
});

test('a scope-producer denial names @planner/@diagnose — analysis dispatches the dispatch gate never blocks', () => {
  // At impl-started with no scope contract, the edit is refused and told to have
  // the lane scope producer return its file list.
  const d = evaluateGuard(EDIT, stateAt('feature', 'impl-started', { withSpec: true }), CONFIG_OK, {});
  assert.equal(d.decision, 'deny');
  assert.match(reasonOf(d), /@planner|@diagnose|scope producer/i);
  // Analysis agents are not implementation dispatches, so the dispatch gate never
  // gates them — the recovery is unconditionally available.
  assert.equal(isImplementationDispatch('@planner'), false);
  assert.equal(isImplementationDispatch('@diagnose'), false);
});

test('no deny in the surface names ONLY a blocked recovery — zero hard deadlocks', () => {
  // Aggregate guard over the deadlock-relevant surface: every deny that delegates
  // to @fullstack also names an available recovery (the lane next move), so there
  // is no reachable denial whose only escape is itself blocked.
  let checked = 0;
  for (const lane of LANES) {
    for (const gate of PRE_IMPL_GATES) {
      const d = evaluateGuard(EDIT, stateAt(lane, gate), CONFIG_OK, {});
      if (d.decision === 'deny' && /@fullstack/i.test(reasonOf(d))) {
        assert.match(reasonOf(d), NEXT_MOVE[lane]);
        checked += 1;
      }
    }
  }
  // Every (lane × pre-impl gate) Rule 3 deny names @fullstack — a strict count, so
  // dropping @fullstack from even one reason (or a rule going silent) fails here.
  assert.equal(checked, LANES.length * PRE_IMPL_GATES.length, 'every pre-impl deny should name @fullstack');
});
