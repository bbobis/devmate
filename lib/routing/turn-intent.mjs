// @ts-check

/**
 * E10-4: per-turn intent router — the deterministic (zero-cost) fast path.
 *
 * `@router` classifies the *lane* exactly once, on the first message. Every
 * later in-flight message still needs a routing decision: is it an approval
 * in other words, a revision, a scope change, a question, or just chat?
 * This module owns the shared intent vocabulary and Stage 1 of the two-stage
 * turn router (grounded in `docs/research/orchestrator-redesign.md` R4):
 *
 *   - Stage 1 (here, ~0 ms): exact approval/revision phrases, and the
 *     trivial `new-task` call when no workflow is in flight (gate is
 *     `no-lane` or `done`). Anything else returns `null`.
 *   - Stage 2 (LLM): the orchestrator prompt ("Turn routing" preamble in
 *     `agents/orchestrator.agent.md`) classifies deferred turns as a
 *     structured intent object, validated by {@link parseTurnIntentResult}.
 *
 * The exact phrases mirror `hooks/approval-listener.mjs` — the hook stays
 * the single actor that *applies* approval phrases; this module only labels
 * them so the intent can be persisted and surfaced.
 */

import { MIN_ROUTER_CONFIDENCE } from './router.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */

/**
 * The full turn-intent vocabulary. Every in-flight user message is labelled
 * with exactly one of these.
 * @typedef {'new-task'|'approve-gate'|'revise-artifact'|'steer-scope'|'question'|'status'|'abandon'|'chat'} TurnIntent
 */

/**
 * The artifact a turn targets, when the intent acts on one. `null` when the
 * turn has no target artifact (e.g. question/status/chat).
 * @typedef {'spec'|'plan'|'diagnosis'|'pr'|null} TurnTargetArtifact
 */

/**
 * @typedef {object} TurnIntentResult
 * @property {TurnIntent} intent               Classified turn intent.
 * @property {number} confidence               0–1 confidence score.
 * @property {TurnTargetArtifact} targetArtifact Artifact the turn acts on, or null.
 */

/**
 * Canonical turn-intent vocabulary (the enum).
 * @type {readonly TurnIntent[]}
 */
export const TURN_INTENTS = Object.freeze([
  'new-task',
  'approve-gate',
  'revise-artifact',
  'steer-scope',
  'question',
  'status',
  'abandon',
  'chat',
]);

/**
 * Minimum turn-intent confidence to auto-act without asking the human.
 * Reuses the router's escalation convention so there is one shared
 * threshold semantics (below it: at a human gate default to revision,
 * elsewhere ask the human).
 * @type {number}
 */
// TODO: calibrate turn-intent confidence floor after telemetry — provisional
export const MIN_TURN_INTENT_CONFIDENCE = MIN_ROUTER_CONFIDENCE;

/**
 * Exact approval phrases (lower-cased, trimmed) that deterministically mean
 * "approve the pending human gate". Mirrors the phrase literals applied by
 * `hooks/approval-listener.mjs`; keep the two in sync.
 * @type {ReadonlySet<string>}
 */
const APPROVE_PHRASES = new Set(['approve spec', 'approve pr']);

/**
 * Exact revision-phrase prefix (lower-cased). Mirrors the approval
 * listener's revise handling.
 */
const REVISE_PREFIX = 'revise spec:';

/**
 * Gates with no workflow in flight: any message here starts a new task.
 * @type {ReadonlySet<WorkflowGate>}
 */
const NO_TASK_IN_FLIGHT_GATES = new Set(
  /** @type {WorkflowGate[]} */ (['no-lane', 'done'])
);

/** Confidence assigned to deterministic (rule-based) classifications. */
const DETERMINISTIC_CONFIDENCE = 1;

/** Valid non-null target artifacts for {@link parseTurnIntentResult}. */
const VALID_TARGET_ARTIFACTS = new Set(['spec', 'plan', 'diagnosis', 'pr']);

/**
 * Zero-cost deterministic turn classification; null → defer to the LLM.
 *
 * Rules, in order:
 *  1. An exact approval phrase ("approve spec" / "approve pr", case- and
 *     whitespace-insensitive) is `approve-gate` — the user's act is explicit
 *     regardless of gate; legality is enforced by the action layer.
 *  2. An exact revision phrase ("revise spec: <feedback>") is
 *     `revise-artifact`.
 *  3. When the gate is `no-lane` or `done` there is nothing in flight, so
 *     the message is trivially `new-task`.
 *  4. Everything else (free-form change requests, questions, chit-chat)
 *     returns `null`: the LLM stage must decide.
 *
 * @param {string} prompt  Raw user message.
 * @param {import('../types.mjs').TaskState} state  Current task state (for gate context).
 * @returns {{ intent: TurnIntent, confidence: number } | null}
 */
export function classifyTurnDeterministic(prompt, state) {
  const raw = typeof prompt === 'string' ? prompt.trim() : '';
  if (raw === '') return null;

  const lower = raw.toLowerCase();
  if (APPROVE_PHRASES.has(lower)) {
    return { intent: 'approve-gate', confidence: DETERMINISTIC_CONFIDENCE };
  }
  if (lower.startsWith(REVISE_PREFIX)) {
    return { intent: 'revise-artifact', confidence: DETERMINISTIC_CONFIDENCE };
  }
  if (NO_TASK_IN_FLIGHT_GATES.has(state.workflowGate)) {
    return { intent: 'new-task', confidence: DETERMINISTIC_CONFIDENCE };
  }
  return null;
}

/**
 * Parse and validate a raw turn-intent object emitted by the orchestrator's
 * LLM classification stage (Stage 2). Mirrors the structured-output
 * validation shape of `parseRouterResult` in `lib/routing/router.mjs`.
 * Returns { ok: false, error } when required fields are missing or invalid.
 * A missing `targetArtifact` is accepted and normalised to `null`.
 * @param {unknown} raw
 * @returns {{ ok: true, result: TurnIntentResult } | { ok: false, error: string }}
 */
export function parseTurnIntentResult(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: `Turn intent result must be a JSON object, got ${typeof raw}`,
    };
  }

  const result = /** @type {Record<string, unknown>} */ (raw);

  // Validate intent
  const intent = result.intent;
  if (typeof intent !== 'string' || !TURN_INTENTS.includes(/** @type {TurnIntent} */ (intent))) {
    return {
      ok: false,
      error: `Turn intent must be one of [${TURN_INTENTS.join(', ')}], got ${JSON.stringify(intent)}`,
    };
  }

  // Validate confidence
  const confidence = result.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      ok: false,
      error: `Turn intent confidence must be a finite number between 0 and 1, got ${JSON.stringify(confidence)}`,
    };
  }

  // Validate targetArtifact (optional; absent or null → null)
  const targetArtifact = result.targetArtifact ?? null;
  if (targetArtifact !== null && (typeof targetArtifact !== 'string' || !VALID_TARGET_ARTIFACTS.has(targetArtifact))) {
    return {
      ok: false,
      error: `Turn intent targetArtifact must be one of ["spec", "plan", "diagnosis", "pr"] or null, got ${JSON.stringify(targetArtifact)}`,
    };
  }

  return {
    ok: true,
    result: {
      intent: /** @type {TurnIntent} */ (intent),
      confidence,
      targetArtifact: /** @type {TurnTargetArtifact} */ (targetArtifact),
    },
  };
}
