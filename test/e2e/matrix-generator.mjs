// @ts-check
/**
 * Model layer for the exhaustive (gate × event × lane) transition matrix
 * (issue #9). PURE: no I/O, no clock — every export is derived from the same
 * frozen tables the runtime uses (`lib/gate-transitions.mjs`,
 * `lib/workflow/gate-advance.mjs`, `lib/gatectl.mjs`), so the oracle and the
 * hooks share exactly one source of truth: the table file itself. The suite
 * (`transition-matrix.e2e.test.mjs`) drives the real subprocesses; any
 * divergence between what this model derives and what the hooks do is a bug
 * by definition.
 *
 * The one thing the tables cannot express is what a SEED WORKSPACE carries:
 * which evidence artifacts exist at each resting gate. That knowledge lives
 * here as {@link seedContext} — a declarative mirror of the drive recipes the
 * suite executes — and is guarded by the hand-pinned {@link GOLDEN_CELLS},
 * whose expectations are hard-coded rather than derived, so a broken
 * generator cannot silently green the matrix it generated.
 */
import { TRANSITIONS, STEERING, legalTransitions } from '../../lib/gate-transitions.mjs';
import { LANE_CHAINS } from '../../lib/workflow/gate-advance.mjs';
import { isLegalTransition } from '../../lib/gatectl.mjs';
import { getOwn } from '../../lib/object-utils.mjs';

/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */

/** The three lanes, in canonical order. @type {readonly Lane[]} */
export const LANES = Object.freeze(['feature', 'bug', 'chore']);

/**
 * The RESTING gates seedable per lane by driving the real hooks — the gates a
 * task can actually be observed at between events. Derived from the lane
 * chains: a gate whose successor edge has a precondition-free target is
 * transient (the catch-up walker passes through it in the same PostToolUse),
 * so it can never be a resting state and is excluded below with a reason.
 * @type {Readonly<Record<Lane, readonly WorkflowGate[]>>}
 */
export const SEEDABLE_GATES = Object.freeze({
  feature: Object.freeze(
    /** @type {WorkflowGate[]} */ ([
      'no-lane',
      'lane-set',
      'discovery-done',
      'grill-done',
      'plan-done',
      'spec-draft',
      'spec-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
      'done',
      'parked',
      'abandoned',
    ]),
  ),
  bug: Object.freeze(
    /** @type {WorkflowGate[]} */ ([
      'no-lane',
      'lane-set',
      'plan-approved',
      'impl-started',
      'verification-passed',
      'pr-ready',
      'done',
      'parked',
      'abandoned',
    ]),
  ),
  chore: Object.freeze(
    /** @type {WorkflowGate[]} */ ([
      'no-lane',
      'impl-started',
      'verification-passed',
      'done',
      'parked',
      'abandoned',
    ]),
  ),
});

/**
 * (lane, gate) rows deliberately absent from the matrix, each with the reason
 * — printed by the suite so an exclusion is a visible decision, never a
 * silent gap (the issue's "no silent caps" discipline).
 * @type {readonly { lane: Lane, gate: string, reason: string }[]}
 */
export const EXCLUDED_ROWS = Object.freeze([
  {
    lane: /** @type {Lane} */ ('feature'),
    gate: 'plan-approved',
    reason:
      'no runtime edge enters plan-approved on the feature lane (the chain goes plan-done → spec-draft); seeding it would fabricate a state the runtime cannot reach',
  },
  {
    lane: /** @type {Lane} */ ('feature'),
    gate: 'spec-invalidated',
    reason:
      'no runtime writer sets spec-invalidated (the integrity guard rolls back to spec-draft); hand-setting it would test a fantasy state',
  },
  {
    lane: /** @type {Lane} */ ('bug'),
    gate: 'grill-done',
    reason:
      'transient on the bug lane: present-plan has no precondition, so the catch-up walker passes through grill-done to plan-approved in the same PostToolUse',
  },
  {
    lane: /** @type {Lane} */ ('chore'),
    gate: 'lane-set',
    reason:
      'transient on the chore lane: present-plan and start-impl are precondition-free for chore, so the walker runs no-lane → impl-started mechanically',
  },
  {
    lane: /** @type {Lane} */ ('chore'),
    gate: 'plan-approved',
    reason: 'transient on the chore lane (see lane-set): never a resting state',
  },
  {
    lane: /** @type {Lane} */ ('chore'),
    gate: 'pr-ready',
    reason:
      'defensive table row only: the chore lane completes from verification-passed and never enters pr-ready at runtime',
  },
]);

