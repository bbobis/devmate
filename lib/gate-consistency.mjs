// @ts-check
// Issue #5: gate-evidence consistency — prove the persisted `workflowGate` is
// backed by the evidence artifacts (and trace audit events) that gate legally
// requires. Manual tampering (a hand-edited task.json), a forged human
// approval, or a state/trace divergence all leave the durable gate claiming
// progress the evidence on disk does not support. This module DETECTS that and
// INSTRUCTS a recovery — it never silently rewrites state (auto-heal is opt-in,
// behind `devmate-doctor --fix`).
//
// Split in two, following lib/orchestrator/delegation-report.mjs:
//   - `analyzeGateConsistency` is PURE: given a resolved evidence snapshot and
//     the trace's gate_transition events, it decides consistent-vs-desynced and
//     names the last evidence-backed gate. Fully unit-testable, no I/O.
//   - `checkGateConsistency` is the async I/O wrapper that reads the artifacts +
//     trace and calls the pure core. Hook/doctor callers use this one.
//
// The evidence descriptors mirror lib/gate-preconditions.mjs (the same artifact
// files those gate transitions demand) so the two layers cannot disagree; a
// unit test cross-checks every chain gate against the canonical transition
// table in lib/gate-transitions.mjs.
//
// AUTHENTICITY BOUNDARY (what this detector does NOT catch). This is a
// structural/evidence/history consistency check, not a cryptographic
// authenticity check. It proves that the persisted gate is backed by artifacts
// and audit events that actually exist and validate on disk — nothing more. An
// attacker (or a mistaken user) who fabricates a *fully internally consistent*
// world — a valid artifact file carrying the active taskId, plus a
// gate_transition trace event carrying a plausible actor+evidence pair — cannot
// be distinguished from a genuine one here, because there is no signature to
// verify and the durable state is the only source of truth we have. What this
// catches is DIVERGENCE: a gate ahead of its evidence (forward), a gate behind
// its own trace (backward), a human-audit gate with no audited transition
// (forged), or a trace too corrupt to trust (malformed). Detecting a
// well-formed forgery would require signing the audit events, which is out of
// scope for this issue and tracked separately.

import { join, resolve } from 'node:path';
import { readJsonFileSync } from './json-io.mjs';
import { pathExists, readTextFile, readTextFileSync } from './fs-safe.mjs';
import { getOwn } from './object-utils.mjs';
import { validateGrillResult, validateCritiqueResult } from './workflow/contracts.mjs';
import { validateDiscoveryArtifact } from './workflow/agents/discovery.mjs';
import { parseRouterResult, MIN_ROUTER_CONFIDENCE } from './routing/router.mjs';
import { validateTraceEvent } from './trace/schema.mjs';

/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('./types.mjs').Lane} Lane */
/** @typedef {import('./types.mjs').TaskState} TaskState */

/**
 * Malformed-line ratio above which a trace is considered corrupt. This is the
 * single source of truth: `scripts/view-trace.mjs` imports it, so both surfaces
 * agree on what "too corrupt to trust" means without duplicating the constant.
 * @type {number}
 */
export const MALFORMED_TRACE_THRESHOLD = 0.05;

/**
 * Human-decision gates: reaching them legally requires a `gate_transition`
 * trace event that carries the actor+evidence audit pair (E10-03). A gate that
 * claims one of these without that event is a forged approval.
 * @type {readonly WorkflowGate[]}
 */
const HUMAN_AUDIT_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (['spec-approved', 'pr-ready']),
);

/**
 * Ordered evidence checkpoints per lane, earliest → latest. Only gates that
 * carry a distinct piece of evidence appear here; mechanical pass-through gates
 * (`plan-approved` on bug/chore) and gates proven solely by their predecessor
 * (`impl-started`) are represented with a `none` descriptor so being AT them is
 * "backed" exactly when their predecessors are.
 *
 * Derived from docs/gates.md; `test/lib/gate-consistency.test.mjs` cross-checks
 * every gate here against `flattenTransitions()` so the chain cannot drift from
 * the canonical transition table.
 * @type {Readonly<Record<Lane, readonly WorkflowGate[]>>}
 */
