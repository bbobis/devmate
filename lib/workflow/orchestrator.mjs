// @ts-check

/**
 * Dispatch-result guard for orchestrator subagent handoffs.
 *
 * The orchestrator prompt must treat an empty, malformed, or unresolved
 * subagent response as a hard stop. This helper centralizes the validation
 * logic so tests can pin the contract without relying on prompt prose alone.
 */

import { parseRouterResult } from '../routing/router.mjs';
import { getOwn } from '../object-utils.mjs';
import { explainOwnership, filesOutsidePersonaScope } from '../gate-guard-core.mjs';
import { evaluateImplementationDispatch } from './dispatch-gate.mjs';

/** @typedef {'ok' | 'blocked' | 'escalated' | 'error'} DispatchStatus */
/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */

/**
 * Normalized result from a subagent dispatch.
 * @typedef {object} DispatchResult
 * @property {DispatchStatus} status
 * @property {string} [agentName]
 * @property {string} [artifactPath]
 * @property {Record<string, unknown>} [payload]
 * @property {number[]} [targetAcIds]  AC-3: orchestrator-stamped dispatch context — the global acceptance-criterion ids the dispatch was given (the AC-5 assignment). Stamped onto the persisted result envelope by the orchestrator before validation, never agent-authored.
 * @property {string} [reason]
 * @property {string} [error]
 */

/** @typedef {{ ok: boolean, error?: string }} DispatchAssertion */

/** @type {Set<DispatchStatus>} */
const VALID_STATUSES = new Set(['ok', 'blocked', 'escalated', 'error']);

/** @type {Record<string, { mode: 'any' | 'all', keys: string[] }>} */
const REQUIRED_PAYLOAD_RULES = {
  discovery: { mode: 'any', keys: ['claims', 'unverified'] },
  'tech-design': { mode: 'any', keys: ['dataModel', 'apiContracts'] },
  planner: { mode: 'any', keys: ['tasks'] },
  'rubber-duck': { mode: 'any', keys: ['verdict', 'blockingQuestions', 'unverifiedItems', 'edgeCases'] },
  'spec-writer': { mode: 'any', keys: ['specPath'] },
  'ui-ux': { mode: 'any', keys: ['screens', 'interactions', 'errorStates'] },
  diagnose: { mode: 'all', keys: ['bugScope', 'reproCommand', 'taskId'] },
  security: { mode: 'any', keys: ['findings'] },
  'frontend-tester': { mode: 'any', keys: ['summary', 'pass'] },
  // `completedAcIds` (number[]) names the acceptance criteria whose mapped test
  // reached GREEN in this dispatch. AC-3: it is required — possibly [] — whenever
  // the dispatch targeted ACs, signalled by the orchestrator-stamped envelope
  // `targetAcIds` (see assertCompletedAcIdsContract, enforced alongside this
  // rule). A dispatch with no AC targets may still omit it, so non-AC fullstack
  // replies validate unchanged. The orchestrator records each id via
  // scripts/complete-ac.mjs so resume can skip completed ACs; the ids are a
  // claim the AC-coverage gate (AC-2) re-checks against real trace evidence.
  fullstack: { mode: 'any', keys: ['verification', 'changedFiles', 'summary'] },
};

/**
 * Canonical agents whose `status: 'ok'` dispatch result must be *backed by a
 * real subagent run* — a `subagent_start` trace event for the agent must exist
 * before the result validates. This is the result-guard mirror of the dispatch
 * floor ({@link assertDispatchFloor}): the shape-only {@link assertDispatchResult}
 * cannot tell a genuine subagent reply from one the orchestrator hand-authored
 * to satisfy the validator, so for these agents we additionally require proof
 * the dispatch actually happened. `fullstack` is the only such agent today — it
 * is the sole persona that writes source and whose `ok` result gates
 * implementation, so a fabricated "done" result there is the costly lie.
 * @type {ReadonlySet<string>}
 */
const TRACE_BACKED_RESULT_AGENTS = new Set(['fullstack']);

