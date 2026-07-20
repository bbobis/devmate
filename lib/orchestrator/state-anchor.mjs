// @ts-check

/**
 * E10-02: model-visible workflow-state anchor.
 *
 * Builds the compact `<devmate-state>` context block that the UserPromptSubmit
 * hook (hooks/approval-listener.mjs) and the SessionStart hook
 * (scripts/session-start.mjs) print to stdout on every turn, so the
 * orchestrator is re-anchored to the durable gate/lane/step persisted in
 * `.devmate/state/task.json` instead of relying on a lane script that has
 * scrolled out of context. Grounded in docs/research/orchestrator-redesign.md
 * (R2): stdout from those two hook events is added to context the model can
 * see and act on, so the block steers interpretation without rewriting the
 * user's message.
 *
 * Pure module: no I/O, no clock, no process state. Legal next gates come from
 * the unified transition table in lib/gate-transitions.mjs — never a
 * duplicated list.
 */

import { legalTransitions, reachableGates } from '../gate-transitions.mjs';
import { approvalPhraseForGate, REVISE_SPEC_PREFIX, RESET_TASK } from '../routing/approval-phrases.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */

/** Opening tag of the anchor block. */
export const ANCHOR_OPEN_TAG = '<devmate-state>';

/** Closing tag of the anchor block. */
export const ANCHOR_CLOSE_TAG = '</devmate-state>';

// TODO: calibrate anchor throttle after usage telemetry — provisional
/**
 * Turn cadence for re-emitting the full anchor block between human gates:
 * once a turn counter is wired, the full block is emitted at human-decision
 * gates and every N turns, with the compact one-liner otherwise.
 * @type {number}
 */
export const FULL_ANCHOR_TURN_CADENCE = 5;

/**
 * Gates at which a human decision is pending. The full anchor block is always
 * emitted at these gates regardless of the turn cadence, because that is where
 * off-script input is most likely to derail the workflow.
 * @type {readonly WorkflowGate[]}
 */
export const HUMAN_DECISION_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (['spec-draft', 'pr-ready']),
);

/**
 * Standing reminder rendered as the last field of the full block. Complements
 * the E10-01 gate conversation protocol: the anchor tells the model to apply
 * it to the raw user message instead of expecting magic phrases.
 * @type {string}
 */
const REMINDER =
  'reminder: interpret this user message against the workflow state above before acting. ' +
  'Approval must be explicit; treat free-form change requests as revision feedback, ' +
  'and answer questions without advancing the gate.';

/**
 * Resolve the legal next gates for the anchor: an explicit override wins,
 * otherwise the canonical transition table is projected for the state's current
 * gate, LANE-AWARE (#195). Since #156 the orchestrator treats this list as the
 * authoritative bound on its next move, so it must match exactly what the gate
 * machine accepts for `state.lane` — the anchor previously used the lane-AGNOSTIC
 * `flattenTransitions()` union.
 *
 * `legalTransitions` alone is not enough: it unions the lane-agnostic
 * `LINEAR_SPINE`, which pulls cross-lane gates the validator rejects (e.g.
 * `discovery-done` onto the bug lane at `lane-set`, or the feature-only steering
 * targets `spec-draft`/`plan-done` onto a bug task at `impl-started`). So the
 * successors are filtered to the gates actually reachable on this lane
 * (`reachableGates`, the same BFS built to avoid the spine's cross-lane pull) —
 * leaving exactly the successors a `(state.lane, gate)` pair validates against.
 * @param {TaskState} state
 * @param {{ pendingArtifact?: string, legalNext?: string[] }} opts
 * @returns {string[]}
 */
function resolveLegalNext(state, opts) {
  if (Array.isArray(opts.legalNext)) return opts.legalNext;
  const reachable = reachableGates(state.lane);
  return legalTransitions(state.lane, state.workflowGate).filter((gate) => reachable.has(gate));
}

/**
 * Render the legal-next field line.
 * @param {string[]} legalNext
 * @returns {string}
 */
function renderLegalNext(legalNext) {
  return legalNext.length > 0
    ? `legal next gates: ${legalNext.join(', ')}`
    : 'legal next gates: (none — terminal gate)';
}

