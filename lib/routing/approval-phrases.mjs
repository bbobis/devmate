// @ts-check

/**
 * #125: the single source of truth for the human approval-phrase literals.
 *
 * `hooks/approval-listener.mjs` (the only actor that APPLIES a phrase) and
 * `lib/routing/turn-intent.mjs` (which only LABELS one) each carried their own
 * copies with a "keep the two in sync" comment — a drift class, not a
 * guarantee. Worse, nothing model-visible ever enumerated the literals: the
 * state anchor listed legal next *gates*, and a human had no way to discover
 * that the exact string "approve spec" — character for character — is what
 * fires one. Both consumers now import from here, and the state anchor
 * (`lib/orchestrator/state-anchor.mjs`) surfaces the phrase for the current
 * gate via {@link approvalPhraseForGate}.
 *
 * Pure constants module: no I/O, safe for every consumer.
 */

import { getOwn } from "../object-utils.mjs";

/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../types.mjs').Lane} Lane */

/** Approval phrase literals (lower-cased, trimmed). */
export const APPROVE_SPEC = "approve spec";
export const APPROVE_PR = "approve pr";
export const APPROVE_PLAN = "approve plan";
export const REVISE_SPEC_PREFIX = "revise spec:";
export const NO_TDD_PREFIX = "approve no-tdd";

/**
 * #127: the mid-implementation steering prefixes (feature lane) — fire
 * `steerFeature` from the approval listener: impl-started -> spec-draft
 * (revise-scope) and impl-started -> plan-done (re-plan).
 */
export const REVISE_SCOPE_PREFIX = "revise scope:";
export const RE_PLAN_PREFIX = "re-plan:";

/**
 * #130: the chore-escalation phrase (docs/chore-escalation.md) — lane
 * chore -> feature re-entering at plan-approved. A reason is required
 * (`escalate chore to feature: <reason>`, mirroring the escalate-chore CLI's
 * --reason flag); the listener enforces a word boundary after the prefix and
 * an in-flight chore gate.
 */
export const ESCALATE_CHORE_PREFIX = "escalate chore to feature";

/**
 * #191: the corrupt-state recovery phrase. When `task.json` is CORRUPT (malformed
 * JSON / shape-invalid), the `<devmate-state>` unreadable anchor surfaces the
 * diagnostic and names this phrase; typing it quarantines the corrupt file
 * (preserved as a `.corrupt-<ts>` sidecar) and starts a fresh task. It is a no-op
 * refusal on a valid, absent, or merely-unreadable state — it never discards a
 * healthy task. Not a gate approval; the listener handles it like a command.
 */
export const RESET_TASK = "reset task";

/**
 * The exact phrase a human must type at each gate where a human approval is
 * the move that advances the workflow. Keyed by the gate the task is AT when
 * the phrase fires (not the gate it advances to):
 *
 *   spec-draft          -> "approve spec"  (feature lane's spec review)
 *   plan-approved       -> "approve plan"  (bug/chore lanes only — see
 *                          {@link approvalPhraseForGate}; the feature lane's
 *                          plan-approved row accepts only draft-spec, so
 *                          surfacing "approve plan" there would advertise a
 *                          phrase the transition table refuses (HITL-2))
 *   verification-passed -> "approve pr"
 *
 * @type {Readonly<Partial<Record<WorkflowGate, string>>>}
 */
export const HUMAN_GATE_PHRASES = Object.freeze({
  "spec-draft": APPROVE_SPEC,
  "plan-approved": APPROVE_PLAN,
  "verification-passed": APPROVE_PR,
});

/**
 * Resolve the approval phrase available at the given (gate, lane), or null
 * when no human phrase fires there. Lane-aware where the map alone cannot be:
 * "approve plan" is a bug/chore move (their `plan-approved -> impl-started`
 * edge); on the feature lane the same gate's only legal exit is `draft-spec`,
 * driven by evidence, not by a phrase. Symmetrically, "approve pr" is a
 * feature/bug move: the chore lane's only exit from `verification-passed` is
 * `complete -> done` — chore never enters `pr-ready`
 * (`lib/gate-transitions.mjs`), so advertising the phrase there would walk a
 * chore task into a gate the lane is documented never to reach.
 * @param {WorkflowGate} gate
 * @param {Lane} lane
 * @returns {string|null}
 */
export function approvalPhraseForGate(gate, lane) {
  if (gate === "plan-approved" && lane === "feature") return null;
  if (gate === "verification-passed" && lane === "chore") return null;
  return getOwn(HUMAN_GATE_PHRASES, gate) ?? null;
}
