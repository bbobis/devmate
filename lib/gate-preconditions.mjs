// @ts-check
// E9-15: artifact preconditions for gate transitions. Each mapped gate names
// the artifact(s) that must exist — and validate — before the workflow may
// enter it, turning grill-before-plan / critique-before-spec sequencing from
// prompt prose into structure.
import { join, resolve } from 'node:path';
import { validateGrillResult, validateCritiqueResult, validatePrReviewResult } from './workflow/contracts.mjs';
import { validateDiscoveryArtifact } from './workflow/agents/discovery.mjs';
import { checkSpecApprovedPrecondition } from './gate-guard.mjs';
import { parseRouterResult, MIN_ROUTER_CONFIDENCE } from './routing/router.mjs';
import { getOwn } from './object-utils.mjs';
import { digestsEqual } from './digest-compare.mjs';
import { readJsonFile, parseJsonl } from './json-io.mjs';
import { pathExists, readTextFile, readTextFileSync } from './fs-safe.mjs';
import {
  loadDevmateConfig,
  resolveDelegationFloorMode,
  resolveDelegationFloorRequirements,
  resolveAcCoverageGateMode,
  resolvePrReviewGateMode,
} from './config/devmate-config.mjs';
import { LANE_DISPATCH_REQUIREMENTS, missingLaneDispatches } from './workflow/orchestrator.mjs';
import { appendTraceEvent } from './trace/append.mjs';
import { readTrace } from './trace/read-trace.mjs';
import { completedAcNumbers, computeAcCoverage, parseAcceptanceCriteria } from './spec-progress.mjs';

/** @typedef {import('./types.mjs').GateEvent} GateEvent */
/** @typedef {import('./types.mjs').ResumePointer} ResumePointer */
/** @typedef {import('./types.mjs').ScopeChangeNote} ScopeChangeNote */

/**
 * Maximum age of a verify-result.json artifact before it is considered stale.
 * TODO: calibrate maxAge after E7 evals — provisional
 * @type {number}
 */
export const MAX_VERIFY_AGE_MS = 30 * 60 * 1000;

/**
 * Artifact filename (under the state dir) for the persisted resume pointer
 * required before a task may be parked (E10-05).
 * @type {string}
 */
export const RESUME_POINTER_FILENAME = 'resume-pointer.json';

/**
 * Artifact filename (under the state dir) for the captured scope-change note
 * required by the revise-scope steering event (E10-05).
 * @type {string}
 */
export const SCOPE_CHANGE_NOTE_FILENAME = 'scope-change.json';

/**
 * Result of a gate precondition check.
 * @typedef {Object} PreconditionResult
 * @property {boolean} ok
 * @property {string[]} missing  Human-readable list of unmet requirements.
 */

/**
 * Context for a precondition check.
 * @typedef {Object} PreconditionCtx
 * @property {string} stateDir   Directory holding the state artifacts (.devmate/state).
 * @property {string} lane
 * @property {GateEvent} [event] Gate event driving this transition (E10-05): steering
 *                               events may attach an event-scoped requirement on top
 *                               of the target gate's own precondition.
 * @property {string} [taskId]   Current task id; when present, task-scoped artifacts
 *                               (resume pointer, scope-change note) must belong to it.
 */

/**
 * Read + JSON-parse an artifact, or return null when absent/unparseable.
 * @param {string} filePath
 * @returns {Promise<unknown|null>}
 */
async function readJsonArtifact(filePath) {
  return readJsonFile(filePath);
}

/**
 * Which gate demands which artifact, as DATA rather than as a string buried in a
 * closure.
 *
 * `scripts/check-artifact-graph.mjs` reads this to prove that every artifact a gate
 * requires is one some agent can actually produce. That check is the whole reason
 * this map exists: `grill-done` required `grill-result.json`, the only writer of
 * that file could never fire, and nothing in the repo could see the contradiction —
 * because one half lived in a closure here and the other in a validator over there.
 * A gate that demands an unwritable artifact is a dead end, and a dead end should be
 * a build failure, not a support ticket.
 *
 * Populated by {@link requireArtifact} at module load.
 * @type {Map<string, string>}
 */
