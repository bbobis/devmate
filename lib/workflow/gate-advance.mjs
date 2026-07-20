// @ts-check
/**
 * #91 — the gate machine's missing writer.
 *
 * The workflow gate had exactly one runtime writer for its pre-implementation
 * spine: the `gatectl` CLI. The orchestrator owns gate state and declares no
 * `execute` tool, so it could never run it — every "advance the gate" line in
 * its prompt and both lane skills was unrunnable prose. `bootstrapTaskState`
 * seeded `no-lane` and nothing on earth could move it, so every session sat at
 * `no-lane` forever, the human spec gate was never reached, and the guard
 * (which only denied at `plan-approved`) waved every source edit through.
 *
 * This module is the writer, and it advances on EVIDENCE, never on prose:
 *
 *  1. {@link projectWorkerReturn} takes a subagent's return — the one thing the
 *     host actually hands a hook, in `tool_response` — and writes it to the
 *     canonical artifact path the gate precondition reads. This is the bridge
 *     that was missing: `hooks/post-tool-use.mjs` already persisted returns to
 *     `.devmate/state/worker-returns/<agent>.<toolUseId>.json`, but the
 *     preconditions read `router-result.json` / `grill-result.json` /
 *     `critique-result.json` / `discovery-merged.json` — files NOTHING wrote,
 *     because every analyst agent (`router`, `discovery`, `planner`,
 *     `rubber-duck`) is read-only and cannot author its own evidence.
 *
 *  2. {@link advanceAlongLane} walks the lane's chain, one gate at a time, and
 *     stops at the first gate whose precondition is unmet. The precondition
 *     layer (`lib/gate-preconditions.mjs`) is reused as-is, so "advanced" and
 *     "the artifact exists and validates" cannot drift apart.
 *
 * Driven with `transitionGate` — NOT `advanceGate`. advanceGate consults a
 * flattened, lane-AGNOSTIC table in which a feature task could walk straight
 * from `lane-set` to `plan-approved`, skipping the spec gate entirely: the
 * HITL-2 bypass of #58/#59 that `hooks/approval-listener.mjs` already warns
 * about. transitionGate consults the lane-OWNED table and runs the target
 * gate's precondition, so the refusal is structural.
 *
 * Human gates are NOT in any chain. The feature chain stops at `spec-draft`
 * (the human types `approve spec`) and the bug chain at `plan-approved` (the
 * human types `approve plan`); only the chore lane — mechanical by design, with
 * no human gate — runs on into `impl-started`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { digestsEqual } from '../digest-compare.mjs';
import { pathExists, readTextFile } from '../fs-safe.mjs';
import { writeJsonFileAtomic } from '../json-io.mjs';
import { getOwn } from '../object-utils.mjs';
import { parseRouterResult } from '../routing/router.mjs';
import { TRANSITIONS, transitionGate } from '../gate-transitions.mjs';
import {
  validateCritiqueResult,
  validateDiagnosisResult,
  validateGrillResult,
} from './contracts.mjs';
import {
  mergeDiscoveryArtifacts,
  validateDiscoveryArtifact,
} from './agents/discovery.mjs';
import { validatePlannerArtifact } from './agents/planner.mjs';
import { readDiscoveryReturns } from './discovery-returns.mjs';
import { normalizeAgentReturn } from './normalize-return.mjs';
import { WORKER_RETURNS_DIR } from './persist-worker-return.mjs';
import {
  collectTestGlobs,
  resolveWorkspacePaths,
  writeScope,
} from './scope-writer.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').Lane} Lane */
/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../types.mjs').GateEvent} GateEvent */

/** State dir, relative to the workspace root. */
export const STATE_DIR = '.devmate/state';

/** The human-facing spec artifact — flat, NOT task-scoped (`lib/spec-writer.mjs`). */
export const SPEC_REL_PATH = '.devmate/session/spec.md';

