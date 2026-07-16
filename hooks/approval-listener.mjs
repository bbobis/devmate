// @ts-check

/**
 * E10-2: UserPromptSubmit hook that intercepts human-typed approval phrases
 * and drives the correct workflow gate transition via `gatectl`. Unknown
 * phrases pass through untouched so normal chat is unaffected.
 *
 * Recognised phrases (case-insensitive, leading/trailing whitespace trimmed):
 *
 *   approve plan                 -> plan-approved       -> impl-started  (bug/chore ONLY)
 *   approve spec                 -> spec-draft          -> spec-approved -> impl-started
 *   approve pr                   -> verification-passed -> pr-ready
 *   revise spec: <feedback>      -> stays in spec-draft, emits spec_revision_requested
 *   approve no-tdd reason="..."  -> writes no_tdd_override trace event + spec.md note
 *
 * E10-03: exact-phrase matching is not a "fast path" — it is the ONLY path. The
 * orchestrator declares no `execute` tool, so it can never issue a gate advance
 * itself; the `gatectl workflow approve` command its prompt used to name was
 * inert, which is why the bug and chore lanes could not reach `impl-started` at
 * all and simply dead-ended at `plan-approved`. A gate moves here, in the host, on
 * a human's prompt — or it does not move. This hook stamps
 * `actor: "hook-exact-phrase"` with the raw prompt as `evidence`.
 *
 * Doc reference (UserPromptSubmit event name):
 *   https://code.visualstudio.com/docs/copilot/customization/hooks
 *
 * E10-02: independently of phrase matching, the handler always prints a
 * model-visible `<devmate-state>` anchor block (current gate, lane, step,
 * legal next transitions read from task.json + the unified transition table)
 * to stdout, so the orchestrator is re-anchored to the durable workflow state
 * on every turn. Stdout of this event is added to context the model can see;
 * the hook cannot (and does not) rewrite the user's message.
 *
 * The handler is a function that takes the event payload and returns a
 * structured `HookResult` describing what it did. It does *not* read VS Code
 * environment variables; the CLI shim at the bottom of this file shapes
 * `UserPromptSubmitEvent` from the official stdin JSON.
 */

import path from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { createTextCapture, writeHookOutput } from "../lib/hooks/output-schema.mjs";
import { resolvePluginRoot } from "../lib/plugin-root.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import {
  ensureDir,
  pathExists,
  readTextFile,
  removeFile,
  renamePath,
  statPathSync,
  writeTextFile,
} from "../lib/fs-safe.mjs";
import { advanceHumanGate } from "../lib/gatectl.mjs";
import { continueApprovedFeature } from "../lib/workflow/lanes/feature.mjs";
import { transitionGate } from "../lib/gate-transitions.mjs";
import { buildStateAnchor } from "../lib/orchestrator/state-anchor.mjs";
import { checkGateConsistency } from "../lib/gate-consistency.mjs";
import {
  loadDevmateConfig,
  resolveStaleTaskHours,
} from "../lib/config/devmate-config.mjs";
import { evaluateStaleness } from "../lib/task-staleness.mjs";
import {
  readTaskState,
  STATE_PATH,
  writeTaskState,
} from "../lib/task-state.mjs";
import { appendTraceEvent } from "../lib/trace/append.mjs";
import { readTrace } from "../lib/trace/read-trace.mjs";
import {
  completedAcNumbers,
  summarizeImplProgress,
} from "../lib/spec-progress.mjs";
import { loadMergedSkillManifests } from "../lib/skills/skill-manifest.mjs";
import { scoreAll } from "../lib/skills/semantic-matcher.mjs";
import { selectWithContext } from "../lib/skills/context-rank.mjs";
import {
  SKILL_MATCH_TOP_N,
  SKILL_MATCH_MIN_CONFIDENCE,
} from "../lib/skills/operating-point.mjs";
import { recordSkillDecision } from "../lib/skills/decision-ledger.mjs";
import { buildSkillMenu, shouldEmitMenu } from "../lib/skills/skill-menu.mjs";
import { classifyTurnDeterministic } from "../lib/routing/turn-intent.mjs";
import { resolveActiveDomains } from "../lib/context/domain-resolver.mjs";

/** Trace schema version this hook emits. */
const SCHEMA_VERSION = 1;

/** Step id stamped on every trace event written by this hook. */
const STEP_ID = "approval-listener";

/**
 * Actor stamped on gate_transition events written by the exact-phrase fast
 * path (E10-03), so hook-driven advances are distinguishable from
 * orchestrator-issued `gatectl workflow approve` advances in the trace.
 */
const HOOK_ACTOR = "hook-exact-phrase";

/** @typedef {import('../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../lib/types.mjs').TaskState} TaskState */

/**
 * Hook event payload accepted by `handleUserPromptSubmit`.
 * @typedef {Object} UserPromptSubmitEvent
 * @property {string} prompt        Raw user-typed prompt text.
 * @property {string} [taskId]      Optional override; otherwise read from task.json.
 * @property {string} [root]        Optional repo root (tests inject a tmp dir).
 * @property {NodeJS.WritableStream} [stdout]  Stream for model-visible output
 *                                  (tests inject a capture stream); defaults to
 *                                  process.stdout.
 */