export const LANE_EVIDENCE_CHAIN = Object.freeze(
  /** @type {Record<Lane, readonly WorkflowGate[]>} */ ({
    feature: Object.freeze([
      'lane-set',
      'discovery-done',
      'grill-done',
      'plan-done',
      'spec-draft',
      'spec-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
    ]),
    bug: Object.freeze([
      'lane-set',
      'grill-done',
      'plan-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
    ]),
    chore: Object.freeze([
      'lane-set',
      'plan-approved',
      'impl-started',
      'verification-passed',
    ]),
  }),
);

/**
 * A single gate's evidence, resolved against disk.
 * @typedef {Object} EvidenceCheckpoint
 * @property {WorkflowGate} gate
 * @property {boolean} present            Primary artifact exists (and validates), or the gate has no artifact.
 * @property {boolean} requiresHumanAudit Gate is a human-decision gate (needs an actor+evidence gate_transition).
 * @property {boolean} humanAuditPresent  A gate_transition into this gate with a non-empty actor AND evidence exists.
 * @property {string} label               Human-readable evidence name (for findings).
 * @property {string} artifactPath        The file a human should look at (relative to repo root), or '' when none.
 */

/**
 * A gate_transition event distilled to what consistency needs.
 * @typedef {Object} TraceGateTransition
 * @property {string} to        Gate the transition entered.
 * @property {boolean} audited  Both actor and evidence are non-empty strings.
 */

/**
 * Result of a gate-consistency analysis.
 * @typedef {Object} GateConsistencyResult
 * @property {boolean} ok                       True when the gate is fully evidence-backed.
 * @property {'consistent'|'desynced'} status
 * @property {WorkflowGate} gate                The persisted gate that was checked.
 * @property {WorkflowGate} evidenceBackedGate  Highest gate proven by evidence (rollback target).
 * @property {Array<'forward'|'backward'|'forged'|'malformed-trace'>} divergences
 * @property {string[]} findings                Actionable, human-readable findings.
 * @property {string|null} recommendedCommand   The single command to run to recover.
 */

/**
 * Evidence descriptor per gate: how its primary artifact is proven. Mirrors the
 * files lib/gate-preconditions.mjs demands for the same gate transitions.
 * @type {Record<string, { kind: 'router'|'artifact'|'spec'|'verify'|'none', file?: string, label: string, validate?: (a: unknown) => { ok: boolean, errors: string[] } }>}
 */
const GATE_EVIDENCE = {
  'lane-set': { kind: 'router', file: 'router-result.json', label: 'router result' },
  'discovery-done': {
    kind: 'artifact',
    file: 'discovery-merged.json',
    label: 'merged discovery artifact',
    validate: validateDiscoveryArtifact,
  },
  'grill-done': {
    kind: 'artifact',
    file: 'grill-result.json',
    label: 'grill result',
    validate: validateGrillResult,
  },
  'plan-done': {
    kind: 'artifact',
    file: 'critique-result.json',
    label: 'critique result',
    validate: validateCritiqueResult,
  },
  'spec-draft': { kind: 'spec', label: 'spec.md' },
  // spec-approved carries no NEW artifact beyond the drafted spec; its distinct
  // evidence is the human audit event, checked separately.
  'spec-approved': { kind: 'spec', label: 'approved spec.md' },
  'impl-started': { kind: 'none', label: 'implementation start' },
  'plan-approved': { kind: 'none', label: 'plan approval' },
  'verification-passed': { kind: 'verify', file: 'verify-result.json', label: 'passing verify evidence' },
  'pr-ready': { kind: 'none', label: 'PR readiness' },
};