/** Fallback claim cap for the discovery fan-in, matching `scripts/merge-discovery.mjs`. */
const DEFAULT_MAX_CLAIMS = 10;

/**
 * Per-lane auto-advance chain: the ordered gate events a hook may fire without
 * a human. Each is still evidence-gated by the target gate's precondition, so
 * "in the chain" means *allowed to advance*, never *advances unconditionally*.
 *
 * The walk stops at every gate with no chain event legal from it — which is
 * exactly a human gate (a phrase, not a chain event, advances it) or a terminal:
 *  - feature → `spec-draft`    (human: `approve spec`); then, once the human
 *              approves and implementation begins, the chain resumes at
 *              `impl-started` and advances to `verification-passed`, stopping at
 *              the `approve pr` gate.
 *  - bug     → `plan-approved` (human: `approve plan`); then the same
 *              post-approval `impl-started → verification-passed` advance.
 *  - chore   → mechanical (no human gate): runs straight through to
 *              `verification-passed`, its verified terminal.
 *
 * `pass-verification` (impl-started → verification-passed) is in EVERY chain
 * because no other runtime caller fires it: the gate-advance hook used to stop
 * at `impl-started`, and the chore executor that would have fired it had no
 * runtime caller and was removed (#168) — so a feature or bug task could never
 * leave `impl-started`, dead-ending the workflow exactly where implementation
 * finishes. The `verification-passed` precondition (fresh, passing, spec-matching
 * verify evidence + AC coverage) gates it, so it cannot fire until implementation
 * is genuinely done.
 *
 * @type {Readonly<Record<Lane, readonly GateEvent[]>>}
 */
export const LANE_CHAINS = Object.freeze({
  feature: Object.freeze(
    /** @type {readonly GateEvent[]} */ ([
      'set-lane',
      'finish-discovery',
      'finish-grill',
      'finish-plan',
      'draft-spec',
      'pass-verification',
    ]),
  ),
  // The bug lane diagnoses instead of discovering: no discovery-done gate.
  bug: Object.freeze(
    /** @type {readonly GateEvent[]} */ (['set-lane', 'finish-grill', 'present-plan', 'pass-verification']),
  ),
  chore: Object.freeze(
    /** @type {readonly GateEvent[]} */ (['set-lane', 'present-plan', 'start-impl', 'pass-verification']),
  ),
});

/**
 * The canonical artifact each agent's return is projected onto — the exact
 * filenames `lib/gate-preconditions.mjs` reads.
 * @type {Readonly<Record<string, string>>}
 */
export const PROJECTED_ARTIFACTS = Object.freeze({
  router: 'router-result.json',
  grill: 'grill-result.json',
  critique: 'critique-result.json',
  discovery: 'discovery-merged.json',
  // #92: the dispatch gate (lib/workflow/dispatch-gate.mjs) requires this before
  // @fullstack may start on the bug lane — and nothing wrote it, so the bug
  // lane's implementation dispatch was denied outright.
  diagnosis: 'diagnosis.json',
});

/**
 * Effective claim cap for the discovery fan-in, read from the task's
 * OutputContract. Degrades to {@link DEFAULT_MAX_CLAIMS}, never throws.
 * @param {TaskState|null} state
 * @returns {number}
 */