/**
 * Check whether a value is present enough to count as a contract field.
 * @param {unknown} value
 * @returns {boolean}
 */
function hasPresentValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(/** @type {Record<string, unknown>} */ (value)).length > 0;
  return true;
}

/**
 * Check whether a result proves success through artifactPath or payload keys.
 * @param {unknown} result
 * @param {'any' | 'all'} mode
 * @param {string[]} requiredPayloadKeys
 * @returns {boolean}
 */
function hasArtifactOrPayload(result, mode, requiredPayloadKeys) {
  if (result === null || typeof result !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (result);

  if (hasPresentValue(record.artifactPath)) {
    return true;
  }

  const payload = record.payload;
  if (payload === null || typeof payload !== 'object') return false;
  const payloadRecord = /** @type {Record<string, unknown>} */ (payload);

  if (mode === 'all') {
    return requiredPayloadKeys.every((key) => hasPresentValue(getOwn(payloadRecord, key)));
  }

  return requiredPayloadKeys.some((key) => hasPresentValue(getOwn(payloadRecord, key)));
}

/**
 * Format a consistent validation error.
 * @param {string} agentName
 * @param {string} cause
 * @returns {DispatchAssertion}
 */
function fail(agentName, cause) {
  return { ok: false, error: `${agentName}: ${cause}` };
}

/**
 * Check that a value is an array whose every element is a finite number.
 * @param {unknown} value
 * @returns {value is number[]}
 */
function isNumberArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * AC-3 (epic #416): when a fullstack dispatch was given acceptance-criterion
 * targets, its result must report `payload.completedAcIds` — possibly `[]`, the
 * explicit "none completed" report — so a silently dropped key can no longer
 * lose every AC the dispatch implemented. The "ACs were targeted" signal is the
 * envelope-level `targetAcIds` the orchestrator stamps onto the persisted
 * result from its own dispatch context (the AC-5 assignment); it is never
 * agent-authored, so a forgetful agent cannot also drop the signal. Only an
 * absent key (undefined) reads as "no signal"; any present non-number[] value
 * — including null — fails closed rather than reading as "no targets". An
 * empty `targetAcIds` means the dispatch targeted nothing (matching
 * buildTargetAcSection, which renders no section for it) and adds no
 * requirement. The reported ids stay a *claim* — the AC-coverage gate (AC-2)
 * re-checks real trace evidence before verification-passed.
 * @param {Record<string, unknown>} record  The result envelope.
 * @returns {{ ok: true } | { ok: false, cause: string }}
 */
function assertCompletedAcIdsContract(record) {
  const targets = record.targetAcIds;
  if (targets === undefined) return { ok: true };
  if (!isNumberArray(targets)) {
    return {
      ok: false,
      cause:
        'result targetAcIds must be a number[] — it is the orchestrator-stamped dispatch AC assignment, not agent output',
    };
  }
  if (targets.length === 0) return { ok: true };

  const payload = record.payload;
  const payloadRecord =
    payload !== null && typeof payload === 'object'
      ? /** @type {Record<string, unknown>} */ (payload)
      : undefined;
  const completed = payloadRecord ? getOwn(payloadRecord, 'completedAcIds') : undefined;
  if (!isNumberArray(completed)) {
    return {
      ok: false,
      cause: 'fullstack result must report completedAcIds (possibly []) when ACs were targeted',
    };
  }
  return { ok: true };
}

/**
 * Asserts a dispatch result is non-empty and contains a valid contract.
 * Halts lane progression if validation fails.
 * @param {string} agentName - The name of the dispatched agent
 * @param {unknown} result - The raw dispatch result
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertDispatchResult(agentName, result) {
  const trimmedAgent = typeof agentName === 'string' ? agentName.trim() : '';
  if (trimmedAgent === '') {
    return fail('unknown-agent', 'agent name is required');
  }

  if (result === null || result === undefined) {
    return fail(trimmedAgent, 'result is empty or missing');
  }

  if (typeof result !== 'object') {
    return fail(trimmedAgent, `result must be an object, got ${typeof result}`);
  }

  const record = /** @type {Record<string, unknown>} */ (result);
  if (Object.keys(record).length === 0) {
    return fail(trimmedAgent, 'result is empty');
  }

  // @router has its own contract ({ lane, budgetClass, confidence }) with no
  // status/payload wrapper, so it is validated by parseRouterResult rather than
  // the generic status + REQUIRED_PAYLOAD_RULES path below. Resolve the persona
  // first so any aliased dispatch still routes here. Without this branch the
  // generic guard rejects every lane's Step 0 router dispatch — first on the
  // missing status field, then (if statused) as an unregistered agent.
  if (resolvePersona(trimmedAgent) === 'router') {
    const parsed = parseRouterResult(result);
    return parsed.ok ? { ok: true } : fail(trimmedAgent, parsed.error);
  }

  const status = record.status;
  if (typeof status !== 'string' || !VALID_STATUSES.has(/** @type {DispatchStatus} */ (status))) {
    return fail(trimmedAgent, 'missing or invalid status');
  }

  // Resolve persona to canonical agent name before the agentName equality
  // check. A fullstack agent returning agentName: 'fullstack' is valid even
  // when dispatched as 'frontend', 'backend', or 'editor'.
  const resolvedAgent = resolvePersona(trimmedAgent);

  if (
    typeof record.agentName === 'string' &&
    record.agentName.trim() !== '' &&
    record.agentName.trim() !== trimmedAgent &&
    record.agentName.trim() !== resolvedAgent
  ) {
    return fail(trimmedAgent, `result agentName '${record.agentName}' does not match dispatched agent`);
  }

  const payloadRule = getOwn(REQUIRED_PAYLOAD_RULES, resolvedAgent);
  if (!payloadRule) {
    return fail(trimmedAgent, 'no validator registered for agent');
  }

  if (status !== 'ok') {
    if (!hasPresentValue(record.reason) && !hasPresentValue(record.error)) {
      return fail(trimmedAgent, `status '${status}' requires reason or error`);
    }
    return { ok: true };
  }

  // AC-3: enforced before the artifactPath shortcut — an artifact pointer does
  // not substitute for the per-AC completion report the orchestrator records.
  if (resolvedAgent === 'fullstack') {
    const acVerdict = assertCompletedAcIdsContract(record);
    if (!acVerdict.ok) {
      return fail(trimmedAgent, acVerdict.cause);
    }
  }

  const { mode, keys: requiredPayloadKeys } = payloadRule;
  if (hasPresentValue(record.artifactPath)) {
    return { ok: true };
  }

  if (!hasArtifactOrPayload(record, mode, requiredPayloadKeys)) {
    const fieldSummary = requiredPayloadKeys.join('/');
    return fail(trimmedAgent, `missing artifactPath and payload.${fieldSummary}`);
  }

  return { ok: true };
}

/**
 * Whether a dispatched agent's `ok` result must be corroborated by a
 * `subagent_start` trace event before it validates. Resolves personas first, so
 * a `frontend`/`backend`/`editor` dispatch (all `fullstack` runs) is covered.
 * @param {string} agentName
 * @returns {boolean}
 */
export function isTraceBackedResultAgent(agentName) {
  const trimmed = typeof agentName === 'string' ? agentName.trim() : '';
  if (trimmed === '') return false;
  return TRACE_BACKED_RESULT_AGENTS.has(resolvePersona(trimmed));
}

/**
 * Dispatch-result guard *with proof of dispatch*. Runs the shape check
 * ({@link assertDispatchResult}) first; then, for a trace-backed agent
 * ({@link isTraceBackedResultAgent}) returning `status: 'ok'`, additionally
 * requires a `subagent_start` trace event proving a real subagent produced the
 * result. This closes the hole the shape-only guard leaves open: the
 * orchestrator writes the very artifact it then validates, so an empty or
 * malformed subagent reply becomes "reshape it until the validator passes"
 * instead of a hard stop.
 *
 * A non-`ok` result (already gated by its required reason/error) and any
 * non-trace-backed agent pass on the shape check alone.
 * @param {string} agentName
 * @param {unknown} result
 * @param {unknown} traceEvents  Parsed trace events for the task (e.g. its JSONL).
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertDispatchResultBacked(agentName, result, traceEvents) {
  const shape = assertDispatchResult(agentName, result);
  if (!shape.ok) return shape;

  const trimmedAgent = typeof agentName === 'string' ? agentName.trim() : '';
  if (!isTraceBackedResultAgent(trimmedAgent)) return { ok: true };

  // Only an `ok` result claims completed work worth gating; a blocked /
  // escalated / error result carries a reason and advances nothing.
  const status =
    result !== null && typeof result === 'object'
      ? /** @type {Record<string, unknown>} */ (result).status
      : undefined;
  if (status !== 'ok') return { ok: true };

  const resolved = resolvePersona(trimmedAgent);
  const dispatched = dispatchedAgentsFromTrace(traceEvents);
  if (!dispatched.has(resolved)) {
    return fail(
      trimmedAgent,
      `result is not backed by a dispatch — no subagent_start trace event for ` +
        `'${resolved}'. A dispatch result must come from a real subagent run, not ` +
        `be hand-authored to pass the validator. If the reply was empty or ` +
        `malformed, halt or re-dispatch — do not rewrite the result artifact.`,
    );
  }
  return { ok: true };
}