/**
 * #125: render the exact phrase(s) the human can type at the current gate,
 * or null when no human phrase fires here. The gate names above tell the
 * model where the workflow stands; this line is the only place the HUMAN
 * learns the literal string that moves it — `hooks/approval-listener.mjs`
 * matches these phrases exactly, and nothing else fires a human gate.
 * Phrases come from the single source in lib/routing/approval-phrases.mjs,
 * never inlined here.
 * @param {TaskState} state
 * @returns {string|null}
 */
function renderApprovalPhrase(state) {
  const phrase = approvalPhraseForGate(state.workflowGate, state.lane);
  if (phrase === null) return null;
  // "reply with", not "type": the word "type" before an interpolation trips
  // the GraphQL-injection lint heuristic (it is a GraphQL keyword).
  const head = `to proceed, the human must reply with exactly: "${phrase}"`;
  // The spec review GATE also accepts a revision request — keyed off the
  // gate, not the phrase value, because the revise move belongs to
  // spec-draft itself. Surface both moves so a rejection is as discoverable
  // as an approval.
  if (state.workflowGate === 'spec-draft') {
    return `${head} — or request changes with: "${REVISE_SPEC_PREFIX} <feedback>"`;
  }
  return head;
}

/** @typedef {import('../types.mjs').ImplProgress} ImplProgress */

/**
 * Render the implementation-progress field line from an ImplProgress summary.
 * @param {ImplProgress} progress
 * @returns {string}
 */
function renderImplProgress(progress) {
  const head = `implementation: ${progress.done}/${progress.total} ACs complete`;
  return progress.nextId !== null
    ? `${head} (next AC${progress.nextId}: ${progress.nextLabel})`
    : `${head} (all ACs complete)`;
}

/** @typedef {import('../task-staleness.mjs').Staleness} Staleness */
/** @typedef {import('../gate-consistency.mjs').GateConsistencyResult} GateConsistencyResult */

/**
 * Render the single-line gate-desync field. Fires when gate-evidence
 * consistency detection (lib/gate-consistency.mjs) finds the persisted gate is
 * not backed by the artifacts/trace it legally requires (manual task.json
 * tampering, a forged approval, or a state/trace divergence). One line by
 * design: name the divergences, the last evidence-backed gate to roll back to,
 * and the recovery command — dispatch stays denied until it is reconciled.
 * @param {GateConsistencyResult} consistency
 * @returns {string}
 */
function renderDesync(consistency) {
  const kinds = consistency.divergences.join(', ');
  const cmd = consistency.recommendedCommand
    ? ` — run: ${consistency.recommendedCommand.split('#')[0].trim()}`
    : '';
  return (
    `state: desynced (${kinds}) — persisted gate "${consistency.gate}" is not evidence-backed; ` +
    `last evidence-backed gate "${consistency.evidenceBackedGate}". ` +
    `Dispatch stays denied until reconciled${cmd}.`
  );
}

/**
 * Render the staleness field line. Surfaces the fact + the auto-park steer so
 * an unrelated new task is not blocked on an interrogation about a
 * likely-abandoned workflow.
 * @param {Staleness} staleness
 * @returns {string}
 */
function renderStaleness(staleness) {
  return (
    `staleness: STALE — this workflow has been idle ~${Math.round(staleness.idleHours)}h and is likely abandoned. ` +
    'On a new, unrelated request, auto-park it (record a resume-pointer) and start the new task; ' +
    'do not interrogate park/abandon/continue.'
  );
}

/** Build the model-visible workflow-state anchor block.
 * @param {import('../types.mjs').TaskState} state  Current task state.
 * @param {{ pendingArtifact?: string, legalNext?: string[], implProgress?: ImplProgress, staleness?: Staleness, consistency?: GateConsistencyResult }} [opts]
 * @returns {string}  A `<devmate-state>…</devmate-state>` block, one field per line.
 */