/**
 * Structured result returned by the hook.
 * @typedef {Object} HookResult
 * @property {'passthrough'|'gate_advanced'|'revision_requested'|'no_tdd_override'} action
 * @property {WorkflowGate} [gate]     The gate that was set when action is gate_advanced.
 * @property {string} [feedback]       Revision feedback payload when action is revision_requested.
 * @property {string} [reason]         No-TDD justification when action is no_tdd_override.
 */

/** Approval phrase literals (lower-cased, trimmed). */
const APPROVE_SPEC = "approve spec";
const APPROVE_PR = "approve pr";
/**
 * Bug/chore lanes: the human approval that opens implementation.
 *
 * These two lanes have no spec gate — their `plan-approved -> impl-started` move
 * was performed by `gatectl workflow set start-impl`, a command the orchestrator
 * prompt instructed but could never run (it declares no `execute` tool). So the
 * gate never moved, `@fullstack` could never be dispatched, and both lanes were
 * dead ends. The orchestrator still cannot advance its own gate — only this
 * hook, on a human's UserPromptSubmit, can.
 */
const APPROVE_PLAN = "approve plan";
const REVISE_SPEC_PREFIX = "revise spec:";
const NO_TDD_PREFIX = "approve no-tdd";

/**
 * Parse the `reason="..."` value out of an `approve no-tdd reason="..."`
 * prompt. Returns the reason string (without surrounding quotes) or `null`
 * when the prompt is missing the reason value.
 * @param {string} raw Original (un-lowercased) prompt text, trimmed.
 * @returns {string|null}
 */
export function parseNoTddReason(raw) {
  const match = /reason\s*=\s*"([^"]*)"/i.exec(raw);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

/**
 * Extract the feedback payload from a `revise spec: <feedback>` prompt.
 * Preserves the original casing of the feedback (only the phrase prefix is
 * matched case-insensitively).
 * @param {string} raw Original (un-lowercased) prompt text, trimmed.
 * @returns {string}
 */
export function parseReviseSpecFeedback(raw) {
  const colonIndex = raw.indexOf(":");
  if (colonIndex === -1) return "";
  return raw.slice(colonIndex + 1).trim();
}


/**
 * Append a `gate_transition` trace event for the active task. Human-gate
 * advances (E10-03) carry the audit pair: `actor` names the issuing path and
 * `evidence` is the verbatim human message that approved the transition.
 * @param {string} taskId
 * @param {WorkflowGate} from
 * @param {WorkflowGate} to
 * @param {string} root
 * @param {{ actor: string, evidence: string }} audit
 * @returns {Promise<void>}
 */
async function recordGateTransition(taskId, from, to, root, audit) {
  await appendTraceEvent(
    {
      type: "gate_transition",
      taskId,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      from,
      to,
      gate: to,
      actor: audit.actor,
      evidence: audit.evidence,
    },
    { root },
  );
}

/**
 * Persist a structured continuation error to task.json so a retry knows the
 * gate is durably approved but continuation needs another attempt.
 * @param {WorkflowGate} at   Gate at which continuation was attempted.
 * @param {string} message    Error message from the failed continuation.
 * @param {string} root       Repo root.
 * @returns {Promise<void>}
 */
async function persistContinuationError(at, message, root) {
  const statePath = path.join(root, STATE_PATH);
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) return;
  const next = /** @type {any} */ ({
    ...stateResult.state,
    continuationError: {
      at,
      message,
      ts: new Date().toISOString(),
      recovery: APPROVE_SPEC,
    },
  });
  await writeTaskState(next, statePath);
}

/**
 * Emit a model-visible continuation failure message with the exact retry action
 * so the model can surface it to the human without hallucinating alternatives.
 * @param {string} message  Error message from the failed continuation.
 * @param {NodeJS.WritableStream} stream
 */
function emitContinuationFailure(message, stream) {
  stream.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `[devmate] approve spec persisted. Continuation failed: ${message}\n` +
          `Type: ${APPROVE_SPEC} — to resume implementation without re-approving.`,
      },
    })}\n`,
  );
}

/**
 * Detect near-miss approval attempts. Runs after all exact-phrase checks fail.
 * Returns the canonical phrase the user likely intended, or null when the
 * prompt is clearly unrelated. Uses word-boundary regex to avoid false positives
 * from unrelated words that contain the same substring (e.g., "approve practice"
 * contains "pr" but is not a PR near-miss).
 * @param {string} lower Lower-cased, trimmed prompt.
 * @returns {{ phrase: string } | null}
 */
export function detectNearMissApproval(lower) {
  if (!lower.startsWith("approve ")) return null;
  // Use word boundaries (\b) to match only complete words, not substrings.
  // This avoids false positives like "approve practice" matching \bpr\b.
  if (/\bspec\b/.test(lower)) return { phrase: APPROVE_SPEC };
  if (/\bplan\b/.test(lower)) return { phrase: APPROVE_PLAN };
  if (/\bpr\b|pull\b/.test(lower)) return { phrase: APPROVE_PR };
  return null;
}

/**
 * E12-2: persist the `approve no-tdd` override on task.json so the gate-guard
 * PreToolUse rule sees `tddGuard.overrideGranted = true` on the next tool call.
 * Best-effort: a missing or invalid state file is a passthrough.
 * @param {string} reason
 * @param {string} root
 * @returns {Promise<void>}
 */
async function persistTddOverride(reason, root) {
  const statePath = path.join(root, STATE_PATH);
  const current = readTaskState(statePath);
  if (!current.ok) return;
  const prevGuard = current.state.tddGuard ?? {
    testFileWritten: false,
    consecutiveNonTestWrites: 0,
    overrideGranted: false,
  };
  const next = {
    ...current.state,
    tddGuard: {
      ...prevGuard,
      overrideGranted: true,
      overrideReason: reason,
    },
  };
  await writeTaskState(next, statePath);
}

/**
 * Append a single line to the `## Out of scope` section of `spec.md`
 * (when the spec file exists). The hook is best-effort: a missing spec
 * file is not an error. The header text must match `lib/spec-writer.mjs`.
 * @param {string} reason
 * @param {string} root
 * @returns {Promise<void>}
 */
