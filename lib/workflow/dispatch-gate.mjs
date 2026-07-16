// @ts-check

/**
 * HITL-1: lane-gated implementation-dispatch evaluator.
 *
 * A pure decision function (no disk I/O — all facts injected) shared by two
 * independent hook layers: the PreToolUse gate-guard (scripts/gate-guard.mjs)
 * and the SubagentStart budget guard (hooks/subagent-budget-guard.mjs). Both
 * call this one evaluator so the "no implementation before the lane's gates and
 * artifacts exist" rule cannot drift between them.
 *
 * The rule, per lane (all lanes also require task.json to exist and the gate to
 * be impl-started):
 *   - feature: recorded spec artifacts (artifactHashes.spec + specDigest) — i.e.
 *     spec-writer ran and the human approved the spec.
 *   - bug:     a valid diagnosis result AND a scope.md.
 *   - chore:   a scope.md.
 *
 * Analysis dispatches (router, discovery, tech-design, rubber-duck, planner,
 * spec-writer, ui-ux, diagnose, security, frontend-tester) are NOT implementation
 * dispatches (isImplementationDispatch returns false) and are never gated here —
 * they must be able to run before a task exists.
 */

import { getOwn } from '../object-utils.mjs';
import { normalizeDispatchedAgent, normalizeLane } from './orchestrator.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').DispatchGateResult} DispatchGateResult */

/**
 * Agents whose dispatch means "write product code". `normalizeDispatchedAgent`
 * canonicalizes every persona wrapper (frontend/backend/editor) to `fullstack`,
 * so membership is tested against the normalized name. The list stays in sync
 * with `fullstack` + the persona keys (see the drift test); it is deliberately
 * NOT config-overridable — a consumer-editable list would let the safety rail
 * be switched off. `frontend-tester` is excluded (its contract forbids product
 * edits).
 * @type {readonly string[]}
 */
export const IMPLEMENTATION_AGENTS = Object.freeze([
  'fullstack',
  'backend',
  'frontend',
  'editor',
]);

/**
 * True when the given agent name denotes an implementation dispatch. Reuses
 * `normalizeDispatchedAgent` ('@' prefix, '.agent' suffix, lowercasing, persona
 * aliases), which collapses every persona to `fullstack`. An empty or 'unknown'
 * name normalizes to a value outside {@link IMPLEMENTATION_AGENTS} and returns
 * false — the gate NEVER fails closed on a name a hook cannot see, or it would
 * block every analysis dispatch.
 * @param {unknown} agentName
 * @returns {boolean}
 */
export function isImplementationDispatch(agentName) {
  const normalized = normalizeDispatchedAgent(agentName);
  if (normalized === '') return false;
  return IMPLEMENTATION_AGENTS.includes(normalized);
}

/**
 * Per-lane artifact requirements an implementation dispatch must satisfy, on top
 * of the universal "task.json exists + gate is impl-started" checks. Frozen and
 * artifact-based — deliberately distinct from the trace-based, config-overridable
 * `LANE_DISPATCH_REQUIREMENTS` (the analysis delegation floor); this map is a
 * safety rail and must not be overridable.
 *   - spec:      artifactHashes.spec AND artifactHashes.specDigest present.
 *   - diagnosis: a valid .devmate/state/diagnosis.json.
 *   - scope:     a present, non-empty scope.md.
 * @type {Readonly<Record<string, Readonly<{ spec?: boolean, diagnosis?: boolean, scope?: boolean }>>>}
 */
export const LANE_IMPL_REQUIREMENTS = Object.freeze({
  // #92: the feature lane demanded a spec but NO edit boundary, so @fullstack
  // could start with nothing bounding which files it touched. The bug and chore
  // lanes did demand scope.md — but nothing could write the file, so that demand
  // refused their implementation dispatch outright instead of bounding it. All
  // three now require the contract, and the gate-advance hook produces it from
  // the planner's (or @diagnose's) typed return.
  feature: Object.freeze({ spec: true, scope: true }),
  bug: Object.freeze({ diagnosis: true, scope: true }),
  chore: Object.freeze({ scope: true }),
});