export function buildStateAnchor(state, opts = {}) {
  const lines = [
    ANCHOR_OPEN_TAG,
    `taskId: ${state.taskId}`,
    `lane: ${state.lane}`,
    `gate: ${state.workflowGate}`,
    `step: ${state.currentStep}`,
  ];
  // Surface a gate/evidence desync loudly and early: a tampered or forged gate
  // must be visible before anything else in the block acts on it.
  if (opts.consistency && !opts.consistency.ok) {
    lines.push(renderDesync(opts.consistency));
  }
  // Surface per-AC implementation progress so a resumed/compacted session
  // re-anchors to which acceptance criteria remain, not just the coarse gate.
  if (opts.implProgress && opts.implProgress.total > 0) {
    lines.push(renderImplProgress(opts.implProgress));
  }
  // Surface staleness so a days-old in-flight task auto-parks for a new task
  // instead of forcing a park/abandon interrogation.
  if (opts.staleness && opts.staleness.stale) {
    lines.push(renderStaleness(opts.staleness));
  }
  if (typeof opts.pendingArtifact === 'string' && opts.pendingArtifact.trim() !== '') {
    lines.push(`pending: ${opts.pendingArtifact.trim()}`);
  }
  lines.push(renderLegalNext(resolveLegalNext(state, opts)));
  // #125: name the literal phrase that fires the current human gate — the
  // gate list above is meaningless to a user who cannot discover the string
  // "approve spec" is required character-for-character.
  const phraseLine = renderApprovalPhrase(state);
  if (phraseLine !== null) lines.push(phraseLine);
  lines.push(REMINDER);
  lines.push(ANCHOR_CLOSE_TAG);
  return lines.join('\n');
}

/**
 * #171: the model-visible anchor for an UNREADABLE task.json — the corruption
 * counterpart of {@link buildStateAnchor}. The normal anchor needs a valid
 * TaskState to render lane/gate/legal-next; when the state cannot be read
 * (hand-edited into an illegal (lane, gate) pair — the #129 case — or malformed
 * JSON), the anchor sites used to no-op silently, conflating corruption with a
 * legitimate no-task session. This surfaces the validateTaskState diagnostics
 * VERBATIM plus a recovery instruction, on the same `<devmate-state>` channel the
 * model reads, so a human who hand-edited task.json to get unstuck is not left
 * with a workflow that is quietly broken.
 * @param {readonly string[]} errors  readTaskState / validateTaskState messages.
 * @returns {string}  A `<devmate-state>…</devmate-state>` block.
 */
export function buildUnreadableStateAnchor(errors) {
  const joined = errors.length > 0 ? errors.join('; ') : 'task state could not be read';
  // Collapse any whitespace run (incl. newlines) to a single space so the error
  // stays ONE line. A validateTaskState message can echo a hand-edited task.json
  // field value (e.g. an `artifactHashes` key), which could carry a real newline —
  // left raw, it would break the `<devmate-state>` block into fake fields or close
  // the tag early. task.json is a trusted local file, so this is structure
  // hygiene, not a trust boundary, but the block must stay well-formed regardless.
  const detail = joined.replace(/\s+/g, ' ').trim();
  return [
    ANCHOR_OPEN_TAG,
    'state: unreadable',
    `error: ${detail}`,
    'recovery: .devmate/state/task.json is corrupt or hand-edited into an illegal (lane, gate) pair. ' +
      `Reconcile it to a legal pair, or reply "${RESET_TASK}" to quarantine it (the original is ` +
      'preserved as a .corrupt-<ts> sidecar for diagnosis) and start a fresh task — devmate will not ' +
      'advance the gate until the state validates.',
    ANCHOR_CLOSE_TAG,
  ].join('\n');
}

/**
 * Compact one-line variant of the anchor, used between full blocks once the
 * provisional turn cadence is wired to a real turn counter (see
 * {@link FULL_ANCHOR_TURN_CADENCE}). Carries the same identifying fields but
 * drops pending/legal-next/reminder detail.
 * @param {TaskState} state
 * @returns {string}
 */
export function buildStateAnchorLine(state) {
  return `devmate-state: taskId ${state.taskId} | lane ${state.lane} | gate ${state.workflowGate} | step ${state.currentStep}`;
}

/**
 * Throttle policy for anchor verbosity: emit the full block at human-decision
 * gates and every {@link FULL_ANCHOR_TURN_CADENCE} turns, the one-liner
 * otherwise. Pure decision helper — callers supply the turn distance since the
 * last full block (no turn counter is persisted yet; until one exists, callers
 * emit the full block on every turn).
 * @param {TaskState} state  Current task state.
 * @param {number} turnsSinceFullAnchor  Turns elapsed since the last full block.
 * @returns {boolean}  True when the full block should be emitted this turn.
 */
export function shouldEmitFullAnchor(state, turnsSinceFullAnchor) {
  if (HUMAN_DECISION_GATES.includes(state.workflowGate)) return true;
  return turnsSinceFullAnchor >= FULL_ANCHOR_TURN_CADENCE;
}