/**
 * Guard: fullstack dispatch is only allowed after implementation has started
 * and spec metadata is present in task state. The advisory CLI mirror
 * (scripts/orch-assert-fullstack.mjs) of the hook-enforced lane-gated dispatch
 * check (HITL-1): it delegates to the shared {@link evaluateImplementationDispatch}
 * so this feature-lane gate and the two runtime hooks share one predicate. Scope
 * and diagnosis facts are treated as satisfied here (this CLI path validates a
 * feature-lane state from disk, where only the gate and spec metadata are
 * derivable); the runtime hooks supply the real per-lane artifact facts.
 * @param {TaskState} state
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertFullstackDispatchAllowed(state) {
  const verdict = evaluateImplementationDispatch({
    agentName: 'fullstack',
    stateResult: { ok: true, state },
    scope: { present: true, nonEmpty: true },
    diagnosisValid: true,
  });
  return verdict.decision === 'allowed'
    ? { ok: true }
    : { ok: false, error: verdict.reason };
}

/**
 * Normalize a lane value from task state: trim, lowercase.
 * Returns '' when the value is null, undefined, or not a string.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeLane(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Map persona names to their canonical agents.
 * Handles cross-cutting personas that all dispatch to @fullstack with a persona context.
 * Not a preference: a semantic fact about the orchestrator's model of the system.
 * @type {Record<string, string>}
 */