/**
 * The gate a parked seed was parked FROM per lane — the pointer's recorded
 * gate, and therefore the dynamic target of `resume` at `parked`.
 * @type {Readonly<Record<Lane, WorkflowGate>>}
 */
export const PARKED_FROM = Object.freeze({
  feature: /** @type {WorkflowGate} */ ('lane-set'),
  bug: /** @type {WorkflowGate} */ ('plan-approved'),
  chore: /** @type {WorkflowGate} */ ('impl-started'),
});

/**
 * One matrix event: something a user, the host, or an agent return does to a
 * session. `kind` selects the driver in the suite.
 * @typedef {Object} MatrixEvent
 * @property {string} id
 * @property {'phrase'|'gatectl'|'return'|'malformed'|'tamper'} kind
 * @property {string} [prompt]     UserPromptSubmit text (kind phrase).
 * @property {GateEvent} [event]   gatectl workflow-set event (kind gatectl).
 * @property {string} [agent]      Agent name (kind return).
 */

/** Every event class the matrix drives. @type {readonly MatrixEvent[]} */
export const EVENTS = Object.freeze([
  { id: 'approve-spec', kind: 'phrase', prompt: 'approve spec' },
  { id: 'approve-plan', kind: 'phrase', prompt: 'approve plan' },
  { id: 'approve-pr', kind: 'phrase', prompt: 'approve pr' },
  { id: 'revise-spec', kind: 'phrase', prompt: 'revise spec: tighten the wording' },
  { id: 'status-question', kind: 'phrase', prompt: 'status?' },
  { id: 'steer-revise-scope', kind: 'gatectl', event: /** @type {GateEvent} */ ('revise-scope') },
  { id: 'steer-re-plan', kind: 'gatectl', event: /** @type {GateEvent} */ ('re-plan') },
  { id: 'steer-new-requirements', kind: 'gatectl', event: /** @type {GateEvent} */ ('new-requirements') },
  { id: 'steer-park', kind: 'gatectl', event: /** @type {GateEvent} */ ('park') },
  { id: 'steer-resume', kind: 'gatectl', event: /** @type {GateEvent} */ ('resume') },
  { id: 'steer-abandon', kind: 'gatectl', event: /** @type {GateEvent} */ ('abandon') },
  { id: 'return-router', kind: 'return', agent: 'router' },
  { id: 'return-discovery', kind: 'return', agent: 'discovery' },
  { id: 'return-grill', kind: 'return', agent: 'rubber-duck-grill' },
  { id: 'return-critique', kind: 'return', agent: 'rubber-duck-critique' },
  { id: 'return-planner', kind: 'return', agent: 'planner' },
  { id: 'return-diagnose', kind: 'return', agent: 'diagnose' },
  { id: 'return-malformed', kind: 'malformed' },
  { id: 'tamper-gate', kind: 'tamper' },
]);

/**
 * One matrix cell.
 * @typedef {Object} MatrixCell
 * @property {Lane} lane
 * @property {WorkflowGate} gate
 * @property {MatrixEvent} event
 */

/**
 * Enumerate every (lane × seedable gate × event) cell.
 * @returns {MatrixCell[]}
 */
export function enumerateCells() {
  /** @type {MatrixCell[]} */
  // @bounded-alloc — |lanes| × |gates| × |events|, all frozen finite lists.
  const cells = [];
  for (const lane of LANES) {
    for (const gate of SEEDABLE_GATES[lane]) {
      for (const event of EVENTS) {
        cells.push({ lane, gate, event });
      }
    }
  }
  return cells;
}

/**
 * What a seed workspace at (lane, gate) carries — a declarative mirror of the
 * drive recipes in the suite. `artifacts` are `.devmate/state/` evidence
 * files; `spec` says whether/which spec.md exists; `verify` whether fresh,
 * digest-matching verify evidence exists.
 * @typedef {Object} SeedContext
 * @property {ReadonlySet<string>} artifacts
 * @property {'none'|'nofiles'|'full'} spec
 * @property {boolean} verify
 */

/** Ordered evidence each feature resting gate has accumulated. */
const FEATURE_EVIDENCE = /** @type {readonly (readonly [WorkflowGate, string|null])[]} */ ([
  ['lane-set', 'router-result.json'],
  ['discovery-done', 'discovery-merged.json'],
  ['grill-done', 'grill-result.json'],
  ['plan-done', 'critique-result.json'],
]);