/**
 * The session dir path (sibling of the state dir) that holds spec.md.
 * @param {string} stateDir
 * @returns {string}
 */
function specPath(stateDir) {
  return resolve(stateDir, '..', 'session', 'spec.md');
}

/**
 * The task an artifact declares it belongs to, or null when it declares none.
 * Mirrors `artifactTaskId` in lib/gate-preconditions.mjs so the detector's
 * ownership rule is byte-identical to the one the real gate enforces.
 * @param {unknown} artifact
 * @returns {string|null}
 */
function artifactTaskId(artifact) {
  if (artifact === null || typeof artifact !== 'object') return null;
  const taskId = getOwn(/** @type {Record<string, unknown>} */ (artifact), 'taskId');
  return typeof taskId === 'string' && taskId.trim() !== '' ? taskId : null;
}

/**
 * Resolve whether a single gate's primary artifact is present (and valid) AND
 * belongs to the active task. Pure-ish: reads the filesystem synchronously via
 * the audited helpers. Returns `true` for `none`-kind gates (nothing to prove
 * at this gate itself).
 *
 * Ownership mirrors lib/gate-preconditions.mjs's `requireArtifact`: a stale
 * artifact from an earlier task (its `taskId` differs from the active task's)
 * does NOT count as evidence — otherwise a leftover `router-result.json` from a
 * prior task would silently back a hand-advanced gate on a fresh task. Both
 * sides must be known to refuse: an artifact with no `taskId` (pre-stamp) or a
 * caller that did not supply one is trusted, exactly as the real gate does.
 * @param {WorkflowGate} gate
 * @param {string} stateDir
 * @param {string} taskId  Active task id; '' when unknown (ownership not checked).
 * @returns {boolean}
 */
function resolveArtifactPresent(gate, stateDir, taskId) {
  const desc = getOwn(GATE_EVIDENCE, gate);
  if (desc === undefined || desc.kind === 'none') return true;

  if (desc.kind === 'spec') {
    try {
      const sp = specPath(stateDir);
      return pathExists(sp) && readTextFileSync(sp).trim() !== '';
    } catch {
      return false;
    }
  }

  const file = desc.file;
  if (file === undefined) return true;
  const artifact = readJsonFileSync(join(stateDir, file));
  if (artifact === null) return false;

  // Ownership: a foreign-task artifact is stale evidence, not this task's proof.
  const owner = artifactTaskId(artifact);
  const asker = typeof taskId === 'string' ? taskId.trim() : '';
  if (owner !== null && asker !== '' && owner !== asker) return false;

  if (desc.kind === 'router') {
    const parsed = parseRouterResult(artifact);
    return parsed.ok && parsed.result.confidence >= MIN_ROUTER_CONFIDENCE;
  }
  if (desc.kind === 'verify') {
    return (
      typeof artifact === 'object' &&
      artifact !== null &&
      getOwn(/** @type {Record<string, unknown>} */ (artifact), 'passed') === true
    );
  }
  if (desc.validate !== undefined) {
    return desc.validate(artifact).ok;
  }
  return true;
}

/**
 * The relative (repo-root) path a human should inspect for a gate's evidence,
 * or '' when the gate has no distinct artifact.
 * @param {WorkflowGate} gate
 * @returns {string}
 */
function evidenceArtifactPath(gate) {
  const desc = getOwn(GATE_EVIDENCE, gate);
  if (desc === undefined || desc.kind === 'none') return '';
  if (desc.kind === 'spec') return '.devmate/session/spec.md';
  return desc.file ? `.devmate/state/${desc.file}` : '';
}

/**
 * Artifact-hash keys (the names `recordArtifactHash` writes) mapped to the gate
 * whose evidence they represent. `design`/`plan`/`critique` are stamped on the
 * way to `plan-done`; `spec` is stamped at `spec-draft`. Both `<name>` and
 * `<name>Digest` are governed by `<name>`'s era.
 * @type {Readonly<Record<string, WorkflowGate>>}
 */