const GATE_ARTIFACTS = new Map();

/**
 * Every (gate → required artifact) pair the precondition layer enforces.
 * @returns {ReadonlyMap<string, string>}
 */
export function gateRequiredArtifacts() {
  return GATE_ARTIFACTS;
}

/**
 * Build a validated-artifact precondition.
 * @param {string} gate      The gate this artifact is the evidence for.
 * @param {string} filename  Artifact file under ctx.stateDir.
 * @param {string} label     Human-readable artifact name.
 * @param {(artifact: unknown) => { ok: boolean, errors: string[] }} [validator]
 * @returns {(ctx: PreconditionCtx) => Promise<PreconditionResult>}
 */
function requireArtifact(gate, filename, label, validator) {
  GATE_ARTIFACTS.set(gate, filename);
  return async (ctx) => {
    const filePath = join(ctx.stateDir, filename);
    const artifact = await readJsonArtifact(filePath);
    if (artifact === null) {
      return {
        ok: false,
        missing: [`${label} not found (or unparseable) at ${filePath} — produce it before this transition.`],
      };
    }
    if (validator !== undefined) {
      const verdict = validator(artifact);
      if (!verdict.ok) {
        return {
          ok: false,
          missing: verdict.errors.map((e) => `${label} invalid: ${e}`),
        };
      }
    }

    // The artifact must belong to THIS task. These files live flat under
    // `.devmate/state/`, one name per artifact, and nothing on earth deletes them
    // between tasks — so a `grill-result.json` or `diagnosis.json` left behind by an
    // earlier task satisfied a later task's gate unchanged, and a superseded
    // diagnosis went on authorizing a fix nobody had re-diagnosed. Existence and
    // shape were checked; ownership never was. Sibling predicates in this same file
    // already compare `ctx.taskId` (pr-review, parked, revise-scope) — this one just
    // never did.
    //
    // BOTH sides must be known before this can refuse anything:
    //   - no `ctx.taskId` → the caller did not say which task is asking, so there is
    //     nothing to compare against. Refusing here would reject perfectly good,
    //     freshly-stamped evidence and wedge the gate — the very failure this whole
    //     change exists to end, merely pointing the other way.
    //   - no `taskId` on the artifact → it predates the stamp; refusing it would
    //     strand a task that is already mid-flight across an upgrade.
    // The real caller always supplies one: `transitionGate` passes
    // `taskId: state.taskId` on every transition, and
    // `test/lib/workflow/gate-advance.test.mjs` asserts a foreign-task artifact is
    // refused through that path — so this check cannot quietly go inert.
    const owner = artifactTaskId(artifact);
    const asker = typeof ctx.taskId === 'string' ? ctx.taskId.trim() : '';
    if (owner !== null && asker !== '' && owner !== asker) {
      return {
        ok: false,
        missing: [
          `${label} at ${filePath} belongs to task "${owner}", not "${asker}" — it is stale evidence from an earlier task. Re-dispatch the agent that produces it.`,
        ],
      };
    }

    return { ok: true, missing: [] };
  };
}

/**
 * The task an artifact declares it belongs to, or null when it declares none.
 * @param {unknown} artifact
 * @returns {string|null}
 */
function artifactTaskId(artifact) {
  if (artifact === null || typeof artifact !== 'object') return null;
  const taskId = getOwn(/** @type {Record<string, unknown>} */ (artifact), 'taskId');
  return typeof taskId === 'string' && taskId.trim() !== '' ? taskId : null;
}