/**
 * Derive the seed context for (lane, gate) from the recipes.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {SeedContext}
 */
export function seedContext(lane, gate) {
  /** @type {Set<string>} */
  // @bounded-alloc — at most one artifact per pre-implementation gate.
  const artifacts = new Set();
  /** @type {'none'|'nofiles'|'full'} */
  let spec = 'none';
  let verify = false;

  const resolvedGate = gate === 'parked' || gate === 'abandoned' ? PARKED_FROM[lane] : gate;

  if (lane === 'feature') {
    const order = SEEDABLE_GATES.feature;
    const idx = order.indexOf(resolvedGate);
    for (const [g, artifact] of FEATURE_EVIDENCE) {
      if (order.indexOf(g) <= idx && artifact !== null) artifacts.add(artifact);
    }
    // spec-approved is the continuation-failure seed (spec with no files
    // section, no metadata); spec-draft onward carry the full spec.
    if (resolvedGate === 'spec-approved') spec = 'nofiles';
    else if (idx >= order.indexOf('spec-draft')) spec = 'full';
    if (idx >= order.indexOf('verification-passed')) verify = true;
  } else if (lane === 'bug') {
    const order = SEEDABLE_GATES.bug;
    const idx = order.indexOf(resolvedGate);
    if (idx >= order.indexOf('lane-set')) artifacts.add('router-result.json');
    if (idx >= order.indexOf('plan-approved')) artifacts.add('grill-result.json');
    if (idx >= order.indexOf('verification-passed')) verify = true;
  } else {
    const order = SEEDABLE_GATES.chore;
    const idx = order.indexOf(resolvedGate);
    if (idx >= order.indexOf('impl-started')) artifacts.add('router-result.json');
    if (idx >= order.indexOf('verification-passed')) verify = true;
  }

  return { artifacts, spec, verify };
}

/**
 * Model of each target gate's entry precondition, evaluated against a seed
 * context. Mirrors `lib/gate-preconditions.mjs` for the gates the matrix can
 * reach; gates absent here pass trivially (as in the real map).
 * @param {Lane} lane
 * @param {WorkflowGate} target
 * @param {SeedContext} ctx
 * @returns {{ ok: boolean, mention: string }}  `mention` names the missing
 *   evidence a refusal must surface.
 */
export function preconditionModel(lane, target, ctx) {
  switch (target) {
    case 'lane-set':
      return { ok: ctx.artifacts.has('router-result.json'), mention: 'router' };
    case 'discovery-done':
      return { ok: ctx.artifacts.has('discovery-merged.json'), mention: 'discovery' };
    case 'grill-done':
      return { ok: ctx.artifacts.has('grill-result.json'), mention: 'grill' };
    case 'plan-done':
      return { ok: ctx.artifacts.has('critique-result.json'), mention: 'critique' };
    case 'spec-draft':
    case 'spec-approved':
      return { ok: ctx.spec !== 'none', mention: 'spec.md' };
    case 'impl-started':
      // Feature demands recorded spec metadata (stamped whenever a spec was
      // written pre-approval); bug/chore have no spec requirement.
      return { ok: lane !== 'feature' || ctx.spec !== 'none', mention: 'spec' };
    case 'verification-passed':
      return { ok: ctx.verify, mention: 'verify' };
    default:
      // pr-ready (config-gated checks off by default), done, parked (the
      // pointer is cell-seeded), abandoned: no entry requirement here.
      return { ok: true, mention: '' };
  }
}

/**
 * Simulate the PostToolUse catch-up walker: from `gate`, follow the lane
 * chain as far as the (seed ∪ projected) evidence allows. Mirrors
 * `advanceAlongLane`, but driven purely from the tables + the seed model.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @param {SeedContext} ctx
 * @returns {WorkflowGate}
 */
export function chainWalk(lane, gate, ctx) {
  let current = gate;
  const chain = LANE_CHAINS[lane];
  for (let i = 0; i < chain.length; i++) {
    const laneTable = getOwn(TRANSITIONS, lane);
    const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, current);
    if (gateTable === undefined) break;
    const event = chain.find((candidate) => getOwn(gateTable, candidate) !== undefined);
    if (event === undefined) break;
    const target = /** @type {WorkflowGate} */ (getOwn(gateTable, event));
    if (!preconditionModel(lane, target, ctx).ok) break;
    current = target;
  }
  return current;
}