function resolveMaxClaims(state) {
  const contract = /** @type {Record<string, unknown>|undefined} */ (
    /** @type {unknown} */ (state?.outputContract)
  );
  const raw = contract === undefined ? undefined : contract['max_context_sources'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
    ? raw
    : DEFAULT_MAX_CLAIMS;
}

/**
 * Result of projecting one worker return onto its canonical artifact.
 * @typedef {Object} ProjectionResult
 * @property {string|null} artifact  Filename written under `.devmate/state/`, or null.
 * @property {Lane|null}   lane      The lane the router classified, when this was a router return.
 * @property {string|null} reason    Why nothing was written (an invalid return is NOT an error).
 * @property {Record<string, unknown>} [body]  The normalized body actually written — what a
 *   caller must trace or report, since the raw return may be an envelope whose fields sit one
 *   level down.
 */

/**
 * Project a subagent's return onto the canonical artifact its gate precondition
 * reads. A return that fails its contract writes NOTHING — the gate then stays
 * put, which is the fail-closed behaviour we want: a malformed worker result
 * must never look like evidence.
 *
 * `rubber-duck` returns two different contracts from two different steps; they
 * are discriminated by the `mode` field their validators require (`'grill'` vs
 * `'critique'`), not by dispatch order, which a hook cannot see.
 *
 * @param {string} repoRoot           Absolute workspace root.
 * @param {string} agentName          `agentName` from the return payload.
 * @param {unknown} result            The return payload itself.
 * @param {TaskState|null} state      Current task state (for the discovery claim cap).
 * @param {DevmateConfig|null} [config] Loaded devmate config, for the scope.md test-glob floor (#92).
 * @param {string} [now]              Injected clock for `returnedAt` — never read here (determinism).
 * @returns {Promise<ProjectionResult>}
 */
export async function projectWorkerReturn(
  repoRoot,
  agentName,
  result,
  state,
  config = null,
  now = '',
) {
  const stateDir = join(repoRoot, STATE_DIR);

  /**
   * Apply the boundary transform for every contract whose validator requires the
   * host-owned fields. Every one of them needs a taskId, and only task state has
   * it — so a projection with no state is refused rather than stamped with a guess.
   * @param {unknown} raw
   * @returns {Record<string, unknown>|null}
   */
  const normalize = (raw) =>
    state === null ? null : normalizeAgentReturn(raw, { taskId: state.taskId, now });

  if (agentName === 'router') {
    const parsed = parseRouterResult(result);
    if (!parsed.ok) return { artifact: null, lane: null, reason: parsed.error };
    await writeJsonFileAtomic(
      join(stateDir, PROJECTED_ARTIFACTS['router']),
      parsed.result,
    );
    return {
      artifact: PROJECTED_ARTIFACTS['router'],
      lane: /** @type {Lane} */ (parsed.result.lane),
      reason: null,
    };
  }

  if (agentName === 'rubber-duck') {
    const body = normalize(result);
    if (body === null) {
      return { artifact: null, lane: null, reason: 'no task state: cannot place the rubber-duck result' };
    }

    // Discriminate on the `mode` the agent declares, never on dispatch order — a
    // hook sees a completion, not the sequence that led to it.
    //
    // Reporting the mode-matching validator's OWN errors is the point of this
    // shape. The old message ("matched neither GrillResult nor CritiqueResult") was
    // true and useless: it named no field, so nobody could act on it, and it went to
    // a channel nobody read. When the grill is what failed, say what was missing
    // FROM THE GRILL.
    const mode = getOwn(body, 'mode');

    // The artifact name is carried on the candidate rather than looked up by a
    // runtime string: indexing a frozen table with a value the MODEL supplied is the
    // object-injection surface the security lint rejects, and `mode` comes straight
    // off the wire.
    /** @type {{ label: string, artifact: string, validate: (a: unknown) => { ok: boolean, errors: string[] } }[]} */
    const GRILL = [
      { label: 'grill', artifact: PROJECTED_ARTIFACTS['grill'], validate: validateGrillResult },
    ];
    /** @type {{ label: string, artifact: string, validate: (a: unknown) => { ok: boolean, errors: string[] } }[]} */
    const CRITIQUE = [
      {
        label: 'critique',
        artifact: PROJECTED_ARTIFACTS['critique'],
        validate: validateCritiqueResult,
      },
    ];

    const candidates =
      mode === 'grill' ? GRILL : mode === 'critique' ? CRITIQUE : [...GRILL, ...CRITIQUE];

    /** @type {string[]} */
    // @bounded-alloc — at most two validators.
    const failures = [];
    for (const candidate of candidates) {
      const verdict = candidate.validate(body);
      if (verdict.ok) {
        await writeJsonFileAtomic(join(stateDir, candidate.artifact), body);
        return { artifact: candidate.artifact, lane: null, reason: null, body };
      }
      failures.push(`${candidate.label}: ${verdict.errors.join('; ')}`);
    }

    return {
      artifact: null,
      lane: null,
      reason:
        mode === 'grill' || mode === 'critique'
          ? `rubber-duck ${String(mode)} return invalid — ${failures.join(' | ')}`
          : `rubber-duck return declared no mode, and matched neither contract — ${failures.join(' | ')}`,
    };
  }

  if (agentName === 'discovery') {
    // The fan-in is the evidence, not any single worker: re-merge every
    // discovery return persisted so far. Re-running on each return is
    // deliberate — a K-wide wave lands K times and the merge is idempotent, so
    // the artifact always reflects every worker that has come back.
    const returnsDir = join(repoRoot, WORKER_RETURNS_DIR);
    if (!pathExists(returnsDir)) {
      return { artifact: null, lane: null, reason: 'no worker-returns directory' };
    }
    const { artifacts, workerIds } = readDiscoveryReturns(returnsDir);
    if (artifacts.length === 0) {
      return { artifact: null, lane: null, reason: 'no discovery returns persisted yet' };
    }
    const { merged } = mergeDiscoveryArtifacts(artifacts, {
      maxClaims: resolveMaxClaims(state),
      workerIds,
    });
    const verdict = validateDiscoveryArtifact(merged);
    if (!verdict.ok) {
      return {
        artifact: null,
        lane: null,
        reason: `merged discovery artifact failed validation: ${verdict.errors.join('; ')}`,
      };
    }
    const body = normalize(merged);
    if (body === null) {
      return { artifact: null, lane: null, reason: 'no task state: cannot place the merged discovery artifact' };
    }
    await writeJsonFileAtomic(join(stateDir, PROJECTED_ARTIFACTS['discovery']), body);
    return { artifact: PROJECTED_ARTIFACTS['discovery'], lane: null, reason: null };
  }

  // #92 — the two returns that carry the lane's EDIT BOUNDARY. Each is written
  // twice: to the artifact the dispatch gate reads, and to the scope.md
  // gate-guard Rule 6 enforces. Neither agent could write either file itself
  // (`planner` is read-only; `diagnose` has no `edit` tool), so both artifacts
  // had no writer at all — which is why the bug and chore lanes could not even
  // dispatch @fullstack, let alone bound it.

  if (agentName === 'planner') {
    if (state === null) {
      return { artifact: null, lane: null, reason: 'no task state: cannot place plan.json' };
    }
    const body = /** @type {Record<string, unknown>} */ (normalize(result));
    const verdict = validatePlannerArtifact(body);
    if (!verdict.ok) {
      return {
        artifact: null,
        lane: null,
        reason: `planner return invalid: ${verdict.errors.join('; ')}`,
      };
    }

    const plan = /** @type {{ tasks: { files: string[] }[] }} */ (/** @type {unknown} */ (body));
    await writeJsonFileAtomic(sessionArtifactPath(repoRoot, state.taskId, 'plan.json'), body);

    const files = dedupeFiles(plan.tasks.flatMap((t) => t.files));
    const scope = await writeTaskScope(repoRoot, state.taskId, state.lane, files, [], config);
    return {
      artifact: 'plan.json',
      lane: null,
      reason: scope.ok ? null : scope.reason,
    };
  }

  if (agentName === 'diagnose') {
    if (state === null) {
      return { artifact: null, lane: null, reason: 'no task state: cannot place scope.md' };
    }
    const body = /** @type {Record<string, unknown>} */ (normalize(result));
    const verdict = validateDiagnosisResult(body);
    if (!verdict.ok) {
      return {
        artifact: null,
        lane: null,
        reason: `diagnose return invalid: ${verdict.errors.join('; ')}`,
      };
    }

    const diagnosis = /** @type {{ allowedPaths: string[], allowedGlobs: string[] }} */ (
      /** @type {unknown} */ (body)
    );
    await writeJsonFileAtomic(join(stateDir, PROJECTED_ARTIFACTS['diagnosis']), body);

    const scope = await writeTaskScope(
      repoRoot,
      state.taskId,
      'bug',
      diagnosis.allowedPaths,
      diagnosis.allowedGlobs,
      config,
    );
    return {
      artifact: PROJECTED_ARTIFACTS['diagnosis'],
      lane: null,
      reason: scope.ok ? null : scope.reason,
    };
  }

  return { artifact: null, lane: null, reason: `no projection for agent "${agentName}"` };
}

/**
 * Absolute path of a task-scoped session artifact (`plan.json`, `scope.md`, …).
 * Note `spec.md` is deliberately NOT task-scoped — see {@link SPEC_REL_PATH}.
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {string} name
 * @returns {string}
 */
function sessionArtifactPath(repoRoot, taskId, name) {
  return join(repoRoot, '.devmate', 'session', taskId, name);
}

/**
 * Dedupe + sort a file list so the same plan always yields a byte-identical
 * scope.md (the artifact is re-derived on every planner return).
 * @param {readonly unknown[]} files
 * @returns {string[]}
 */
function dedupeFiles(files) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const f of files) {
    if (typeof f === 'string' && f.trim() !== '') out.add(f.trim());
  }
  return [...out].sort();
}