const ARTIFACT_HASH_GATE = Object.freeze(
  /** @type {Record<string, WorkflowGate>} */ ({
    design: 'plan-done',
    plan: 'plan-done',
    critique: 'plan-done',
    spec: 'spec-draft',
  }),
);

/**
 * Drop artifact-hash entries that belong to a gate LATER than `targetGate` in
 * the (superset) feature evidence chain — the stale trust residue a rollback
 * must not leave behind. A lingering `specDigest` after a rollback to `no-lane`
 * would let a later spec-integrity check pass against a digest the rolled-back
 * gate no longer legitimately holds; dropping it closes that hole.
 *
 * Keys with no known era (foreign/future keys) are preserved untouched — this
 * only prunes the hashes devmate itself stamps. Pure: no I/O.
 * @param {Record<string, string>} artifactHashes
 * @param {WorkflowGate} targetGate  The gate the state is being rolled back to.
 * @returns {Record<string, string>}
 */
export function pruneArtifactHashesForRollback(artifactHashes, targetGate) {
  const chain = LANE_EVIDENCE_CHAIN.feature;
  const targetIndex = chain.indexOf(targetGate);
  const kept = Object.entries(artifactHashes).filter(([key]) => {
    const base = key.endsWith('Digest') ? key.slice(0, -'Digest'.length) : key;
    const eraGate = getOwn(ARTIFACT_HASH_GATE, base);
    if (eraGate === undefined) return true; // not a devmate-stamped hash — leave it
    return chain.indexOf(eraGate) <= targetIndex;
  });
  return Object.fromEntries(kept);
}

/**
 * Read a task's trace file and distill it into gate_transition summaries plus
 * malformed-line statistics. Missing file → empty, zero malformed. Never throws
 * on a corrupt line: it is counted, not propagated (a hook must fail safe).
 * @param {string} traceDir  Directory holding `<taskId>.jsonl`.
 * @param {string} taskId
 * @returns {Promise<{ transitions: TraceGateTransition[], malformedRatio: number, totalLines: number }>}
 */
export async function readTraceConsistency(traceDir, taskId) {
  /** @type {TraceGateTransition[]} */
  const transitions = [];
  let total = 0;
  let malformed = 0;

  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(join(traceDir, `${taskId}.jsonl`));
  } catch {
    return { transitions, malformedRatio: 0, totalLines: 0 };
  }

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    total += 1;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!validateTraceEvent(parsed).ok) {
      malformed += 1;
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (parsed);
    if (rec.type === 'gate_transition' && typeof rec.to === 'string') {
      const actor = typeof rec.actor === 'string' ? rec.actor.trim() : '';
      const evidence = typeof rec.evidence === 'string' ? rec.evidence.trim() : '';
      transitions.push({ to: rec.to, audited: actor !== '' && evidence !== '' });
    }
  }

  return {
    transitions,
    malformedRatio: total > 0 ? malformed / total : 0,
    totalLines: total,
  };
}

/**
 * PURE core: decide whether `gate` is backed by the resolved evidence and the
 * trace's gate_transition events. No I/O — the caller resolves the snapshot.
 *
 * Detection:
 *   - forward  — the persisted gate is AHEAD of the last evidence-backed gate
 *                (someone hand-advanced the gate without producing the artifact).
 *   - backward — the trace records advancement PAST the persisted gate (someone
 *                reset the gate; the trace is treated as the truth of progress).
 *   - forged   — the persisted gate is a human-decision gate but no audited
 *                gate_transition into it exists (a forged approval).
 *   - malformed-trace — the trace's malformed-line ratio exceeds the threshold,
 *                so progress cannot be trusted from it.
 *
 * @param {{
 *   lane: Lane,
 *   gate: WorkflowGate,
 *   checkpoints: EvidenceCheckpoint[],
 *   transitions: TraceGateTransition[],
 *   malformedRatio: number,
 *   traceFile: string,
 * }} input
 * @returns {GateConsistencyResult}
 */
