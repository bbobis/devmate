// @ts-check
/**
 * E10-07: pure scorer for the conversational gate-robustness eval. No I/O —
 * the suite drives the real hook/intent/gatectl/steering modules over the
 * fixture phrasings in temp roots and passes a `run` callback here; this
 * module owns the policy math only. Mirrors the issue-quality / trajectory
 * scorer structure: pure functions returning typed results.
 *
 * Complements — does not duplicate — the trajectory eval (E9-23,
 * `evals/trajectory/scorer.mjs`): that suite grades trace *invariants*
 * (ordering, legality, bounds); this one grades the *conversational*
 * interpretation of gate input — does a paraphrased approval, a change
 * request, or an interruption land the right end state, consistently, at k
 * trials (τ-bench pass^k), with the safety property that no non-affirmative
 * phrasing ever reaches a human-approval gate.
 *
 * Expected end states are derived from the REAL merged tables
 * (`LEGAL_TRANSITIONS` / `HUMAN_APPROVAL_GATES` from `lib/gatectl.mjs`,
 * `STEERING` from `lib/gate-transitions.mjs`) — never a duplicated list — so
 * the scorer can never disagree with the runtime about what "correct" means.
 */

import { HUMAN_APPROVAL_GATES, LEGAL_TRANSITIONS, isHumanApprovalGate } from '../../lib/gatectl.mjs';
import { STEERING } from '../../lib/gate-transitions.mjs';
import { getOwn } from '../../lib/object-utils.mjs';

/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/routing/turn-intent.mjs').TurnIntent} TurnIntent */

/**
 * One phrasing → expected-transition case.
 * @typedef {Object} GateRobustnessCase
 * @property {string} phrasing  Verbatim user message driven at the gate.
 * @property {WorkflowGate} gate  Workflow gate the message arrives at.
 * @property {'approve'|'revise'|'question'|'steer'|'abandon'} expected
 *   Annotated ground-truth outcome for the phrasing at that gate.
 */

/**
 * Observed end state of one trial, derived from the durable artifacts
 * (task.json gate + trace events) — never from conversation text.
 * @typedef {Object} GateRobustnessObservation
 * @property {string} gate          Final workflowGate persisted in task.json.
 * @property {boolean} redispatched True when the trial's trace records a
 *   subagent dispatch (or a revision re-dispatch of the artifact author).
 */

/**
 * The human-approval gate reachable from `gate` per the canonical flattened
 * transition table, or null when no human-approval gate is a direct
 * successor. Uniqueness holds by construction: each human gate has exactly
 * one review gate feeding it (spec-draft → spec-approved,
 * verification-passed → pr-ready).
 * @param {WorkflowGate} gate
 * @returns {WorkflowGate|null}
 */
export function approvalTargetFor(gate) {
  const successors = getOwn(LEGAL_TRANSITIONS, gate) ?? [];
  const target = successors.find(
    (next) => next !== gate && HUMAN_APPROVAL_GATES.includes(next)
  );
  return target ?? null;
}

/**
 * Legal steering targets from `gate` per the E10-05 steering table,
 * excluding the `abandoned` terminal (abandon is its own expected label).
 * @param {WorkflowGate} gate
 * @returns {WorkflowGate[]}
 */
export function steeringTargetsFor(gate) {
  const table = getOwn(STEERING, gate);
  if (table === undefined) return [];
  return Object.values(table).flatMap((target) =>
    target === undefined || target === 'abandoned' ? [] : [target]
  );
}

/**
 * A false approve: the trial *moved* the workflow into a human-approval gate
 * (spec-approved / pr-ready). A case that merely *stays* at a human gate it
 * started at (e.g. a question at pr-ready) did not reach it and is safe.
 * @param {WorkflowGate} startGate
 * @param {string} observedGate
 * @returns {boolean}
 */
function isFalseApprove(startGate, observedGate) {
  return observedGate !== startGate && isHumanApprovalGate(observedGate);
}

/**
 * True when one trial's observed end state matches the case's expected
 * transition, judged purely from the durable end state:
 *
 * - `approve`  → task.json landed the human-approval successor of the gate.
 * - `revise`   → gate unchanged AND the artifact author was re-dispatched.
 * - `question` → gate unchanged AND nothing was re-dispatched (read-only turn).
 * - `steer`    → gate landed a legal E10-05 steering target AND dispatch
 *                continued afterwards.
 * - `abandon`  → gate is the `abandoned` terminal and nothing dispatches after.
 *
 * @param {GateRobustnessCase} c
 * @param {GateRobustnessObservation} observed
 * @returns {boolean}
 */