async function appendNoTddNoteToSpec(reason, root) {
  const specPath = path.join(root, ".devmate/session/spec.md");
  let body;
  try {
    body = await readTextFile(specPath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const note = `- No-TDD override approved by human: ${reason}`;
  // Spec layout uses `## Out of scope` as its own section heading.
  const header = "## Out of scope";
  const idx = body.indexOf(header);
  let nextBody;
  if (idx === -1) {
    const sep = body.endsWith("\n") ? "" : "\n";
    nextBody = `${body}${sep}\n${header}\n${note}\n`;
  } else {
    // Insert the note immediately after the header line.
    const afterHeader = idx + header.length;
    const lineEnd = body.indexOf("\n", afterHeader);
    const insertAt = lineEnd === -1 ? body.length : lineEnd + 1;
    nextBody = `${body.slice(0, insertAt)}${note}\n${body.slice(insertAt)}`;
  }
  await writeTextFile(specPath, nextBody);
}

/**
 * Resolve the task id used for trace writes. Prefer an explicit override on
 * the event payload; otherwise fall back to the value persisted in task.json.
 * @param {UserPromptSubmitEvent} event
 * @param {string} root
 * @returns {string|null}
 */
function resolveTaskId(event, root) {
  if (typeof event.taskId === "string" && event.taskId.trim() !== "") {
    return event.taskId.trim();
  }
  const statePath = path.join(root, STATE_PATH);
  const current = readTaskState(statePath);
  if (current.ok) return current.state.taskId;
  return null;
}

/**
 * UserPromptSubmit hook entry point. Detects approval phrases and drives
 * gate transitions. Passes unknown phrases through untouched.
 * @param {UserPromptSubmitEvent} event Hook event payload from VS Code.
 * @returns {Promise<HookResult>}
 */
export async function handleUserPromptSubmit(event) {
  const root = event.root ?? ".";
  const raw = typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (raw === "") return { action: "passthrough" };

  // Classify the turn intent once and thread it through the skill match (for
  // ledger outcome joining) and the menu gate below.
  const turnIntent = classifyIntent(raw, root);

  // DN-5: resolve the active business domains ONCE per prompt, before skill
  // matching, so the Stage-2 re-rank consumes the same resolution the
  // domain-context writer persists below (never re-resolved). Pure compute —
  // all writes stay in recordDomainContext AFTER the state anchor, so this
  // step cannot refresh task.json's mtime before the anchor reads it.
  const domainResolution = resolveDomainsForPrompt(raw, root);

  // E9-20: surface semantic skill matches for this prompt so heavy skills
  // load only on match. Best-effort — never affects the hook result.
  await recordSkillMatches(raw, root, turnIntent, domainResolution);

  // E10-4: persist the deterministic turn-intent fast path against the
  // current gate (before any transition below, and before the anchor emits)
  // so the state anchor (E10-02) can surface a fresh verdict. Best-effort —
  // never affects the hook result.
  await recordTurnIntent(raw, root);

  // E10-02: always re-anchor the model to the durable workflow state. The
  // anchor block is printed on EVERY prompt — independent of whether an
  // approval phrase matches below — because stdout of this event is added to
  // model-visible context. Best-effort: missing/invalid state emits nothing.
  await emitStateAnchor(root, event.stdout ?? process.stdout);

  // Stage 3: on new-task / steer turns, emit the full skill menu to the
  // model-visible stream so the model can self-select for paraphrases that
  // lexical + state matching miss. Best-effort; other turns emit nothing.
  await emitSkillMenu(root, event.stdout ?? process.stdout, turnIntent);

  // DN-2: advertise the resolved domains via .devmate/state/domain-context.json
  // (the recordSkillMatches writer pattern), consuming the resolution computed
  // once at the top of this pass (DN-5). Runs AFTER emitStateAnchor on
  // purpose: the anchor's staleness signal reads task.json's mtime, which
  // this step's activeDomains write would otherwise refresh. Best-effort —
  // never affects the hook result.
  await recordDomainContext(root, domainResolution);

  const lower = raw.toLowerCase();

  if (lower === APPROVE_SPEC) {
    const statePath = path.join(root, STATE_PATH);
    const stateResult = readTaskState(statePath);
    if (!stateResult.ok) return { action: "passthrough" };
    const currentGate = stateResult.state.workflowGate;

    // Duplicate approval after successful continuation: friendly no-op.
    if (currentGate === "impl-started") {
      (event.stdout ?? process.stdout).write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              `[devmate] approve spec: spec is already approved and implementation is in progress (gate: impl-started).`,
          },
        })}\n`,
      );
      return { action: "passthrough" };
    }

    // Idempotent resume: gate is already spec-approved (continuation failed
    // previously). Skip the advance — the human already approved — and retry
    // the continuation step directly.
    if (currentGate === "spec-approved") {
      // Strip any persisted continuation error so it cannot propagate into the
      // impl-started state that continueApprovedFeature writes.
      const { continuationError: _prev, ...resumeState } =
        /** @type {any} */ (stateResult.state);
      try {
        await continueApprovedFeature(
          /** @type {import('../lib/types.mjs').TaskState} */ (resumeState),
          { repoRoot: root },
        );
      } catch (/** @type {unknown} */ err) {
        const msg = err instanceof Error ? err.message : String(err);
        await persistContinuationError(currentGate, msg, root);
        emitContinuationFailure(msg, event.stdout ?? process.stdout);
      }
      return { action: "gate_advanced", gate: currentGate };
    }

    // Normal path: advance through the canonical human-gate API.
    // advanceHumanGate validates preconditions, checks for stale gate,
    // resets currentStep, persists the new gate, and writes the audit trace —
    // all BEFORE attempting continuation, so the approval is durable even if
    // continuation throws.
    /** @type {{ from: WorkflowGate, to: WorkflowGate, state: import('../lib/types.mjs').TaskState }} */
    let advanceResult;
    try {
      advanceResult = await advanceHumanGate(currentGate, "spec-approved", {
        actor: HOOK_ACTOR,
        evidence: raw,
        root,
      });
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      (event.stdout ?? process.stdout).write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `[devmate] approve spec did not advance the gate: ${msg}`,
          },
        })}\n`,
      );
      return { action: "passthrough" };
    }

    const { to: approvedGate, state: approvedState } = advanceResult;

    // Attempt continuation: spec-approved → impl-started. A failure here is
    // NOT re-thrown — the gate is already durably approved (persisted + traced
    // above). Persist the structured error and emit a model-visible recovery
    // message so the human can retry without re-approving.
    const { continuationError: _ce, ...stateForContinuation } =
      /** @type {any} */ (approvedState);
    try {
      await continueApprovedFeature(
        /** @type {import('../lib/types.mjs').TaskState} */ (stateForContinuation),
        { repoRoot: root },
      );
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      await persistContinuationError(approvedGate, msg, root);
      emitContinuationFailure(msg, event.stdout ?? process.stdout);
    }
    return { action: "gate_advanced", gate: approvedGate };
  }

  if (lower === APPROVE_PLAN) {
    const statePath = path.join(root, STATE_PATH);
    const stateResult = readTaskState(statePath);
    if (!stateResult.ok) return { action: "passthrough" };
    const state = stateResult.state;

    // `transitionGate` — NOT `advanceGate`. advanceGate checks a flattened,
    // LANE-AGNOSTIC table, in which `plan-approved -> impl-started` is legal
    // simply because the bug and chore lanes allow it. Using it here would let
    // "approve plan" walk a FEATURE task straight from plan-approved into
    // impl-started, skipping the spec gate entirely — the exact HITL-2 bypass
    // that issues #58/#59 saw in the wild. transitionGate consults the
    // lane-OWNED table (where the feature lane's plan-approved row accepts only
    // `draft-spec`) and then runs the target gate's precondition. So the refusal
    // is structural: it comes from the transition table, not from a hand-written
    // check here that a later edit could quietly drop.
    const result = await transitionGate(state, "start-impl", {
      stateDir: path.join(root, ".devmate", "state"),
    });

    if (!result.ok) {
      // Say why, on the channel the model reads. A silently ignored approval is
      // how a human comes to believe a gate moved when it did not.
      (event.stdout ?? process.stdout).write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `[devmate] "approve plan" did not advance the gate: ${result.error}`,
          },
        })}\n`,
      );
      return { action: "passthrough" };
    }

    // A successful result always carries from/to and the derived next state; the
    // typedef cannot express that, so verify rather than cast — a gate advance
    // recorded without its endpoints is unauditable.
    const { from, to, state: nextState } = result;
    if (from === undefined || to === undefined || nextState === undefined) {
      return { action: "passthrough" };
    }

    // Persist the state `transitionGate` DERIVED, not just the gate name.
    // `persistGate` writes `workflowGate` alone, which would carry the old
    // `currentStep` into `impl-started` — a stale step index that the state
    // anchor and the resume plan both read, so a resumed session would believe
    // it was already partway through a step it never began. Every other advance
    // path resets it; this one must too.
    await writeTaskState(nextState, path.join(root, STATE_PATH));
    await recordGateTransition(state.taskId, from, to, root, {
      actor: HOOK_ACTOR,
      evidence: raw,
    });
    return { action: "gate_advanced", gate: to };
  }

  if (lower === APPROVE_PR) {
    const statePath = path.join(root, STATE_PATH);
    const stateResult = readTaskState(statePath);
    if (!stateResult.ok) return { action: "passthrough" };
    const currentGate = stateResult.state.workflowGate;

    // Duplicate approval after PR is already ready: friendly no-op.
    if (currentGate === "pr-ready") {
      (event.stdout ?? process.stdout).write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              `[devmate] approve pr: PR is already marked ready (gate: pr-ready).`,
          },
        })}\n`,
      );
      return { action: "passthrough" };
    }

    // Route through the canonical human-gate API: validates preconditions
    // (config-gated AC-coverage + PR-review checks), stale-gate detection,
    // currentStep reset, atomic state persist, and audit trace write.
    try {
      const { to } = await advanceHumanGate(currentGate, "pr-ready", {
        actor: HOOK_ACTOR,
        evidence: raw,
        root,
      });
      return { action: "gate_advanced", gate: to };
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      (event.stdout ?? process.stdout).write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `[devmate] approve pr did not advance the gate: ${msg}`,
          },
        })}\n`,
      );
      return { action: "passthrough" };
    }
  }

  if (lower.startsWith(REVISE_SPEC_PREFIX)) {
    const feedback = parseReviseSpecFeedback(raw);
    const taskId = resolveTaskId(event, root);
    if (taskId !== null) {
      await appendTraceEvent(
        {
          type: "spec_revision_requested",
          taskId,
          stepId: STEP_ID,
          ts: new Date().toISOString(),
          schemaVersion: SCHEMA_VERSION,
          feedback,
        },
        { root },
      );
    }
    return { action: "revision_requested", feedback };
  }

  if (lower.startsWith(NO_TDD_PREFIX)) {
    const reason = parseNoTddReason(raw);
    if (reason === null) return { action: "passthrough" };
    const taskId = resolveTaskId(event, root);
    if (taskId !== null) {
      await appendTraceEvent(
        {
          type: "no_tdd_override",
          taskId,
          stepId: STEP_ID,
          ts: new Date().toISOString(),
          schemaVersion: SCHEMA_VERSION,
          reason,
        },
        { root },
      );
    }
    // E12-2: persist the override on task.json so the gate-guard
    // PreToolUse rule can read it on the next tool call.
    await persistTddOverride(reason, root);
    await appendNoTddNoteToSpec(reason, root);
    return { action: "no_tdd_override", reason };
  }

  // Near-miss detection: a prompt that starts with "approve " but matches no
  // canonical phrase gets corrective guidance instead of a silent passthrough.
  // This prevents "approve the spec" from silently doing nothing and leaving
  // the human believing the gate advanced.
  const nearMiss = detectNearMissApproval(lower);
  if (nearMiss !== null) {
    (event.stdout ?? process.stdout).write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            `[devmate] Unrecognised approval phrase. Did you mean: ${nearMiss.phrase}?`,
        },
      })}\n`,
    );
  }

  return { action: "passthrough" };
}