/** The canonical artifact each matrix return projects (or null when none is gate evidence). */
const RETURN_PROJECTION = Object.freeze(
  /** @type {Record<string, string|null>} */ ({
    router: 'router-result.json',
    discovery: 'discovery-merged.json',
    'rubber-duck-grill': 'grill-result.json',
    'rubber-duck-critique': 'critique-result.json',
    planner: null, // plan.json + scope.md — dispatch-gate evidence, not gate evidence
    diagnose: null, // diagnosis.json + scope.md — dispatch-gate evidence, not gate evidence
  }),
);

/**
 * The oracle's verdict for one cell.
 * @typedef {Object} ExpectedOutcome
 * @property {'advance'|'no-move'|'refusal'|'revision'|'desync'|'skip'} kind
 * @property {WorkflowGate} [to]        Expected gate after (kind advance).
 * @property {string} [mustMention]     Substring the refusal/no-op output must carry.
 * @property {string} [reason]          Why the cell is skipped (kind skip).
 */

/**
 * Derive the expected outcome of driving `cell.event` at `(lane, gate)` —
 * read from the tables, never from the hooks.
 * @param {MatrixCell} cell
 * @returns {ExpectedOutcome}
 */
export function expectedOutcome(cell) {
  const { lane, gate, event } = cell;
  const ctx = seedContext(lane, gate);

  if (event.kind === 'phrase') {
    return expectedPhraseOutcome(lane, gate, event, ctx);
  }

  if (event.kind === 'gatectl') {
    return expectedSteeringOutcome(lane, gate, /** @type {GateEvent} */ (event.event), ctx);
  }

  if (event.kind === 'return') {
    const agent = /** @type {string} */ (event.agent);
    // A router return names the seed's own lane, so the lane never flips.
    const projected = getOwn(RETURN_PROJECTION, agent) ?? null;
    /** @type {Set<string>} */
    const withProjection = new Set(ctx.artifacts);
    if (projected !== null) withProjection.add(projected);
    const end = chainWalk(lane, gate, { ...ctx, artifacts: withProjection });
    return end === gate ? { kind: 'no-move' } : { kind: 'advance', to: end };
  }

  if (event.kind === 'malformed') {
    return { kind: 'no-move' };
  }

  // tamper: hand-set workflowGate to impl-started with no supporting
  // evidence, then prompt. Only meaningful at gates strictly BEFORE
  // impl-started (forging a gate you legitimately hold is not a forgery),
  // and only where a trace exists to diverge from (no-lane sessions have no
  // events yet, so the consistency check has nothing to compare).
  const tamperable =
    gate !== 'no-lane' &&
    gate !== 'parked' &&
    gate !== 'abandoned' &&
    !['impl-started', 'verification-passed', 'pr-ready', 'done'].includes(gate);
  if (!tamperable) {
    return { kind: 'skip', reason: `tamper-gate is not meaningful at ${gate}` };
  }
  // A gate whose OWN legal next hop is impl-started (the non-audited
  // start-impl edge: feature/spec-approved, bug/plan-approved) cannot read a
  // forged impl-started as tampering: the evidence chain legitimately backs
  // that hop, so the forgery is indistinguishable from a real advance whose
  // trace line is optional. The anchor stays quiet BY DESIGN there — what
  // actually contains the forged state at impl-started is the dispatch gate
  // (scope/spec/diagnosis requirements), not the consistency line. Verified
  // empirically against lib/gate-consistency.mjs's backedIndex walk.
  const laneTable = getOwn(TRANSITIONS, lane);
  const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, gate);
  if (gateTable !== undefined && getOwn(gateTable, 'start-impl') !== undefined) {
    return {
      kind: 'skip',
      reason: `a forged impl-started is one legal non-audited hop from ${gate} — consistent by design; containment is the dispatch gate`,
    };
  }
  return { kind: 'desync' };
}

/**
 * Oracle for the UserPromptSubmit phrase events.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @param {MatrixEvent} event
 * @param {SeedContext} ctx
 * @returns {ExpectedOutcome}
 */