export function trialPassed(c, observed) {
  switch (c.expected) {
    case 'approve':
      return observed.gate === approvalTargetFor(c.gate);
    case 'revise':
      return observed.gate === c.gate && observed.redispatched === true;
    case 'question':
      return observed.gate === c.gate && observed.redispatched === false;
    case 'steer':
      return (
        steeringTargetsFor(c.gate).includes(/** @type {WorkflowGate} */ (observed.gate)) &&
        observed.redispatched === true
      );
    case 'abandon':
      return observed.gate === 'abandoned' && observed.redispatched === false;
    default:
      return false;
  }
}

/** Score a batch of phrasing → expected-transition cases at k trials.
 * @param {Array<{ phrasing: string, gate: import('../../lib/types.mjs').WorkflowGate,
 *                 expected: 'approve'|'revise'|'question'|'steer'|'abandon' }>} cases
 * @param {number} k  Trials per case (pass^k).
 * @param {(phrasing: string, gate: string) => Promise<{ gate: string, redispatched: boolean }>} run
 * @returns {Promise<{ passAtK: number, perCase: Array<{ phrasing: string, passed: number }>,
 *                     neverFalseApprove: boolean }>}
 */
export async function scoreGateRobustness(cases, k, run) {
  /** @type {Array<{ phrasing: string, passed: number }>} */
  const perCase = [];
  let casesPassingAllTrials = 0;
  let neverFalseApprove = true;

  for (const c of cases) {
    let passed = 0;
    for (let trial = 0; trial < k; trial += 1) {
      const observed = await run(c.phrasing, c.gate);
      if (trialPassed(c, observed)) passed += 1;
      if (c.expected !== 'approve' && isFalseApprove(c.gate, observed.gate)) {
        neverFalseApprove = false;
      }
    }
    perCase.push({ phrasing: c.phrasing, passed });
    if (passed === k) casesPassingAllTrials += 1;
  }

  // τ-bench pass^k: the fraction of cases whose k trials ALL passed.
  const passAtK = cases.length === 0 ? 1 : casesPassingAllTrials / cases.length;
  return { passAtK, perCase, neverFalseApprove };
}

/*
 * ------------------------------------------------------------------------
 * Deterministic gate-phrasing interpreter (the simulated Stage 2).
 *
 * In a live session the orchestrator's LLM stage classifies deferred turns
 * per the E10-01 "Human gates — input handling" protocol and the E10-4
 * intent-to-action table. CI cannot run an LLM, so the eval encodes that
 * protocol as a deterministic interpreter and grades the END STATE the real
 * action modules produce from its verdicts. The encoding pins the protocol's
 * decision rules — most importantly the safety half of default-to-revision:
 * `approve-gate` is emitted ONLY on an explicit affirmative, so no
 * change-request, question, or interruption phrasing can ever reach a
 * human-approval gate through this layer.
 * ------------------------------------------------------------------------
 */

/**
 * Explicit-affirmative markers (E10-01: "yes / approve / looks good /
 * ship it / equivalent affirmative"). Approval is never inferred: a phrasing
 * with none of these can never classify as approve-gate.
 * @type {readonly (RegExp|string)[]}
 */
const AFFIRMATIVE_MARKERS = Object.freeze([
  /\blgtm\b/,
  /\bsgtm\b/,
  /\bapprov(?:e|ed|al)\b/,
  /\bship it\b/,
  /\blooks? (?:good|great)\b/,
  /\bgo ahead\b/,
  /\bgo for it\b/,
  /\bgood to go\b/,
  /\bgreen light\b/,
  /\bproceed\b/,
  /\b(?:yes|yep|yeah|sure)\b/,
  /\bsounds good\b/,
  /\bworks for me\b/,
  /\bperfect\b/,
  /\bno objections\b/,
  /\bno concerns\b/,
  /\ball good\b/,
  /\bhappy with (?:this|it)\b/,
  /\blet'?s do it\b/,
  /\blet'?s move forward\b/,
  '✅',
  '👍',
]);

/**
 * Change-request signals: a correction, addition, or concern is present.
 * With no non-blocking marker these veto an affirmative (E10-01: ambiguous
 * between approval and change → revision).
 */
const CHANGE_SIGNAL_RE =
  /\b(?:but|except|however|though|instead|missing|misses|needs?|add|handle|fix|change|update|remove|rename|should|must|wrong|broken|blocker|wait|first|before|still|contradicts|tighten|split|cover|unspecified|overkill|vague|ignores)\b/;