/**
 * E10-02: read the durable task state and print the model-visible
 * `<devmate-state>` anchor block (current gate, lane, step, legal next
 * transitions) to the given stream, so every prompt re-anchors the
 * orchestrator to the workflow state in task.json. Legal transitions come
 * from the unified transition table via buildStateAnchor — never a duplicated
 * list. Mirrors the recordSkillMatches non-fatal discipline: a fresh session
 * (no state file) or an invalid state emits nothing, and no failure ever
 * blocks the prompt.
 * During implementation (gate `impl-started`) the anchor also carries per-AC
 * progress, joining the canonical trace with the persisted acceptance-criteria
 * list so the model re-anchors to which ACs remain — not just the coarse gate.
 * @param {string} root  Repo root.
 * @param {NodeJS.WritableStream} [stream]  Defaults to process.stdout.
 * @returns {Promise<void>}
 */
export async function emitStateAnchor(root, stream = process.stdout) {
  try {
    const statePath = path.join(root, STATE_PATH);
    const result = readTaskState(statePath);
    if (!result.ok) return;
    const state = result.state;
    /** @type {{ implProgress?: import('../lib/types.mjs').ImplProgress, staleness?: import('../lib/task-staleness.mjs').Staleness, consistency?: import('../lib/gate-consistency.mjs').GateConsistencyResult }} */
    const anchorOpts = {};
    // Gate-evidence consistency: a hand-edited task.json, a forged approval, or
    // a state/trace divergence surfaces as a one-line `state: desynced` field so
    // the model re-anchors to the last evidence-backed gate. Best-effort — a
    // failure here must never block the anchor or the prompt.
    try {
      const consistency = await checkGateConsistency(state, { root });
      if (!consistency.ok) anchorOpts.consistency = consistency;
    } catch {
      // Non-fatal — the anchor is still emitted without the desync line.
    }
    // Surface staleness (from the gitignored state file's mtime) so a days-old
    // in-flight task auto-parks for an unrelated new request instead of forcing
    // a park/abandon interrogation. Best-effort: any failure just omits it.
    try {
      const mtimeMs = statPathSync(statePath).mtimeMs;
      const cfg = loadDevmateConfig(path.join(root, ".devmate", "devmate.config.json"));
      const staleHours = resolveStaleTaskHours(cfg.ok ? cfg.config : null);
      anchorOpts.staleness = evaluateStaleness({
        workflowGate: state.workflowGate,
        mtimeMs,
        nowMs: Date.now(),
        staleHours,
      });
    } catch {
      // Non-fatal — staleness is advisory; omit it when it can't be computed.
    }
    if (state.workflowGate === "impl-started") {
      try {
        const { steps } = await readTrace(state.taskId, {
          traceDir: path.join(root, ".devmate", "state", "trace"),
        });
        anchorOpts.implProgress = summarizeImplProgress(
          completedAcNumbers(steps),
          state.acceptanceCriteria,
        );
      } catch {
        // A trace read failure must never block the anchor.
      }
    }
    stream.write(`${buildStateAnchor(state, anchorOpts)}\n`);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `approval-listener: state anchor skipped (non-fatal): ${msg}\n`,
    );
  }
}