export function analyzeGateConsistency(input) {
  const { lane, gate, checkpoints, transitions, malformedRatio, traceFile } = input;
  const chain = getOwn(LANE_EVIDENCE_CHAIN, lane) ?? [];

  /** @type {string[]} */
  const findings = [];
  /** @type {Array<'forward'|'backward'|'forged'|'malformed-trace'>} */
  const divergences = [];

  // Highest evidence-backed gate: walk the chain in order and stop at the first
  // checkpoint whose evidence is absent. `-1` means not even `lane-set` is
  // backed → the safe rollback target is `no-lane`.
  let backedIndex = -1;
  for (let i = 0; i < chain.length; i += 1) {
    const cp = checkpoints[i];
    const backed =
      cp !== undefined &&
      cp.present &&
      (!cp.requiresHumanAudit || cp.humanAuditPresent);
    if (!backed) break;
    backedIndex = i;
  }
  const evidenceBackedGate = /** @type {WorkflowGate} */ (
    backedIndex >= 0 ? (chain.at(backedIndex) ?? 'no-lane') : 'no-lane'
  );

  const currentIndex = chain.indexOf(gate);

  // Furthest gate the trace claims we reached (regardless of evidence on disk).
  let traceReachedIndex = -1;
  for (const t of transitions) {
    const idx = chain.indexOf(/** @type {WorkflowGate} */ (t.to));
    if (idx > traceReachedIndex) traceReachedIndex = idx;
  }

  // Corrupt trace: progress cannot be trusted from it. Report loud with the
  // named file so a human/agent knows exactly what to inspect.
  if (malformedRatio > MALFORMED_TRACE_THRESHOLD) {
    divergences.push('malformed-trace');
    findings.push(
      `trace is corrupt: ${(malformedRatio * 100).toFixed(1)}% of lines in ${traceFile} are malformed ` +
        `(threshold ${(MALFORMED_TRACE_THRESHOLD * 100).toFixed(0)}%) — the recorded progress cannot be trusted. ` +
        `Inspect ${traceFile} and rebuild it from the last good line.`,
    );
  }

  // Forged approval: a human-decision gate reached without its audit event.
  if (currentIndex >= 0) {
    const cp = checkpoints.at(currentIndex);
    if (cp !== undefined && cp.requiresHumanAudit && !cp.humanAuditPresent) {
      divergences.push('forged');
      findings.push(
        `forged approval: workflowGate is "${gate}" but no audited gate_transition ` +
          `(actor + evidence) into "${gate}" exists in the trace — the human approval was never recorded. ` +
          `A gate cannot enter "${gate}" except through an approval that stamps who approved it and their message.`,
      );
    }
  }

  // Forward tamper: the gate is ahead of the evidence.
  if (currentIndex >= 0 && currentIndex > backedIndex) {
    divergences.push('forward');
    const missing = chain
      .slice(backedIndex + 1, currentIndex + 1)
      .map((g) => {
        const path = evidenceArtifactPath(/** @type {WorkflowGate} */ (g));
        return path === '' ? `${g} (human approval)` : `${g} (${path})`;
      })
      .join(', ');
    findings.push(
      `gate ahead of evidence: workflowGate is "${gate}" but the last evidence-backed gate is ` +
        `"${evidenceBackedGate}". Missing evidence for: ${missing}. ` +
        `Dispatch stays denied until the gate is rolled back to an evidence-backed value.`,
    );
  }

  // Backward tamper: the trace records more progress than the persisted gate.
  if (currentIndex >= 0 && traceReachedIndex > currentIndex) {
    divergences.push('backward');
    const traceGate = chain.at(traceReachedIndex);
    findings.push(
      `gate behind trace: workflowGate is "${gate}" but the trace records advancement to "${traceGate}". ` +
        `Treat the trace as the truth of progress — do NOT re-dispatch the steps already completed between ` +
        `"${gate}" and "${traceGate}".`,
    );
  }

  const ok = divergences.length === 0;

  /** @type {string|null} */
  let recommendedCommand = null;
  if (!ok) {
    recommendedCommand =
      `node scripts/devmate-doctor.mjs --fix   # reconcile workflowGate to the last evidence-backed gate ` +
      `"${evidenceBackedGate}" (or park the task and start fresh)`;
  }

  return {
    ok,
    status: ok ? 'consistent' : 'desynced',
    gate,
    evidenceBackedGate,
    divergences,
    findings,
    recommendedCommand,
  };
}