/**
 * True when task state records both spec artifact hashes.
 * @param {TaskState} state
 * @returns {boolean}
 */
function hasSpecMetadata(state) {
  const artifactMeta = state.artifactHashes;
  if (artifactMeta === null || typeof artifactMeta !== 'object') return false;
  return Boolean(getOwn(artifactMeta, 'spec')) && Boolean(getOwn(artifactMeta, 'specDigest'));
}

/**
 * Pure lane-aware verdict for an implementation dispatch. All facts are injected
 * so the function does no I/O and is trivially testable. Callers gate on this
 * only when {@link isImplementationDispatch} is true; analysis dispatches never
 * reach here.
 *
 * Deny reasons are actionable and name the skipped step:
 *   - missing/unreadable task.json -> run init-task-state (start via @orchestrator)
 *   - wrong gate                   -> names the current gate and required 'impl-started'
 *   - feature, no spec             -> names spec-writer and the "approve spec" gate
 *   - bug, no diagnosis            -> names @diagnose / diagnosis.json
 *   - bug/chore, no scope          -> names scope.md
 *
 * @param {Object} input
 * @param {unknown} input.agentName  The dispatched agent name (already known to be an implementation dispatch).
 * @param {{ ok: boolean, state?: TaskState, errors?: string[] }} input.stateResult  Result of readTaskState.
 * @param {{ present: boolean, nonEmpty: boolean }} input.scope  scope.md facts for the active task.
 * @param {boolean} input.diagnosisValid  validateDiagnosisResult verdict for .devmate/state/diagnosis.json (bug lane only).
 * @returns {DispatchGateResult}
 */
export function evaluateImplementationDispatch(input) {
  const { stateResult, scope, diagnosisValid } = input;

  // 1) task.json must exist and parse. Missing/unreadable state denies here —
  // unlike the analysis fail-open — because an implementation dispatch means a
  // gated lane must already be in flight.
  if (!stateResult || stateResult.ok !== true || !stateResult.state) {
    const detail =
      stateResult && Array.isArray(stateResult.errors) && stateResult.errors.length > 0
        ? ` (${stateResult.errors[0]})`
        : '';
    return {
      decision: 'denied',
      reason:
        `implementation dispatch blocked: task.json is missing or unreadable${detail} — ` +
        'start the task through @orchestrator so init-task-state records the lane and ' +
        'gate before any implementation agent runs.',
    };
  }
  const state = stateResult.state;

  // 2) gate must be impl-started.
  if (state.workflowGate !== 'impl-started') {
    return {
      decision: 'denied',
      reason:
        `implementation dispatch blocked: workflowGate must be 'impl-started', got ` +
        `'${state.workflowGate}'. Advance the lane's gates first before dispatching ` +
        `an implementation agent.`,
    };
  }

  // 3) lane-specific artifacts. An unknown lane has no extra requirements.
  const lane = normalizeLane(state.lane);
  const reqs = getOwn(LANE_IMPL_REQUIREMENTS, lane) ?? {};

  if (reqs.spec && !hasSpecMetadata(state)) {
    return {
      decision: 'denied',
      reason:
        'implementation dispatch blocked: missing spec artifact metadata ' +
        '(artifactHashes.spec/specDigest). spec-writer must write spec.md and the ' +
        'human must "approve spec" before implementation begins.',
    };
  }

  if (reqs.diagnosis && diagnosisValid !== true) {
    return {
      decision: 'denied',
      reason:
        'implementation dispatch blocked: no valid .devmate/state/diagnosis.json. ' +
        '@diagnose must reproduce the bug and record a DiagnosisResult before the fix runs.',
    };
  }

  if (reqs.scope && !(scope && scope.present && scope.nonEmpty)) {
    return {
      decision: 'denied',
      reason:
        'implementation dispatch blocked: scope.md is missing or empty. The lane\'s ' +
        'scope producer must write .devmate/session/<taskId>/scope.md before implementation begins.',
    };
  }

  return { decision: 'allowed', reason: '' };
}