export const PERSONA_MAP = {
  frontend: 'fullstack',
  backend: 'fullstack',
  editor: 'fullstack',
};

/**
 * Resolve an agent name using the persona canonicalization map.
 * @param {string} agentName
 * @returns {string}
 */
function resolvePersona(agentName) {
  const resolved = getOwn(PERSONA_MAP, agentName);
  return resolved ?? agentName;
}

/**
 * Assert every file a `@fullstack` dispatch changed is within its persona's
 * edit boundary.
 *
 * **This is the only per-worker edit boundary devmate has.** Gate-guard Rule 5 used
 * to claim it at the tool call and never once enforced it; #99 deleted it, because a
 * `PreToolUse` payload carries no agent identity, so an edit cannot be attributed to
 * one of several concurrent workers. A dispatch *result* can: it pairs `persona` with
 * `changedFiles` cleanly and parallel-safely. The persona reaches the checker on the
 * worker's own returned contract (`personaFromAgentResult`, lib/hooks/agent-result.mjs);
 * a dispatch that reports none fails closed at the caller.
 *
 * A file is a violation only when it is owned by a *different* declared persona
 * or matches this persona's `offLimitsGlobs` (see `filesOutsidePersonaScope`);
 * shared/unowned files are left to `scope.md`. Fails closed on an empty or
 * unknown persona (unlike the TDD tripwire) — `editableGlobs` is required, so a
 * declared persona always has a defined territory.
 *
 * @param {string} persona
 * @param {readonly string[]|undefined} changedFiles
 * @param {DevmateConfig} config
 * @returns {{ ok: boolean, error?: string, violations?: string[] }}
 */