function expectedPhraseOutcome(lane, gate, event, ctx) {
  if (event.id === 'status-question') {
    return { kind: 'no-move' };
  }

  if (event.id === 'revise-spec') {
    return { kind: 'revision' };
  }

  if (event.id === 'approve-spec') {
    if (lane === 'feature' && gate === 'spec-draft') {
      // advanceHumanGate → spec-approved, then continuation (full spec +
      // metadata in this seed) → impl-started.
      return { kind: 'advance', to: /** @type {WorkflowGate} */ ('impl-started') };
    }
    if (lane === 'feature' && gate === 'spec-approved') {
      // Idempotent resume path; this seed's continuation fails again (no
      // files section), so the gate stays durably approved.
      return { kind: 'no-move', mustMention: 'Continuation failed' };
    }
    if (gate === 'impl-started') {
      return { kind: 'no-move', mustMention: 'already approved' };
    }
    // Everywhere else advanceHumanGate refuses (illegal edge, precondition,
    // or the #20 parked guard — a parked task accepts only resume/abandon)
    // and the hook says so on the model-visible channel.
    return { kind: 'no-move', mustMention: 'did not advance' };
  }

  if (event.id === 'approve-plan') {
    // The hook drives transitionGate(state, 'start-impl'): lane-owned table +
    // impl-started precondition.
    const laneTable = getOwn(TRANSITIONS, lane);
    const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, gate);
    const target = gateTable === undefined ? undefined : getOwn(gateTable, 'start-impl');
    if (target !== undefined && preconditionModel(lane, target, ctx).ok) {
      return { kind: 'advance', to: target };
    }
    return { kind: 'no-move', mustMention: 'did not advance' };
  }

  // approve-pr: advanceHumanGate over the FLATTENED (lane-agnostic) table —
  // except at `parked`, which the #20 guard refuses outright (the resume
  // fan-out is for `resume`'s dynamic target, never an approval edge).
  if (gate === 'pr-ready') {
    return { kind: 'no-move', mustMention: 'already marked ready' };
  }
  if (gate !== 'parked' && isLegalTransition(gate, 'pr-ready')) {
    return { kind: 'advance', to: /** @type {WorkflowGate} */ ('pr-ready') };
  }
  return { kind: 'no-move', mustMention: 'did not advance' };
}

/**
 * Oracle for the gatectl steering events. Cell copies always carry a
 * scope-change note and (for non-parked gates) a resume pointer for the
 * CURRENT gate, so event-scoped preconditions never mask edge legality —
 * the artifact-missing refusal class is covered by the steering suite.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @param {GateEvent} steeringEvent
 * @param {SeedContext} ctx
 * @returns {ExpectedOutcome}
 */
function expectedSteeringOutcome(lane, gate, steeringEvent, ctx) {
  // resume's target is dynamic: the pointer's recorded gate.
  if (steeringEvent === 'resume') {
    if (gate !== 'parked') {
      return { kind: 'refusal', mustMention: 'does not accept event "resume"' };
    }
    const target = PARKED_FROM[lane];
    const pre = preconditionModel(lane, target, ctx);
    return pre.ok
      ? { kind: 'advance', to: target }
      : { kind: 'refusal', mustMention: pre.mention };
  }

  const laneTable = getOwn(TRANSITIONS, lane);
  const gateTable = laneTable === undefined ? undefined : getOwn(laneTable, gate);
  const steeringTable = getOwn(STEERING, gate);
  const target =
    (gateTable === undefined ? undefined : getOwn(gateTable, steeringEvent)) ??
    (steeringTable === undefined ? undefined : getOwn(steeringTable, steeringEvent));

  if (target === undefined) {
    return { kind: 'refusal', mustMention: `does not accept event "${steeringEvent}"` };
  }

  const pre = preconditionModel(lane, target, ctx);
  return pre.ok ? { kind: 'advance', to: target } : { kind: 'refusal', mustMention: pre.mention };
}

/**
 * Hand-pinned golden cells: hard-coded expectations that must NEVER be
 * derived from the generator, so a broken oracle cannot green its own
 * matrix. Each is checked against {@link expectedOutcome} by the suite —
 * a mismatch fails the run before any subprocess is spawned.
 * @type {readonly { lane: Lane, gate: WorkflowGate, eventId: string, expect: ExpectedOutcome }[]}
 */