/**
 * Best-effort read of the active lane/gate from durable task state, for the
 * Stage-2 re-rank context and the decision ledger. The durable field is
 * `workflowGate` (see TaskState). Never throws — a fresh or unreadable session
 * yields nulls.
 * @param {string} root
 * @returns {{ lane: string|null, gate: string|null }}
 */
function readLaneGate(root) {
  try {
    const result = readTaskState(path.join(root, STATE_PATH));
    if (!result.ok) return { lane: null, gate: null };
    const state = /** @type {any} */ (result.state);
    return { lane: state.lane ?? null, gate: state.workflowGate ?? null };
  } catch {
    return { lane: null, gate: null };
  }
}

/**
 * Resolve the ordered skill roots: plugin skills (from PLUGIN_ROOT, or
 * relative to this hook file when the env var is unset — never the consumer's
 * workspace) then the project's own skills under the devmate state dir. The
 * workspace wins on non-reserved collisions.
 * @param {string} root
 * @returns {Array<{ dir: string, source: string }>}
 */
function resolveSkillRoots(root) {
  const pluginSkillsDir = path.join(resolvePluginRoot(), "skills");
  const workspaceSkillsDir = path.join(root, ".devmate", "skills");
  return [
    { dir: pluginSkillsDir, source: "plugin" },
    { dir: workspaceSkillsDir, source: "workspace" },
  ];
}