export function assertPersonaScope(persona, changedFiles, config) {
  const p = typeof persona === 'string' ? persona.trim() : '';
  if (p === '') {
    return { ok: false, error: 'persona-scope: persona is required' };
  }
  if (
    !config ||
    !Array.isArray(config.personas) ||
    !config.personas.some((pe) => pe.persona === p)
  ) {
    return {
      ok: false,
      error: `persona-scope: unknown persona '${p}' — not declared in devmate.config.json`,
    };
  }
  const violations = filesOutsidePersonaScope(p, changedFiles ?? [], config);
  if (violations.length > 0) {
    // Name the glob that actually decided each rejection. This check is now the
    // ONLY per-worker boundary (#99 deleted gate-guard Rule 5, which carried this
    // detail at the tool call), so telling the caller to go read devmate.config.json
    // would be a round trip a human resents and an agent cannot make — it guesses,
    // and retries wrong. `explainOwnership` distinguishes the three causes:
    // off-limits, not-editable, or persona not declared at all.
    const why = violations.map((f) => `- ${explainOwnership(p, f, config)}`).join('\n');
    return {
      ok: false,
      error:
        `persona-scope: persona '${p}' edited files outside its scope: ${violations.join(', ')}.\n${why}\n` +
        'Check editableGlobs / offLimitsGlobs in .devmate/devmate.config.json.',
      violations,
    };
  }
  return { ok: true };
}

/**
 * Internal analysis gates/milestones and the specialist dispatch(es) that must
 * precede each one. A gate not listed here has no dispatch floor (always
 * passes). Feature-lane gates (`discovery-done`, `grill-done`, `plan-done`) and
 * the bug-lane `diagnosis-done` milestone are all covered so no lane can reach
 * its analysis checkpoint on inline work.
 *
 * This is the mirror of `assertDispatchResult`: that guard rejects a bad
 * *result*; this one rejects a gate advancing with *no dispatch at all* — i.e.
 * the orchestrator doing the analysis inline instead of delegating it, the
 * failure mode that fills the orchestrator's own context window and degrades
 * the model. Satisfying any one of a gate's listed agents clears its floor.
 * @type {Record<string, string[]>}
 */
export const GATE_DISPATCH_FLOOR = {
  'discovery-done': ['discovery', 'tech-design'],
  'grill-done': ['rubber-duck'],
  'plan-done': ['planner'],
  'diagnosis-done': ['diagnose'],
};

/**
 * Normalize a dispatched-agent name for floor matching: strip a leading '@',
 * a trailing '.agent', lowercase, trim, and canonicalize personas. Exported so
 * the lane-gated dispatch check (lib/workflow/dispatch-gate.mjs) canonicalizes
 * agent names identically.
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeDispatchedAgent(name) {
  if (typeof name !== 'string') return '';
  let normalized = name.trim().toLowerCase();
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized.endsWith('.agent')) normalized = normalized.slice(0, -'.agent'.length);
  return resolvePersona(normalized.trim());
}

/**
 * Collect the set of specialist agents that actually started, from a task's
 * trace events (`subagent_start` events appended by the sub-agent budget guard).
 * @param {unknown} traceEvents
 * @returns {Set<string>}
 */