export const GOLDEN_CELLS = Object.freeze([
  { lane: 'feature', gate: 'spec-draft', eventId: 'approve-spec', expect: { kind: 'advance', to: 'impl-started' } },
  { lane: 'feature', gate: 'discovery-done', eventId: 'approve-spec', expect: { kind: 'no-move', mustMention: 'did not advance' } },
  { lane: 'bug', gate: 'plan-approved', eventId: 'approve-plan', expect: { kind: 'advance', to: 'impl-started' } },
  { lane: 'feature', gate: 'impl-started', eventId: 'steer-revise-scope', expect: { kind: 'advance', to: 'spec-draft' } },
  { lane: 'feature', gate: 'parked', eventId: 'steer-resume', expect: { kind: 'advance', to: 'lane-set' } },
  { lane: 'feature', gate: 'abandoned', eventId: 'steer-park', expect: { kind: 'refusal', mustMention: 'does not accept event "park"' } },
  { lane: 'chore', gate: 'no-lane', eventId: 'return-router', expect: { kind: 'advance', to: 'impl-started' } },
  { lane: 'feature', gate: 'grill-done', eventId: 'return-critique', expect: { kind: 'advance', to: 'plan-done' } },
  { lane: 'feature', gate: 'verification-passed', eventId: 'approve-pr', expect: { kind: 'advance', to: 'pr-ready' } },
  // #20: a parked task accepts only resume/abandon — an approval phrase must
  // never ride the flattened resume fan-out out of parked.
  { lane: 'feature', gate: 'parked', eventId: 'approve-pr', expect: { kind: 'no-move', mustMention: 'did not advance' } },
  { lane: 'feature', gate: 'spec-draft', eventId: 'status-question', expect: { kind: 'no-move' } },
  { lane: 'bug', gate: 'lane-set', eventId: 'return-grill', expect: { kind: 'advance', to: 'plan-approved' } },
  { lane: 'feature', gate: 'plan-done', eventId: 'return-malformed', expect: { kind: 'no-move' } },
]);

/**
 * Select the cells to run.
 *  - 'full'  — every cell (the nightly budget).
 *  - 'smoke' — the golden cells plus every cell whose lane/gate/event name
 *              appears in `changedText` (the PR-diff heuristic from the
 *              issue: cells touching changed lane/gate names re-run cheaply).
 * @param {MatrixCell[]} cells
 * @param {{ mode: string, changedText?: string }} opts
 * @returns {MatrixCell[]}
 */
export function selectCells(cells, opts) {
  if (opts.mode === 'full') return cells;

  const changed = opts.changedText ?? '';
  const goldenKeys = new Set(GOLDEN_CELLS.map((g) => `${g.lane}:${g.gate}:${g.eventId}`));

  return cells.filter((cell) => {
    const key = `${cell.lane}:${cell.gate}:${cell.event.id}`;
    if (goldenKeys.has(key)) return true;
    if (changed === '') return false;
    const gateTouched = changed.includes(`'${cell.gate}'`) || changed.includes(`"${cell.gate}"`);
    const eventName = cell.event.event ?? '';
    const eventTouched = eventName !== '' && (changed.includes(`'${eventName}'`) || changed.includes(`"${eventName}"`));
    return gateTouched || eventTouched;
  });
}

/**
 * Sanity check used by the suite before spawning anything: every golden
 * cell's hard-coded expectation must agree with the derived oracle. A
 * mismatch means the generator (or the tables) changed meaning.
 * @returns {{ ok: boolean, mismatches: string[] }}
 */
export function verifyGoldenAgainstOracle() {
  /** @type {string[]} */
  // @bounded-alloc — at most one entry per golden cell.
  const mismatches = [];
  for (const golden of GOLDEN_CELLS) {
    const event = EVENTS.find((e) => e.id === golden.eventId);
    if (!event) {
      mismatches.push(`${golden.eventId}: unknown event id`);
      continue;
    }
    const derived = expectedOutcome({ lane: golden.lane, gate: golden.gate, event });
    const same =
      derived.kind === golden.expect.kind &&
      (golden.expect.to === undefined || derived.to === golden.expect.to);
    if (!same) {
      mismatches.push(
        `${golden.lane}/${golden.gate} × ${golden.eventId}: golden=${JSON.stringify(golden.expect)} oracle=${JSON.stringify(derived)}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * How many cells the full matrix contains — surfaced so the nightly log
 * records the covered space explicitly.
 * @returns {{ cells: number, lanes: number, events: number, excludedRows: number }}
 */
export function matrixDimensions() {
  return {
    cells: enumerateCells().length,
    lanes: LANES.length,
    events: EVENTS.length,
    excludedRows: EXCLUDED_ROWS.length,
  };
}

/**
 * Whether the (lane, gate) pair legally accepts ANY event — used by the suite
 * to sanity-print terminal rows. Pure passthrough of the runtime's own
 * projection so reports can never disagree with it.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {boolean}
 */
export function isTerminalRow(lane, gate) {
  return legalTransitions(lane, gate).length === 0;
}