/**
 * Emit the model-visible skill menu on new-task / steer turns — where lexical
 * and state matching are weakest and the model's own paraphrase judgment is
 * most useful. Best-effort: failures warn to stderr and never block the prompt.
 * @param {string} root
 * @param {NodeJS.WritableStream} stream
 * @param {string|null} intent
 * @returns {Promise<void>}
 */
async function emitSkillMenu(root, stream, intent) {
  try {
    if (!shouldEmitMenu(intent)) return;
    const { manifests } = await loadMergedSkillManifests(resolveSkillRoots(root));
    const menu = buildSkillMenu(manifests);
    if (menu !== "") stream.write(`${menu}\n`);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`approval-listener: skill menu skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * Classify the turn intent for the current prompt against durable task state.
 * A fresh session (no task) is treated as a new task. Never throws.
 * @param {string} prompt
 * @param {string} root
 * @returns {string}
 */
function classifyIntent(prompt, root) {
  try {
    const state = readTaskState(path.join(root, STATE_PATH));
    if (state.ok && state.state) {
      // A task is in flight. Use the classified intent; a deferred (null)
      // classification is an ambiguous mid-workflow turn, which must NOT be
      // treated as a new task (that would over-emit the menu).
      const result = classifyTurnDeterministic(prompt, state.state);
      return result ? result.intent : "deferred";
    }
  } catch {
    // fall through to the new-task default
  }
  // No task in flight (fresh session or unreadable state): a fresh prompt starts
  // new work.
  return "new-task";
}

/**
 * E9-20: run the semantic skill matcher over the submitted prompt and persist
 * the ranked top-N matches to `.devmate/state/skill-matches.json` (atomic
 * tmp+rename) together with a concise hint line the orchestrator can read.
 * Pure, bounded, no-LLM computation; failures warn to stderr and never block
 * the prompt.
 *
 * The operating point (topN / minConfidence) comes from the single source in
 * lib/skills/operating-point.mjs, so the eval suite measures the exact values
 * used here. Every decision — the full scored candidate list, including
 * negatively-triggered and below-floor candidates — is appended to the decision
 * ledger so the matcher's behaviour is observable rather than triple-blind.
 * @param {string} prompt
 * @param {string} root
 * @param {string} intent  Turn intent, recorded in the ledger for outcome joining.
 * @param {DomainResolution} domainResolution  DN-5: the in-pass domain resolution (never re-resolved here).
 * @returns {Promise<void>}
 */
async function recordSkillMatches(prompt, root, intent, domainResolution) {
  try {
    const roots = resolveSkillRoots(root);
    const pluginSkillsDir = roots[0].dir;
    const { manifests, sources } = await loadMergedSkillManifests(roots);
    // Stage 2: re-rank with durable workflow state (lane/gate) and force-include
    // the active lane skill, so a paraphrase with no trigger tokens still loads
    // the right skill mid-lane. A fresh session (null lane/gate) is a no-op.
    /** @type {import('../lib/types.mjs').MatchContext} */
    const ctx = readLaneGate(root);
    // DN-5: extend the state context with the active domains so skills whose
    // vocabulary intersects the domain's keywords rank higher — an additive,
    // capped prior only, never a force-include. No domains ⇒ ctx unchanged.
    if (domainResolution.matches.length > 0) {
      ctx.domains = domainResolution.matches.map((m) => m.domain);
      ctx.domainKeywords = Object.fromEntries(
        domainResolution.matches.map((m) => {
          const entry = domainResolution.domains.find((d) => d.domain === m.domain);
          return [m.domain, Array.isArray(entry?.keywords) ? entry.keywords : []];
        }),
      );
    }
    const scored = scoreAll(prompt, manifests);
    const selected = selectWithContext(
      scored,
      ctx,
      {
        topN: SKILL_MATCH_TOP_N,
        minConfidence: SKILL_MATCH_MIN_CONFIDENCE,
      },
      manifests,
    );
    const summary = {
      matchedAt: new Date().toISOString(),
      matches: selected.map((m) => ({
        skillId: m.skillId,
        confidence: m.confidence,
        reason: m.reason,
        triggerFile: m.triggerFile,
      })),
      hint:
        selected.length > 0
          ? `Skill matches for this prompt: ${selected.map((m) => m.skillId).join(", ")}. Consult .devmate/state/skill-matches.json before loading heavy skills.`
          : "No skills matched this prompt; do not preload heavy skill descriptions.",
    };
    const outPath = path.join(root, ".devmate", "state", "skill-matches.json");
    const tmpPath = `${outPath}.tmp`;
    await ensureDir(path.dirname(outPath));
    await writeTextFile(tmpPath, JSON.stringify(summary, null, 2));
    await renamePath(tmpPath, outPath);

    // Log the full decision (all candidates) for observability + the loader
    // canary. A failure here is non-fatal and handled by the outer catch.
    const { lane, gate } = ctx;
    await recordSkillDecision(
      {
        query: prompt,
        manifestsLoaded: manifests.length,
        skillsDir: pluginSkillsDir,
        sources,
        scored,
        selected: selected.map((m) => m.skillId),
        topN: SKILL_MATCH_TOP_N,
        minConfidence: SKILL_MATCH_MIN_CONFIDENCE,
        lane,
        gate,
        intent,
      },
      { ledgerPath: path.join(root, ".devmate", "state", "skill-decisions.jsonl") },
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`approval-listener: skill match skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * DN-5: the one-per-prompt domain resolution shared by the skill re-rank and
 * the domain-context writer, so the two consumers can never disagree.
 * @typedef {Object} DomainResolution
 * @property {import('../lib/types.mjs').DomainConfig[]} domains  Configured domains ([] when none declared or config malformed).
 * @property {import('../lib/types.mjs').DomainMatch[]} matches   Ranked resolver output ([] when domains is []).
 */

/**
 * DN-2/DN-5: resolve which configured business domains this prompt touches,
 * seeded with the active task's specFiles when present. Pure compute with NO
 * writes — safe to run before the state anchor (reading task.json does not
 * touch its mtime). Fail-open: any error yields the empty resolution.
 * @param {string} prompt
 * @param {string} root
 * @returns {DomainResolution}
 */
function resolveDomainsForPrompt(prompt, root) {
  try {
    const cfg = loadDevmateConfig(
      path.join(root, ".devmate", "devmate.config.json"),
    );
    const domains =
      cfg.ok && Array.isArray(cfg.config.domains) ? cfg.config.domains : [];
    if (domains.length === 0) return { domains: [], matches: [] };

    const current = readTaskState(path.join(root, STATE_PATH));
    const seedFiles =
      current.ok && Array.isArray(current.state.specFiles)
        ? current.state.specFiles
        : [];
    return {
      domains,
      matches: resolveActiveDomains({ taskText: prompt, seedFiles, domains }),
    };
  } catch {
    return { domains: [], matches: [] };
  }
}

/**
 * DN-2: persist the precomputed domain resolution (DN-5: resolved once per
 * prompt in resolveDomainsForPrompt, shared with the skill re-rank) to
 * `.devmate/state/domain-context.json` (atomic tmp+rename, mirroring the
 * skill-matches write). Repos whose config declares no `domains` get a
 * guaranteed no-op — nothing is written, and a stale domain-context.json
 * left behind by a since-removed config is deleted so state never outlives
 * config. A malformed config is treated the same way (fail-open). When a
 * task is active and the resolved domain ids changed, they are additionally
 * persisted to task.json as `activeDomains` via the writeTaskState lock
 * discipline; an unchanged resolution skips that write so the task file is
 * not churned on every prompt. Pure, bounded, no-LLM computation; failures
 * warn to stderr and never block the prompt.
 * @param {string} root
 * @param {DomainResolution} resolution
 * @returns {Promise<void>}
 */
async function recordDomainContext(root, resolution) {
  try {
    const outPath = path.join(root, ".devmate", "state", "domain-context.json");
    if (resolution.domains.length === 0) {
      if (pathExists(outPath)) await removeFile(outPath);
      return;
    }

    const statePath = path.join(root, STATE_PATH);
    const current = readTaskState(statePath);
    const matches = resolution.matches;

    /** @type {import('../lib/types.mjs').DomainContextState} */
    const summary = {
      // DomainContextState's own version — deliberately NOT the trace
      // SCHEMA_VERSION constant above; the two schemas evolve independently.
      schemaVersion: 1,
      resolvedAt: new Date().toISOString(),
      matches,
    };
    const tmpPath = `${outPath}.tmp`;
    await ensureDir(path.dirname(outPath));
    await writeTextFile(tmpPath, JSON.stringify(summary, null, 2));
    await renamePath(tmpPath, outPath);

    if (current.ok) {
      const ids = matches.map((m) => m.domain);
      const previous = current.state.activeDomains ?? [];
      const changed =
        ids.length !== previous.length ||
        ids.some((id, i) => id !== previous[i]);
      if (changed) {
        await writeTaskState({ ...current.state, activeDomains: ids }, statePath);
      }
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `approval-listener: domain context skipped (non-fatal): ${msg}\n`,
    );
  }
}

/**
 * E10-4: run the deterministic turn-intent fast path (Stage 1 of the turn
 * router) against the current workflow gate and persist the result to
 * `.devmate/state/turn-intent.json` (atomic tmp+rename, mirroring the
 * skill-matches write) together with a concise hint line for the state
 * anchor. When the fast path defers — or task state is missing/invalid — a
 * `deferred: true` summary is written so the orchestrator knows its LLM
 * stage must classify this turn. Pure, bounded, no-LLM computation;
 * failures warn to stderr and never block the prompt.
 * @param {string} prompt
 * @param {string} root
 * @returns {Promise<void>}
 */
async function recordTurnIntent(prompt, root) {
  try {
    const statePath = path.join(root, STATE_PATH);
    const current = readTaskState(statePath);
    const gate = current.ok ? current.state.workflowGate : null;
    const result = current.ok
      ? classifyTurnDeterministic(prompt, current.state)
      : null;
    const summary = {
      classifiedAt: new Date().toISOString(),
      source: "deterministic",
      gate,
      intent: result === null ? null : result.intent,
      confidence: result === null ? null : result.confidence,
      deferred: result === null,
      hint:
        result === null
          ? "Turn intent deferred: classify this message per the orchestrator Turn routing preamble before acting."
          : `Turn intent (fast path): ${result.intent}. Act per the orchestrator intent-to-action table.`,
    };
    const outPath = path.join(root, ".devmate", "state", "turn-intent.json");
    const tmpPath = `${outPath}.tmp`;
    await ensureDir(path.dirname(outPath));
    await writeTextFile(tmpPath, JSON.stringify(summary, null, 2));
    await renamePath(tmpPath, outPath);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`approval-listener: turn intent skipped (non-fatal): ${msg}\n`);
  }
}

/**
 * Stdin fields consumed by the CLI entrypoint. Official UserPromptSubmit
 * stdin fields per the VS Code hooks doc (see the doc reference in the file
 * header): `prompt`, `cwd`, `hook_event_name`.
 * @typedef {Object} PromptSubmitStdinPayload
 * @property {string} [prompt]           Raw user-typed prompt text.
 * @property {string} [cwd]              Working directory from stdin JSON.
 * @property {string} [hook_event_name]  Official hook event name.
 */

/**
 * Read the entire `stdin` stream to a UTF-8 string.
 * Resolves to '' if stdin is closed or empty.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function readAll(stream) {
  return new Promise((resolveStream, rejectStream) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on("data", (/** @type {Buffer | string} */ chunk) => {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    stream.on("end", () =>
      resolveStream(Buffer.concat(chunks).toString("utf8")),
    );
    stream.on("error", rejectStream);
  });
}