/**
 * Write the lane's scope.md from a file list, adding the test-glob floor.
 *
 * The floor matters: TDD writes test files the plan never enumerates, so without
 * it the first failing test — the one the bug lane REQUIRES before a fix — would
 * itself be an out-of-scope edit, and the guard would block the very workflow it
 * is meant to protect.
 *
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {Lane} lane
 * @param {readonly string[]} allowedPaths
 * @param {readonly string[]} extraGlobs
 * @param {DevmateConfig|null|undefined} config
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string }>}
 */
async function writeTaskScope(repoRoot, taskId, lane, allowedPaths, extraGlobs, config) {
  const testGlobs = config ? collectTestGlobs(config) : [];
  const paths =
    config && lane === 'chore'
      ? resolveWorkspacePaths(allowedPaths, config, 'editor')
      : [...allowedPaths];

  return writeScope(repoRoot, {
    taskId,
    lane,
    allowedPaths: paths,
    allowedGlobs: [...new Set([...extraGlobs, ...testGlobs])],
  });
}

/**
 * SHA-256 of the spec's bytes, computed exactly as `lib/spec-writer.mjs` does
 * (decoded text re-encoded utf8) so the digest a hook stamps and the digest
 * `spec-integrity-guard` later re-computes cannot disagree.
 * @param {string} markdown
 * @returns {string}
 */