export function dispatchedAgentsFromTrace(traceEvents) {
  /** @type {Set<string>} */
  const dispatched = new Set();
  if (!Array.isArray(traceEvents)) return dispatched;
  for (const event of traceEvents) {
    if (event === null || typeof event !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (event);
    if (record.type !== 'subagent_start') continue;
    const name = normalizeDispatchedAgent(record.agentName);
    if (name !== '') dispatched.add(name);
  }
  return dispatched;
}

/**
 * Dispatch floor: an internal analysis gate may only auto-advance once the
 * specialist that owns that gate's work has actually been dispatched (a
 * `subagent_start` trace event exists for it). This blocks the orchestrator
 * from doing discovery / grilling / planning inline and then advancing the
 * gate — the reported failure that fills the orchestrator's own context window
 * and degrades the model. A gate with no registered floor always passes.
 * @param {{ gate?: unknown, traceEvents?: unknown }} args
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertDispatchFloor(args) {
  const gate = args !== null && typeof args === 'object' ? args.gate : undefined;
  const gateName = typeof gate === 'string' ? gate.trim() : '';
  if (gateName === '') {
    return { ok: false, error: 'dispatch-floor: gate is required' };
  }

  const required = getOwn(GATE_DISPATCH_FLOOR, gateName);
  if (!required) {
    return { ok: true };
  }

  const traceEvents =
    args !== null && typeof args === 'object' ? args.traceEvents : undefined;
  const dispatched = dispatchedAgentsFromTrace(traceEvents);
  const satisfied = required.some((agent) => dispatched.has(agent));
  if (!satisfied) {
    return {
      ok: false,
      error:
        `dispatch-floor: gate '${gateName}' cannot advance — no subagent_start ` +
        `trace event for any of [${required.join(', ')}]. Dispatch the specialist ` +
        `(do not do this work inline) before advancing the gate.`,
    };
  }
  return { ok: true };
}

/**
 * Per-lane analysis dispatches that must precede the start of implementation —
 * the per-gate GATE_DISPATCH_FLOOR aggregated to the `impl-started` boundary.
 * Each inner array is an any-of group (satisfy one). A lane with an empty list
 * (chore has no analysis phase) has no floor. Used by the opt-in runtime
 * enforcement in the `impl-started` gate precondition.
 * @type {Record<string, string[][]>}
 */
export const LANE_DISPATCH_REQUIREMENTS = {
  feature: [['discovery', 'tech-design'], ['rubber-duck'], ['planner']],
  bug: [['diagnose'], ['rubber-duck']],
  chore: [],
};

/**
 * Which of a lane's required analysis dispatch-groups have no matching
 * `subagent_start` trace event. An empty result means the delegation floor is
 * satisfied (or the lane has no floor).
 *
 * `requirementsOverride` (from devmate.config.json `delegationFloorRequirements`)
 * replaces the built-in {@link LANE_DISPATCH_REQUIREMENTS} for any lane it names,
 * so a repo can tune which specialists the floor requires; lanes it does not name
 * keep the defaults.
 * @param {string} lane
 * @param {unknown} traceEvents
 * @param {unknown} [requirementsOverride]  Record<lane, string[][]> from config.
 * @returns {string[]}  Unsatisfied groups, each rendered as 'a|b'.
 */
export function missingLaneDispatches(lane, traceEvents, requirementsOverride) {
  const override =
    requirementsOverride !== null && typeof requirementsOverride === 'object'
      ? getOwn(/** @type {Record<string, unknown>} */ (requirementsOverride), lane)
      : undefined;
  // The config validator guarantees string[][] shape; the runtime filter below
  // stays defensive against a malformed override that slipped through.
  const groups = /** @type {string[][]} */ (
    Array.isArray(override) ? override : (getOwn(LANE_DISPATCH_REQUIREMENTS, lane) ?? [])
  );
  if (groups.length === 0) return [];
  const dispatched = dispatchedAgentsFromTrace(traceEvents);
  return groups
    .filter((group) => Array.isArray(group) && group.length > 0)
    .filter((group) => !group.some((agent) => dispatched.has(agent)))
    .map((group) => group.join('|'));
}