/**
 * Async I/O wrapper: resolve the evidence snapshot + trace and run the pure
 * analysis. Fail-safe by construction — any unreadable artifact resolves to
 * "evidence absent" rather than throwing, so a hook calling this never crashes
 * the host into a "prompt not blocked" state.
 *
 * Gates outside the lane's evidence chain (`no-lane`, `done`, `parked`,
 * `abandoned`, or an unknown lane) have nothing to prove against the chain and
 * are reported `consistent` — steering/terminal states are not tampering.
 *
 * @param {TaskState} state  The persisted task state (already read + validated).
 * @param {{ root?: string, stateDir?: string, traceDir?: string }} [opts]
 * @returns {Promise<GateConsistencyResult>}
 */
export async function checkGateConsistency(state, opts = {}) {
  const root = opts.root ?? '.';
  const stateDir = opts.stateDir ?? resolve(root, '.devmate', 'state');
  const traceDir = opts.traceDir ?? join(stateDir, 'trace');
  const lane = state.lane;
  const gate = state.workflowGate;

  const chain = getOwn(LANE_EVIDENCE_CHAIN, lane);
  const traceFileRel = `.devmate/state/trace/${state.taskId}.jsonl`;

  // Steering/terminal gate, or unknown lane: nothing on the chain to verify.
  if (chain === undefined || chain.indexOf(gate) === -1) {
    // Still surface a corrupt trace even for off-chain gates — a malformed
    // trace is a corruption regardless of where the gate sits.
    const { malformedRatio } = await readTraceConsistency(traceDir, state.taskId);
    if (malformedRatio > MALFORMED_TRACE_THRESHOLD) {
      return {
        ok: false,
        status: 'desynced',
        gate,
        evidenceBackedGate: gate,
        divergences: ['malformed-trace'],
        findings: [
          `trace is corrupt: ${(malformedRatio * 100).toFixed(1)}% of lines in ${traceFileRel} are malformed ` +
            `(threshold ${(MALFORMED_TRACE_THRESHOLD * 100).toFixed(0)}%) — inspect ${traceFileRel}.`,
        ],
        recommendedCommand: `node scripts/view-trace.mjs --task ${state.taskId}`,
      };
    }
    return {
      ok: true,
      status: 'consistent',
      gate,
      evidenceBackedGate: gate,
      divergences: [],
      findings: [],
      recommendedCommand: null,
    };
  }

  const { transitions, malformedRatio } = await readTraceConsistency(
    traceDir,
    state.taskId,
  );

  const auditedGates = new Set(
    transitions.filter((t) => t.audited).map((t) => t.to),
  );

  /** @type {EvidenceCheckpoint[]} */
  const checkpoints = chain.map((g) => {
    const requiresHumanAudit = HUMAN_AUDIT_GATES.includes(g);
    return {
      gate: g,
      present: resolveArtifactPresent(g, stateDir, state.taskId),
      requiresHumanAudit,
      humanAuditPresent: auditedGates.has(g),
      label: getOwn(GATE_EVIDENCE, g)?.label ?? g,
      artifactPath: evidenceArtifactPath(g),
    };
  });

  return analyzeGateConsistency({
    lane,
    gate,
    checkpoints,
    transitions,
    malformedRatio,
    traceFile: traceFileRel,
  });
}