export function specDigestOf(markdown) {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

/**
 * Gates at which the recorded spec digest may still be (re)stamped — every gate
 * BEFORE the human approves.
 *
 * Once the gate reaches `spec-approved`, the digest is a locked contract: it is
 * the fingerprint of the exact text a human signed off. Re-stamping it after
 * that would silently re-bless a post-approval edit and quietly disarm
 * `hooks/spec-integrity-guard.mjs`, whose whole job is to notice the digest no
 * longer matches and roll the gate back to `spec-draft`. From `spec-approved`
 * onward the digest belongs to that hook alone.
 * @type {ReadonlySet<string>}
 */
const DIGEST_STAMPABLE_GATES = new Set([
  'no-lane',
  'lane-set',
  'discovery-done',
  'grill-done',
  'plan-done',
  'plan-approved',
  'spec-draft',
  'spec-invalidated',
]);

/**
 * Stamp `artifactHashes.spec` + `artifactHashes.specDigest` onto task state from
 * the spec on disk.
 *
 * `spec-writer` is contracted to record these (its return contract demands a
 * `specDigest`) but is declared `tools: ['edit']` — it can type the spec's text
 * and nothing else. An LLM cannot compute SHA-256 by hand, so the digest was
 * never recorded, and `gate-preconditions` then refused `impl-started` for want
 * of it. The host hashes the file it just saw written; the agent never has to.
 *
 * Returns null when there is nothing to stamp (no spec, no change, or the spec
 * is already approved), so the caller leaves state alone.
 * @param {string} repoRoot
 * @param {TaskState} state
 * @returns {Promise<TaskState|null>}
 */
export async function stampSpecDigest(repoRoot, state) {
  if (!DIGEST_STAMPABLE_GATES.has(state.workflowGate)) return null;

  const specPath = join(repoRoot, SPEC_REL_PATH);
  if (!pathExists(specPath)) return null;

  const markdown = await readTextFile(specPath);
  if (markdown.trim() === '') return null;

  const digest = specDigestOf(markdown);

  // Compared through `digestsEqual` (the same constant-time-shaped helper
  // spec-integrity-guard uses), never a bare `===` on a hash.
  const recordedPath = state.artifactHashes['spec'];
  if (recordedPath === specPath && digestsEqual(state.artifactHashes['specDigest'], digest)) {
    return null; // already current — do not churn the state file
  }

  return /** @type {TaskState} */ ({
    ...state,
    artifactHashes: {
      ...state.artifactHashes,
      spec: specPath,
      specDigest: digest,
    },
  });
}

/**
 * One gate move made by {@link advanceAlongLane}.
 * @typedef {Object} GateMove
 * @property {WorkflowGate} from
 * @property {WorkflowGate} to
 * @property {GateEvent} event
 */

/**
 * Walk the lane's chain, advancing as far as the evidence on disk allows, and
 * stop at the first gate whose precondition is unmet.
 *
 * Catch-up is deliberate: a hook that fires late (or after a session restart)
 * advances every gate whose artifact has since landed, rather than only the one
 * that just arrived. That makes the advance a pure function of what is on disk
 * — idempotent, and impossible to desync by missing a single hook invocation.
 *
 * Bounded by the chain length, so it cannot loop.
 *
 * @param {TaskState} state
 * @param {{ stateDir: string }} opts  Absolute path to `.devmate/state`.
 * @returns {Promise<{ state: TaskState, moves: GateMove[], blockedBy: string|null }>}
 *          `blockedBy` is the precondition failure that stopped the walk — the
 *          evidence boundary — or null when the chain simply ran out (a human
 *          gate, or nothing left to do).
 */
export async function advanceAlongLane(state, opts) {
  /** @type {GateMove[]} */
  const moves = [];
  let current = state;
  /** @type {string|null} */
  let blockedBy = null;

  const chain = getOwn(LANE_CHAINS, current.lane) ?? [];

  for (let i = 0; i < chain.length; i++) {
    const laneTable = getOwn(TRANSITIONS, current.lane);
    const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, current.workflowGate);
    if (gateTable === undefined) break;

    // The one chain event legal from the gate we are standing on. When the gate
    // accepts no chain event, we are at a human gate (or the end) — stop.
    const event = chain.find((candidate) => getOwn(gateTable, candidate) !== undefined);
    if (event === undefined) break;

    const result = await transitionGate(current, event, { stateDir: opts.stateDir });
    if (!result.ok) {
      // The evidence boundary: the artifact this gate requires is not on disk
      // (or does not validate). Not an error — the workflow simply has not got
      // there yet.
      blockedBy = result.error ?? 'gate precondition not met';
      break;
    }

    const { from, to, state: next } = result;
    if (from === undefined || to === undefined || next === undefined) break;

    moves.push({ from, to, event });
    current = next;
  }

  return { state: current, moves, blockedBy };
}