/**
 * Structurally validate a resume pointer artifact (E10-05).
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateResumePointer(artifact) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['must be a JSON object'] };
  }
  const a = /** @type {Record<string, unknown>} */ (artifact);
  /** @type {string[]} */
  const errors = [];
  if (typeof a.taskId !== 'string' || a.taskId.trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (typeof a.gate !== 'string' || a.gate.trim() === '') {
    errors.push('gate must be a non-empty string naming the gate to resume to');
  }
  if (typeof a.parkedAt !== 'string' || !Number.isFinite(Date.parse(a.parkedAt))) {
    errors.push('parkedAt must be an ISO-8601 timestamp');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Structurally validate a scope-change note artifact (E10-05).
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateScopeChangeNote(artifact) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['must be a JSON object'] };
  }
  const a = /** @type {Record<string, unknown>} */ (artifact);
  /** @type {string[]} */
  const errors = [];
  if (typeof a.taskId !== 'string' || a.taskId.trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (typeof a.note !== 'string' || a.note.trim() === '') {
    errors.push('note must be a non-empty string describing what changed about the scope');
  }
  if (typeof a.capturedAt !== 'string' || !Number.isFinite(Date.parse(a.capturedAt))) {
    errors.push('capturedAt must be an ISO-8601 timestamp');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Read + structurally validate the persisted resume pointer from the state
 * dir (E10-05). Used both by the parked-gate precondition (a park is refused
 * without it) and by the resume transition in `lib/gate-transitions.mjs`
 * (the pointer names the gate to return to).
 * @param {string} stateDir
 * @returns {Promise<{ ok: true, pointer: ResumePointer } | { ok: false, error: string }>}
 */
export async function readResumePointer(stateDir) {
  const filePath = join(stateDir, RESUME_POINTER_FILENAME);
  const artifact = await readJsonArtifact(filePath);
  if (artifact === null) {
    return { ok: false, error: `resume pointer not found (or unparseable) at ${filePath}` };
  }
  const verdict = validateResumePointer(artifact);
  if (!verdict.ok) {
    return { ok: false, error: `resume pointer invalid: ${verdict.errors.join('; ')}` };
  }
  return { ok: true, pointer: /** @type {ResumePointer} */ (artifact) };
}

/**
 * Shared AC-coverage precondition (AC-2 of the deterministic AC coverage
 * harness, epic #416). Reads the approved spec + trace, computes coverage via
 * AC-1's `computeAcCoverage` (`lib/spec-progress.mjs`), and applies the
 * feature-lane zero-AC fail-closed rule: a feature spec that parses to zero
 * acceptance criteria (e.g. a malformed `## Acceptance criteria` heading) is
 * reported as a failure, never a vacuous pass — mirroring
 * `scripts/assert-ac-coverage.mjs`. Non-feature lanes with zero criteria pass
 * trivially (no analysis-coverage expectation).
 *
 * Gated by `acCoverageGate` ('off' default | 'warn' | 'block'), mirroring the
 * `impl-started` delegation-floor precondition's mode resolution and
 * warn-mode `contract_violation` recording: `off` is a complete no-op (no
 * read, no block, no trace churn); `warn` records the violation but allows
 * the transition; `block` refuses it.
 *
 * Shared by the `verification-passed` (merged into the existing verify-
 * evidence check) and `pr-ready` (backstop-only) gate entries below.
 * @param {PreconditionCtx} ctx
 * @returns {Promise<PreconditionResult>}
 */
async function acCoveragePrecondition(ctx) {
  const configPath = resolve(ctx.stateDir, '..', 'devmate.config.json');
  const cfg = loadDevmateConfig(configPath);
  const mode = cfg.ok ? resolveAcCoverageGateMode(cfg.config) : 'off';
  if (mode === 'off') {
    return { ok: true, missing: [] };
  }

  // Locate the trace: prefer ctx.taskId, else the taskId in task.json.
  let taskId = typeof ctx.taskId === 'string' ? ctx.taskId : '';
  if (taskId.trim() === '') {
    const state = await readJsonArtifact(join(ctx.stateDir, 'task.json'));
    const rec = state !== null && typeof state === 'object'
      ? /** @type {Record<string, unknown>} */ (state)
      : {};
    taskId = typeof rec['taskId'] === 'string' ? rec['taskId'] : '';
  }
  if (taskId.trim() === '') {
    // Cannot read the spec/trace. Block mode refuses; warn mode allows silently.
    return mode === 'block'
      ? { ok: false, missing: ['ac-coverage: taskId could not be resolved to read the spec/trace.'] }
      : { ok: true, missing: [] };
  }

  const specPath = resolve(ctx.stateDir, '..', 'session', 'spec.md');
  const markdown = pathExists(specPath) ? readTextFileSync(specPath) : '';
  const criteria = parseAcceptanceCriteria(markdown);

  const { steps } = await readTrace(taskId, { traceDir: join(ctx.stateDir, 'trace') });
  const completedIds = completedAcNumbers(steps);

  const coverage = computeAcCoverage(criteria, completedIds);

  // Fail-closed: a feature-lane spec that parses to zero ACs must not read as
  // vacuously covered.
  const zeroAcFailure = ctx.lane === 'feature' && coverage.total === 0;
  if (!zeroAcFailure && coverage.ok) {
    return { ok: true, missing: [] };
  }

  const missing = zeroAcFailure
    ? ['ac-coverage: no acceptance criteria parsed from spec.md (feature lane requires at least one).']
    : coverage.missing.map((m) => `ac-coverage: AC${m.id} not complete: ${m.text}`);

  if (mode === 'warn') {
    // Record the violation durably (surfaced by the delegation report / Stop
    // advisory, same as delegation-floor) but let the transition proceed.
    try {
      await appendTraceEvent(
        {
          type: 'contract_violation',
          taskId,
          stepId: 'ac-coverage',
          ts: new Date().toISOString(),
          schemaVersion: 1,
          contract: 'ac-coverage',
          path: `${ctx.lane}/ac-coverage`,
          errors: missing,
        },
        { root: resolve(ctx.stateDir, '..', '..') },
      );
    } catch {
      // A trace-append failure must never block the transition in warn mode.
    }
    return { ok: true, missing: [] };
  }

  // block
  return { ok: false, missing };
}

/**
 * Config-gated PR-review precondition (PRR-3). A valid PrReviewArtifact with
 * an APPROVE verdict must exist before the workflow may enter `pr-ready`
 * (feature + bug lanes; chore never enters pr-ready). The artifact is the
 * typed verdict the `/devmate-pr-review` skill writes to
 * `.devmate/state/pr-review-result.json`.
 *
 * Gated by `prReviewGate` ('off' default | 'warn' | 'block'), mirroring
 * `acCoveragePrecondition`'s mode resolution and warn-mode
 * `contract_violation` recording exactly: `off` is a complete no-op (no read,
 * no block, no trace churn); `warn` records the violation but allows the
 * transition; `block` refuses it. A failure is any of: the artifact is
 * missing/unparseable, fails `validatePrReviewResult`, belongs to a different
 * taskId or lane, or carries a non-APPROVE verdict.
 * @param {PreconditionCtx} ctx
 * @returns {Promise<PreconditionResult>}
 */
async function prReviewPrecondition(ctx) {
  const configPath = resolve(ctx.stateDir, '..', 'devmate.config.json');
  const cfg = loadDevmateConfig(configPath);
  const mode = cfg.ok ? resolvePrReviewGateMode(cfg.config) : 'off';
  if (mode === 'off') {
    return { ok: true, missing: [] };
  }

  // Resolve taskId: prefer ctx.taskId, else the taskId in task.json.
  let taskId = typeof ctx.taskId === 'string' ? ctx.taskId : '';
  if (taskId.trim() === '') {
    const state = await readJsonArtifact(join(ctx.stateDir, 'task.json'));
    const rec = state !== null && typeof state === 'object'
      ? /** @type {Record<string, unknown>} */ (state)
      : {};
    taskId = typeof rec['taskId'] === 'string' ? rec['taskId'] : '';
  }
  if (taskId.trim() === '') {
    // Cannot confirm the verdict belongs to this task. Fail closed in block
    // mode; warn/off allow (mirrors acCoveragePrecondition's taskId handling).
    return mode === 'block'
      ? { ok: false, missing: ['pr-review: taskId could not be resolved to verify the review verdict belongs to this task.'] }
      : { ok: true, missing: [] };
  }

  /** @type {string[]} */
  const missing = [];
  const filePath = join(ctx.stateDir, 'pr-review-result.json');
  const artifact = await readJsonArtifact(filePath);
  if (artifact === null) {
    missing.push(
      `pr-review: review verdict not found (or unparseable) at ${filePath} — run the devmate-pr-review skill before this transition.`,
    );
  } else {
    const verdict = validatePrReviewResult(artifact);
    if (!verdict.ok) {
      missing.push(...verdict.errors.map((e) => `pr-review: review verdict invalid: ${e}`));
    } else {
      const a = /** @type {import('./types.mjs').PrReviewArtifact} */ (artifact);
      if (a.taskId !== taskId) {
        missing.push(
          `pr-review: review verdict belongs to task "${a.taskId}", not "${taskId}" — re-review this task's branch.`,
        );
      }
      if (a.lane !== ctx.lane) {
        missing.push(
          `pr-review: review verdict lane "${a.lane}" does not match the current lane "${ctx.lane}" — re-review this task's branch.`,
        );
      }
      if (!a.verdict.startsWith('APPROVE')) {
        missing.push(
          `pr-review: review verdict is "${a.verdict}", not APPROVE — address the findings and re-review before entering pr-ready.`,
        );
      }
    }
  }

  if (missing.length === 0) {
    return { ok: true, missing: [] };
  }

  if (mode === 'warn') {
    // Record the violation durably (surfaced by the delegation report / Stop
    // advisory, same as ac-coverage) but let the transition proceed.
    // Best-effort: a trace-append failure must never block in warn mode.
    if (taskId.trim() !== '') {
      try {
        await appendTraceEvent(
          {
            type: 'contract_violation',
            taskId,
            stepId: 'pr-review',
            ts: new Date().toISOString(),
            schemaVersion: 1,
            contract: 'pr-review',
            path: `${ctx.lane}/pr-ready`,
            errors: missing,
          },
          { root: resolve(ctx.stateDir, '..', '..') },
        );
      } catch {
        // A trace-append failure must never block the transition in warn mode.
      }
    }
    return { ok: true, missing: [] };
  }

  // block
  return { ok: false, missing };
}

/**
 * Gate → precondition map. Gates absent from this map pass trivially.
 * @type {Record<string, (ctx: PreconditionCtx) => Promise<PreconditionResult>>}
 */
const GATE_PRECONDITIONS = {
  // E9-10: the router result must validate AND clear the confidence threshold.
  'lane-set': async (ctx) => {
    const filePath = join(ctx.stateDir, 'router-result.json');
    const artifact = await readJsonArtifact(filePath);
    if (artifact === null) {
      return {
        ok: false,
        missing: [`router result not found (or unparseable) at ${filePath} — run the @router classification first.`],
      };
    }
    const parsed = parseRouterResult(artifact);
    if (!parsed.ok) {
      return { ok: false, missing: [`router result invalid: ${parsed.error}`] };
    }
    if (parsed.result.confidence < MIN_ROUTER_CONFIDENCE) {
      return {
        ok: false,
        missing: [
          `router confidence ${parsed.result.confidence} is below the ${MIN_ROUTER_CONFIDENCE} threshold — escalate to human for lane confirmation.`,
        ],
      };
    }
    return { ok: true, missing: [] };
  },
  // #91: discovery-done had NO precondition — it passed trivially, so a gate
  // driver would advance it on no evidence at all. The merged fan-in artifact
  // is the evidence that discovery actually ran: it is derived from the
  // discovery worker returns, so it cannot exist unless workers returned.
  'discovery-done': requireArtifact(
    'discovery-done',
    'discovery-merged.json',
    'merged discovery artifact',
    validateDiscoveryArtifact,
  ),
  'grill-done': requireArtifact(
    'grill-done',
    'grill-result.json',
    'grill result',
    validateGrillResult,
  ),
  'plan-done': requireArtifact(
    'plan-done',
    'critique-result.json',
    'critique result',
    validateCritiqueResult,
  ),
  // HITL-2: entering the spec-draft human review gate with nothing to review
  // is refused — spec-writer must have written a non-empty spec.md first. The
  // revise-scope steering edge back into spec-draft trivially satisfies this
  // (the spec exists mid-implementation by definition).
  'spec-draft': async (ctx) => {
    const specPath = resolve(ctx.stateDir, '..', 'session', 'spec.md');
    let markdown = '';
    try {
      markdown = pathExists(specPath) ? readTextFileSync(specPath) : '';
    } catch {
      // An unreadable spec (permissions, transient IO) is treated the same as
      // a missing one: fail closed with the structured reason below — a
      // precondition returns a result object, never a throw.
    }
    if (markdown.trim() === '') {
      return {
        ok: false,
        missing: [
          `spec.md is missing, empty, or unreadable at ${specPath} — spec-writer must produce the spec before entering the spec-draft review gate.`,
        ],
      };
    }
    return { ok: true, missing: [] };
  },
  // HITL-2 (always-on, NOT mode-gated): the feature lane may not enter
  // impl-started without recorded spec artifacts — the metadata spec-writer
  // stamps into task.json and the human approves. This closes the structural
  // hole where the delegation floor's default-off mode left the spec gates
  // unenforced. Bug/chore lanes are exempt by design: their artifacts
  // (diagnosis, scope.md) are dispatch-time checks owned by the dispatch gate
  // (lib/workflow/dispatch-gate.mjs), and the bug lane runs @diagnose DURING
  // impl-started.
  //
  // Below it: the opt-in runtime delegation floor (default OFF).
  // `delegationFloor` selects the mode: 'off' (no-op — existing behaviour),
  // 'warn' (record a contract_violation but allow the transition — for
  // graduated rollout), or 'block' (refuse). The legacy boolean
  // `enforceDelegationFloor: true` maps to 'block'. When active, starting
  // implementation requires that the lane's read-heavy analysis was actually
  // delegated — a subagent_start trace event exists for each required
  // specialist group. This is the automatic, prompt-independent counterpart to
  // the orch-assert-floor script: the state machine itself checks for inline work.
  // #92: the "scope.md must exist before implementation" rule is NOT here.
  // It belongs to the dispatch gate (lib/workflow/dispatch-gate.mjs), which is
  // literally the check that runs before @fullstack starts — and which already
  // demanded scope.md for the bug and chore lanes. The feature lane was simply
  // missing from that list. Putting the requirement on the gate transition too
  // would mean a task cannot even REACH impl-started without a contract, which
  // sounds stricter but only moves the failure earlier and further from the
  // thing being bounded.
  'impl-started': async (ctx) => {
    if (ctx.lane === 'feature') {
      const state = await readJsonArtifact(join(ctx.stateDir, 'task.json'));
      const rec = state !== null && typeof state === 'object'
        ? /** @type {Record<string, unknown>} */ (state)
        : {};
      const artifactMeta = rec['artifactHashes'];
      const meta = artifactMeta !== null && typeof artifactMeta === 'object'
        ? /** @type {Record<string, unknown>} */ (artifactMeta)
        : {};
      const hasSpec = Boolean(getOwn(meta, 'spec')) && Boolean(getOwn(meta, 'specDigest'));
      if (!hasSpec) {
        return {
          ok: false,
          missing: [
            'feature lane cannot start implementation without a written and approved spec ' +
              '(missing artifactHashes.spec/specDigest in task.json) — run spec-writer, then "approve spec".',
          ],
        };
      }
    }

    const configPath = resolve(ctx.stateDir, '..', 'devmate.config.json');
    const cfg = loadDevmateConfig(configPath);
    const mode = cfg.ok ? resolveDelegationFloorMode(cfg.config) : 'off';
    if (mode === 'off') {
      return { ok: true, missing: [] };
    }

    // Per-lane requirements may be overridden in config; a lane with no effective
    // groups (default chore, or an override to none) has no floor.
    const requirements = cfg.ok ? resolveDelegationFloorRequirements(cfg.config) : undefined;
    const override = requirements ? getOwn(requirements, ctx.lane) : undefined;
    const effectiveGroups = Array.isArray(override) ? override : getOwn(LANE_DISPATCH_REQUIREMENTS, ctx.lane);
    if (!Array.isArray(effectiveGroups) || effectiveGroups.length === 0) {
      return { ok: true, missing: [] };
    }

    // Locate the trace: prefer ctx.taskId, else the taskId in task.json.
    let taskId = typeof ctx.taskId === 'string' ? ctx.taskId : '';
    if (taskId.trim() === '') {
      const state = await readJsonArtifact(join(ctx.stateDir, 'task.json'));
      const rec = state !== null && typeof state === 'object'
        ? /** @type {Record<string, unknown>} */ (state)
        : {};
      taskId = typeof rec['taskId'] === 'string' ? rec['taskId'] : '';
    }
    if (taskId.trim() === '') {
      // Cannot read the trace. Block mode refuses; warn mode allows silently.
      return mode === 'block'
        ? { ok: false, missing: ['delegation floor is enabled but the taskId could not be resolved to read the dispatch trace.'] }
        : { ok: true, missing: [] };
    }

    /** @type {unknown[]} */
    let events = [];
    try {
      events = parseJsonl(await readTextFile(join(ctx.stateDir, 'trace', `${taskId}.jsonl`)));
    } catch {
      events = [];
    }

    const missing = missingLaneDispatches(ctx.lane, events, requirements);
    if (missing.length === 0) {
      return { ok: true, missing: [] };
    }

    if (mode === 'warn') {
      // Record the violation durably (so the delegation report / Stop advisory
      // can surface it) but let the transition proceed. Best-effort.
      try {
        await appendTraceEvent(
          {
            type: 'contract_violation',
            taskId,
            stepId: 'delegation-floor',
            ts: new Date().toISOString(),
            schemaVersion: 1,
            contract: 'delegation-floor',
            path: `${ctx.lane}/impl-started`,
            errors: missing,
          },
          { root: resolve(ctx.stateDir, '..', '..') },
        );
      } catch {
        // A trace-append failure must never block the transition in warn mode.
      }
      return { ok: true, missing: [] };
    }

    // block
    return {
      ok: false,
      missing: missing.map(
        (group) =>
          `delegation floor: no subagent dispatch recorded for [${group}] before starting implementation — delegate that analysis to a subagent (do not do it inline).`,
      ),
    };
  },
  // E9-13: fresh, passing, spec-matching verify evidence before
  // verification-passed. The artifact is persisted by verifyStep (or by the
  // lane from its own verify result). AC-2 (epic #416) additively merges the
  // shared AC-coverage precondition's `missing` into this same entry so both
  // checks fire and report independently — see acCoveragePrecondition above.
  'verification-passed': async (ctx) => {
    /** @type {string[]} */
    const missing = [];

    const filePath = join(ctx.stateDir, 'verify-result.json');
    const artifact = /** @type {import('./types.mjs').VerifyResultArtifact|null} */ (
      await readJsonArtifact(filePath)
    );
    if (artifact === null) {
      missing.push(`verify evidence not found (or unparseable) at ${filePath} — run the verify step first.`);
    } else if (artifact.passed !== true) {
      missing.push('verify evidence records a failing run — verification must pass first.');
    } else {
      const completedAt = Date.parse(artifact.completedAt ?? '');
      if (!Number.isFinite(completedAt) || Date.now() - completedAt > MAX_VERIFY_AGE_MS) {
        missing.push(
          `verify evidence is stale (completedAt: ${artifact.completedAt ?? 'missing'}; max age ${MAX_VERIFY_AGE_MS} ms) — re-run the verify step.`,
        );
      } else {
        const state = /** @type {{ artifactHashes?: Record<string, string> }|null} */ (
          await readJsonArtifact(join(ctx.stateDir, 'task.json'))
        );
        const expectedSpecDigest = state?.artifactHashes?.specDigest ?? '';
        if (!digestsEqual(artifact.specDigest ?? '', expectedSpecDigest)) {
          missing.push(
            `verify evidence specDigest "${artifact.specDigest}" does not match the approved spec digest "${expectedSpecDigest}" — re-verify against the current spec.`,
          );
        }
      }
    }

    const acVerdict = await acCoveragePrecondition(ctx);
    if (!acVerdict.ok) missing.push(...acVerdict.missing);

    return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
  },
  // AC-2 backstop (epic #416) + PRR-3 pr-review gate. Both checks are
  // config-gated and off by default; each runs and reports independently, and
  // their `missing[]` are concatenated (the additive-merge pattern of the
  // `verification-passed` entry above). AC-coverage is a cheap final backstop
  // (re-dispatch to fix missing ACs is illegal once past impl-started); the
  // pr-review check refuses entry to pr-ready unless a valid APPROVE verdict
  // exists. Chore never enters pr-ready, so this only affects feature + bug.
  'pr-ready': async (ctx) => {
    /** @type {string[]} */
    const missing = [];

    const acVerdict = await acCoveragePrecondition(ctx);
    if (!acVerdict.ok) missing.push(...acVerdict.missing);

    const prVerdict = await prReviewPrecondition(ctx);
    if (!prVerdict.ok) missing.push(...prVerdict.missing);

    return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
  },
  'spec-approved': async (ctx) => {
    // Wired existing precondition (lib/gate-guard.mjs): spec.md lives under
    // the session dir sibling of the state dir.
    const specPath = resolve(ctx.stateDir, '..', 'session', 'spec.md');
    const verdict = checkSpecApprovedPrecondition(specPath);
    return verdict.ok ? { ok: true, missing: [] } : { ok: false, missing: [verdict.reason] };
  },
  // E10-05: a park is refused without a persisted resume pointer — the
  // artifact that records the gate a later resume returns to.
  'parked': async (ctx) => {
    const read = await readResumePointer(ctx.stateDir);
    if (!read.ok) {
      return {
        ok: false,
        missing: [`${read.error} — persist the resume pointer before parking.`],
      };
    }
    if (ctx.taskId !== undefined && read.pointer.taskId !== ctx.taskId) {
      return {
        ok: false,
        missing: [
          `resume pointer belongs to task "${read.pointer.taskId}", not "${ctx.taskId}" — persist a pointer for this task before parking.`,
        ],
      };
    }
    return { ok: true, missing: [] };
  },
};

/**
 * Event-scoped preconditions (E10-05): requirements attached to the steering
 * *event* rather than the target gate, so the normal forward path into the
 * same target stays unaffected (plan-done → spec-draft must not demand a
 * scope-change note; impl-started --revise-scope--> spec-draft must).
 * Events absent from this map add no extra requirement.
 * @type {Record<string, (ctx: PreconditionCtx) => Promise<PreconditionResult>>}
 */
const EVENT_PRECONDITIONS = {
  'revise-scope': async (ctx) => {
    const filePath = join(ctx.stateDir, SCOPE_CHANGE_NOTE_FILENAME);
    const artifact = await readJsonArtifact(filePath);
    if (artifact === null) {
      return {
        ok: false,
        missing: [
          `scope-change note not found (or unparseable) at ${filePath} — capture what changed before re-scoping.`,
        ],
      };
    }
    const verdict = validateScopeChangeNote(artifact);
    if (!verdict.ok) {
      return { ok: false, missing: verdict.errors.map((e) => `scope-change note invalid: ${e}`) };
    }
    const note = /** @type {ScopeChangeNote} */ (artifact);
    if (ctx.taskId !== undefined && note.taskId !== ctx.taskId) {
      return {
        ok: false,
        missing: [
          `scope-change note belongs to task "${note.taskId}", not "${ctx.taskId}" — capture a note for this task before re-scoping.`,
        ],
      };
    }
    return { ok: true, missing: [] };
  },
};

/**
 * Check that the artifacts required to enter `targetGate` exist and validate.
 * When `ctx.event` names a steering event with its own requirement (E10-05),
 * that event-scoped precondition is checked as well; unmet requirements from
 * both checks are merged so the caller sees the full list at once.
 * @param {string} targetGate
 * @param {PreconditionCtx} ctx
 * @returns {Promise<PreconditionResult>}
 */
export async function checkGatePrecondition(targetGate, ctx) {
  /** @type {string[]} */
  const missing = [];

  const gateCheck = getOwn(GATE_PRECONDITIONS, targetGate);
  if (gateCheck !== undefined) {
    const verdict = await gateCheck(ctx);
    if (!verdict.ok) missing.push(...verdict.missing);
  }

  const eventCheck =
    ctx.event !== undefined ? getOwn(EVENT_PRECONDITIONS, ctx.event) : undefined;
  if (eventCheck !== undefined) {
    const verdict = await eventCheck(ctx);
    if (!verdict.ok) missing.push(...verdict.missing);
  }

  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}