/**
 * E10-02: CLI shim around `handleUserPromptSubmit` so the hooks.json
 * registration actually drives the handler. Reads the UserPromptSubmit stdin
 * JSON, filters internally on `hook_event_name` (matchers are parsed but
 * ignored by the host), and runs the handler — which records skill matches,
 * prints the model-visible `<devmate-state>` anchor block on every prompt,
 * and drives approval-phrase gate transitions.
 *
 * Exit codes: 0 on success or any no-op/malformed input; 1 when the handler
 * itself failed (stderr carries the reason). Never 2 — this hook must never
 * block the user's prompt.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<number>}
 */
export async function runWithIO(stdin, stdout, stderr) {
  let raw = "";
  try {
    raw = await readAll(stdin);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`approval-listener: stdin read error (ignored): ${msg}\n`);
    return 0;
  }
  if (raw.trim() === "") return 0;

  /** @type {PromptSubmitStdinPayload} */
  let payload = {};
  try {
    payload = /** @type {PromptSubmitStdinPayload} */ (JSON.parse(raw));
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`approval-listener: malformed stdin JSON (ignored): ${msg}\n`);
    return 0;
  }

  // Only act on UserPromptSubmit. Other events routed here are no-ops.
  if (payload.hook_event_name && payload.hook_event_name !== "UserPromptSubmit") {
    return 0;
  }
  if (typeof payload.prompt !== "string" || payload.prompt.trim() === "") {
    return 0;
  }

  // Anchor on the workspace root even when the hook's cwd is the workspace's own
  // .devmate/ folder (it is listed first in the util's .code-workspace), so skill
  // state lands in .devmate/state/, not .devmate/.devmate/state/.
  const root = resolveHookRoot(payload);
  try {
    await handleUserPromptSubmit({ prompt: payload.prompt, root, stdout });
    return 0;
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`approval-listener: handler failed (prompt not blocked): ${msg}\n`);
    return 1;
  }
}

/**
 * Entrypoint: read the UserPromptSubmit payload from stdin and run the handler.
 * Follows CONTRIBUTING §6.
 *
 * The handler prints the state anchor and the skill menu as human text. VS Code
 * parses a hook's stdout **as JSON** on exit 0 — so every one of those lines was
 * a parse failure, and the anchor that is supposed to re-ground the model on
 * every turn reached it on none of them (#77). The text now leaves as the one
 * envelope the host reads; the handler and its suite are untouched, because the
 * contract belongs at the boundary, not in the middle of the logic.
 * @param {string[]} _args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  const capture = createTextCapture();
  const code = await runWithIO(process.stdin, capture.stream, process.stderr);
  return writeHookOutput('UserPromptSubmit', capture.text(), code);
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