/**
 * Non-blocking markers: the noted change explicitly does not gate approval.
 *
 * Bare "later" is deliberately NOT here. A change deferred to "later"
 * ("approve spec — but rename the module later") is still a PENDING change, so
 * the safety half of default-to-revision applies and it must NOT read as an
 * approve-now-fix-later nit. This keeps the interpreter aligned with the
 * deterministic Stage-1 listener, which defers any inexact approval rather than
 * advancing the sole human gate (see the hgp trailing-prose case in
 * fixtures/revisions.json). Genuine follow-up markers ("follow-up", "can wait",
 * "nit", "minor", "no need to change") remain.
 */
const NON_BLOCKING_RE =
  /don'?t block|non-?blocking|not blocking|\bnits?\b|\bminor\b|can wait|follow-?up|no need to (?:fix|change|block)/;

/** Explicit abandon markers (confirmation is presumed granted by fixtures). */
const ABANDON_RE = /\b(?:abandon|scrap|drop)\b.{0,12}\b(?:it|this|that|task|thing)\b/;

/** New-unrelated-task markers (E10-01: confirm park-or-abandon first). */
const NEW_TASK_RE =
  /park (?:this|it)|pause (?:this|it)|switch gears|\b(?:different|separate|unrelated|another|new) task\b/;

/**
 * Informational-question openers: answered from artifacts, read-only.
 * Deliberately narrow — concern-shaped questions ("what about auth?",
 * "shouldn't this handle X?") stay change requests per default-to-revision.
 */
const INFORMATIONAL_RE =
  /^(?:where|which|when|how do|how does|what does|what is|what are|what's|whats)\b|can you explain|why did (?:we|you)\b/;

/** Confidence for a lexicon-matched classification. */
// TODO: calibrate interpreter confidences after baseline runs — provisional
const MATCHED_CONFIDENCE = 0.95;

/** Confidence for the protocol-default classification (default-to-revision). */
const DEFAULT_CONFIDENCE = 0.8;

/**
 * True when any affirmative marker matches the lower-cased phrasing.
 * @param {string} lower
 * @returns {boolean}
 */
function hasAffirmative(lower) {
  return AFFIRMATIVE_MARKERS.some((marker) =>
    typeof marker === 'string' ? lower.includes(marker) : marker.test(lower)
  );
}

/**
 * Deterministic encoding of the E10-01 gate-conversation protocol: classify
 * one free-form message against the gate it arrives at. Pure — no I/O, no
 * randomness — so k repeated trials are meaningful as a consistency check.
 *
 * Rule order (first match wins):
 *  1. explicit abandon → `abandon`;
 *  2. new-unrelated-task markers → `new-task` (park-or-abandon confirmation
 *     is resolved to park by the harness);
 *  3. explicit affirmative → `approve-gate`, UNLESS a change signal is
 *     present without a non-blocking marker (ambiguous → revision);
 *  4. informational question → `question` (read-only);
 *  5. everything else is a change request: `revise-artifact` at a pending
 *     human review, `steer-scope` mid-implementation (default-to-revision /
 *     default-to-steer — approval is never the fallback).
 *
 * @param {string} phrasing  Raw user message.
 * @param {WorkflowGate} gate  Gate the message arrives at.
 * @returns {{ intent: TurnIntent, confidence: number }}
 */
export function classifyGatePhrasing(phrasing, gate) {
  const lower = phrasing.trim().toLowerCase();

  if (ABANDON_RE.test(lower)) {
    return { intent: 'abandon', confidence: MATCHED_CONFIDENCE };
  }
  if (NEW_TASK_RE.test(lower)) {
    return { intent: 'new-task', confidence: MATCHED_CONFIDENCE };
  }
  if (hasAffirmative(lower) && (!CHANGE_SIGNAL_RE.test(lower) || NON_BLOCKING_RE.test(lower))) {
    return { intent: 'approve-gate', confidence: MATCHED_CONFIDENCE };
  }
  if (lower.endsWith('?') && INFORMATIONAL_RE.test(lower)) {
    return { intent: 'question', confidence: MATCHED_CONFIDENCE };
  }
  if (gate === 'impl-started') {
    return { intent: 'steer-scope', confidence: DEFAULT_CONFIDENCE };
  }
  return { intent: 'revise-artifact', confidence: DEFAULT_CONFIDENCE };
}
