// @ts-check
import { checkGatePrecondition, readResumePointer } from './gate-preconditions.mjs';
import { getOwn } from './object-utils.mjs';

/** @typedef {import('./types.mjs').TaskState} TaskState */
/** @typedef {import('./types.mjs').Lane} Lane */
/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('./types.mjs').GateEvent} GateEvent */
/** @typedef {import('./types.mjs').TransitionResult} TransitionResult */

/**
 * Nested transition table: TRANSITIONS[lane][currentGate][event] -> nextGate
 * @type {Readonly<Record<Lane, Readonly<Partial<Record<WorkflowGate, Readonly<Partial<Record<GateEvent, WorkflowGate>>>>>>>>}
 */
export const TRANSITIONS = Object.freeze({
  feature: Object.freeze({
    // #91: the pre-implementation spine is lane-OWNED and event-keyed, so it is
    // driven by `transitionGate` (lane-aware + precondition-checked) rather than
    // `advanceGate` (whose flattened, lane-agnostic table would let a feature
    // task jump straight to impl-started — the HITL-2 bypass of #58/#59).
    // These edges existed only in the lane-agnostic LINEAR_SPINE before, which
    // no event could reach: nothing could advance the gate at all.
    'no-lane': Object.freeze({ 'set-lane': 'lane-set' }),
    'lane-set': Object.freeze({ 'finish-discovery': 'discovery-done' }),
    'discovery-done': Object.freeze({ 'finish-grill': 'grill-done' }),
    'grill-done': Object.freeze({ 'finish-plan': 'plan-done' }),
    'plan-done': Object.freeze({ 'draft-spec': 'spec-draft' }),
    // HITL-2: the ONLY legal move out of plan-approved on the feature lane is
    // forward into the spec gates — draft-spec enters the human review gate.
    // The former 'start-impl' edge here was a spec-gate bypass (observed in
    // the wild, issue #58/#59); start-impl is legal only from spec-approved.
    'plan-approved': Object.freeze({ 'draft-spec': 'spec-draft' }),
    'spec-approved': Object.freeze({ 'start-impl': 'impl-started' }),
    'impl-started': Object.freeze({ 'pass-verification': 'verification-passed' }),
    'verification-passed': Object.freeze({ 'mark-pr-ready': 'pr-ready' }),
    'pr-ready': Object.freeze({ complete: 'done' }),
    'done': Object.freeze({}),
  }),
  bug: Object.freeze({
    // The bug lane diagnoses instead of discovering, so it has no discovery-done
    // gate: lane-set goes straight to the grill. `present-plan` reaches the
    // human gate the lane already had but could not get to — nothing anywhere
    // transitioned INTO plan-approved, so `approve plan` (legal only from there)
    // was unreachable and the lane dead-ended (#91).
    'no-lane': Object.freeze({ 'set-lane': 'lane-set' }),
    'lane-set': Object.freeze({ 'finish-grill': 'grill-done' }),
    'grill-done': Object.freeze({ 'present-plan': 'plan-approved' }),
    'plan-approved': Object.freeze({ 'start-impl': 'impl-started' }),
    'impl-started': Object.freeze({ 'pass-verification': 'verification-passed' }),
    'verification-passed': Object.freeze({ 'mark-pr-ready': 'pr-ready' }),
    'pr-ready': Object.freeze({ complete: 'done' }),
    'done': Object.freeze({}),
  }),
  chore: Object.freeze({
    // Mechanical lane: no discovery, no grill, no human gate. It still passes
    // THROUGH plan-approved, because gate-guard denies source edits until
    // impl-started and the chore lane's own scope contract is what bounds it.
    'no-lane': Object.freeze({ 'set-lane': 'lane-set' }),
    'lane-set': Object.freeze({ 'present-plan': 'plan-approved' }),
    'plan-approved': Object.freeze({ 'start-impl': 'impl-started' }),
    'impl-started': Object.freeze({ 'pass-verification': 'verification-passed' }),
    'verification-passed': Object.freeze({ complete: 'done' }),
    'pr-ready': Object.freeze({ complete: 'done' }),
    'done': Object.freeze({}),
  }),
});

/**
 * E10-05: lane-agnostic steering edges, keyed STEERING[currentGate][event] ->
 * nextGate. These are the moves a steering user exercises mid-workflow, so a
 * steer-scope turn intent (E10-4) maps to a legal transition instead of an
 * illegal-transition dead end:
 *
 *   impl-started --revise-scope-----> spec-draft   (scope change mid-build;
 *                                     requires a captured scope-change note)
 *   impl-started --re-plan----------> plan-done    (approach change)
 *   spec-draft   --new-requirements-> grill-done   (pre-impl backward step)
 *   <in-flight>  --park-------------> parked       (requires a persisted
 *                                     resume pointer)
 *   parked       --resume-----------> <recorded gate> (dynamic: resolved by
 *                                     {@link transitionGate} from the pointer)
 *   <in-flight>  --abandon----------> abandoned    (deliberate terminal)
 *
 * Every steering move continues the SAME task: {@link transitionGate} spreads
 * the input state, so taskId and completed work are preserved — never a
 * restart. Kept in this module so {@link flattenTransitions} stays the single
 * source of truth for every legal `current -> next` pair (E9-14). `no-lane`
 * has no steering edges (nothing is in flight there), and `done` stays
 * terminal.
 * @type {Readonly<Partial<Record<WorkflowGate, Readonly<Partial<Record<GateEvent, WorkflowGate>>>>>>}
 */
export const STEERING = Object.freeze(/** @type {Partial<Record<WorkflowGate, Readonly<Partial<Record<GateEvent, WorkflowGate>>>>>} */ ({
  'lane-set':            Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'discovery-done':      Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'grill-done':          Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'plan-done':           Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'plan-approved':       Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'spec-draft':          Object.freeze({ 'new-requirements': 'grill-done', park: 'parked', abandon: 'abandoned' }),
  'spec-approved':       Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'spec-invalidated':    Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'impl-started':        Object.freeze({ 'revise-scope': 'spec-draft', 're-plan': 'plan-done', park: 'parked', abandon: 'abandoned' }),
  'verification-passed': Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'pr-ready':            Object.freeze({ park: 'parked', abandon: 'abandoned' }),
  'parked':              Object.freeze({ abandon: 'abandoned' }),
  'abandoned':           Object.freeze({}),
}));

/**
 * Gates a task can be parked from: every in-flight gate — derived from
 * {@link STEERING} (a gate is parkable iff it has a park edge) so the two can
 * never disagree. Doubles as the set of gates a resume pointer may name: the
 * recorded gate of a parked task is always one of these.
 * @type {readonly WorkflowGate[]}
 */
export const PARKABLE_GATES = Object.freeze(
  /** @type {WorkflowGate[]} */ (
    Object.entries(STEERING)
      .filter(([, events]) => events !== undefined && events.park === 'parked')
      .map(([gate]) => gate)
  )
);

/**
 * Linear (lane-agnostic) spine of the pipeline: the pre-implementation slice
 * plus the spec recovery loops. Lane-owned pairs (draft-spec, start-impl,
 * pass-verification, mark-pr-ready, complete) intentionally live only in
 * {@link TRANSITIONS}, and steering pairs only in {@link STEERING};
 * {@link flattenTransitions} unions the three so there is a
 * single source of truth for every legal `current -> next` pair.
 * @type {Readonly<Record<WorkflowGate, readonly WorkflowGate[]>>}
 */
const LINEAR_SPINE = Object.freeze(/** @type {Record<WorkflowGate, readonly WorkflowGate[]>} */ ({
  'no-lane':             Object.freeze(['lane-set']),
  'lane-set':            Object.freeze(['discovery-done']),
  'discovery-done':      Object.freeze(['grill-done']),
  'grill-done':          Object.freeze(['plan-done']),
  'plan-done':           Object.freeze(['spec-draft']),
  'spec-draft':          Object.freeze(['spec-approved', 'spec-draft']),
  'spec-approved':       Object.freeze(['spec-draft']),
  'spec-invalidated':    Object.freeze(['spec-draft']),
  'plan-approved':       Object.freeze([]),
  'impl-started':        Object.freeze([]),
  'verification-passed': Object.freeze([]),
  'pr-ready':            Object.freeze([]),
  'done':                Object.freeze([]),
  // E10-05 steering gates: successors live in STEERING (parked additionally
  // gains the resume fan-out in flattenTransitions); abandoned is terminal.
  'parked':              Object.freeze([]),
  'abandoned':           Object.freeze([]),
}));

/**
 * Flatten the canonical tables into linear `current -> legal next gates`
 * pairs: the lane-agnostic spine unioned with every lane/event pair from
 * {@link TRANSITIONS} and every steering pair from {@link STEERING}
 * (including the resume fan-out: parked returns to the recorded gate, so
 * every parkable gate is a legal successor of parked). This is the projection
 * `lib/gatectl.mjs` derives its LEGAL_TRANSITIONS from, so the hook path
 * (advanceGate) and the CLI path (transitionGate) can never disagree.
 * @returns {Record<WorkflowGate, WorkflowGate[]>}
 */
export function flattenTransitions() {
  /** @type {Record<string, Set<string>>} */
  const pairs = {};
  // @bounded-alloc — iterates the frozen LINEAR_SPINE table (a dozen gates);
  // one Set per gate is the algorithm, not unbounded growth.
  for (const [gate, successors] of Object.entries(LINEAR_SPINE)) {
    pairs[gate] = new Set(successors);
  }
  // @bounded-alloc — iterates the frozen TRANSITIONS table (3 lanes x a dozen gates).
  for (const laneTable of Object.values(TRANSITIONS)) {
    for (const [gate, gateTable] of Object.entries(laneTable)) {
      pairs[gate] ??= new Set();
      for (const next of Object.values(gateTable)) {
        pairs[gate].add(next);
      }
    }
  }
  // E10-05: steering edges, plus the dynamic resume fan-out. `abandoned` has
  // an (empty) STEERING entry, so both new gates appear as keys — `parked`
  // with its resume targets, `abandoned` as a terminal with no successors.
  // @bounded-alloc — iterates the frozen STEERING table (a dozen gates).
  for (const [gate, gateTable] of Object.entries(STEERING)) {
    pairs[gate] ??= new Set();
    for (const next of Object.values(gateTable)) {
      pairs[gate].add(next);
    }
  }
  const parkedPairs = pairs['parked'] ?? (pairs['parked'] = new Set());
  for (const gate of PARKABLE_GATES) {
    parkedPairs.add(gate);
  }
  return /** @type {Record<WorkflowGate, WorkflowGate[]>} */ (
    Object.fromEntries(Object.entries(pairs).map(([gate, set]) => [gate, [...set]]))
  );
}

/**
 * Return the list of legal next gates from the given lane + current gate:
 * the lane-owned pairs unioned with the lane-agnostic spine and steering
 * edges (including the resume fan-out at parked), so error messages and
 * callers see every gate actually reachable from here for this lane.
 * @param {Lane} lane
 * @param {WorkflowGate} current
 * @returns {WorkflowGate[]}
 */
export function legalTransitions(lane, current) {
  const laneTable = getOwn(TRANSITIONS, lane);
  if (!laneTable) return [];
  /** @type {Set<WorkflowGate>} */
  const next = new Set();
  const gateTable = getOwn(laneTable, current);
  if (gateTable) {
    for (const target of Object.values(gateTable)) next.add(target);
  }
  for (const target of getOwn(LINEAR_SPINE, current) ?? []) next.add(target);
  const steeringTable = getOwn(STEERING, current);
  if (steeringTable) {
    for (const target of Object.values(steeringTable)) next.add(target);
  }
  if (current === 'parked') {
    for (const target of PARKABLE_GATES) next.add(target);
  }
  return [...next];
}

/**
 * The forward human-approval edges that advance by a PHRASE through
 * `advanceHumanGate` (hooks/approval-listener.mjs) rather than by a GateEvent, so
 * they are absent from {@link TRANSITIONS}: `spec-draft --approve spec-->
 * spec-approved`. (The other approval phrases fire events that ARE in the table:
 * `approve pr` → `mark-pr-ready`, `approve plan` → `start-impl`.) Reachability
 * must follow this edge, or the entire post-approval feature slice —
 * spec-approved, impl-started, verification-passed, pr-ready — looks unreachable.
 * @type {Readonly<Partial<Record<WorkflowGate, WorkflowGate>>>}
 */
const HUMAN_APPROVAL_EDGES = Object.freeze(
  /** @type {Partial<Record<WorkflowGate, WorkflowGate>>} */ ({ 'spec-draft': 'spec-approved' }),
);

/**
 * Every gate a lane can actually reach from `no-lane` at runtime, by BFS over the
 * lane's OWN forward transitions ({@link TRANSITIONS}), the phrase-driven human
 * approval edge ({@link HUMAN_APPROVAL_EDGES}), and the `park`/`abandon` steering
 * exits to the terminal steering gates.
 *
 * Deliberately NOT built on {@link legalTransitions}: that unions the
 * lane-agnostic `LINEAR_SPINE`, which would pull other lanes' gates (e.g.
 * `discovery-done` onto the bug lane) into the set. Backward steering
 * (`revise-scope`/`re-plan`/`new-requirements`) is not followed either — those
 * are feature-only movers whose targets are already reached forward, and their
 * lane-agnostic {@link STEERING} entries would fabricate cross-lane gates too.
 * @param {Lane} lane
 * @returns {Set<WorkflowGate>}
 */
export function reachableGates(lane) {
  /** @type {Set<WorkflowGate>} */
  const seen = new Set(['no-lane']);
  const laneTable = getOwn(TRANSITIONS, lane);
  if (!laneTable) return seen;
  /** @type {WorkflowGate[]} */
  // @bounded-alloc — a work queue over a fixed ~14-gate graph; each gate enqueues once.
  const queue = ['no-lane'];
  while (queue.length > 0) {
    const gate = /** @type {WorkflowGate} */ (queue.shift());
    /** @type {(WorkflowGate | undefined)[]} */
    // @bounded-alloc — at most (lane exits + one human edge + park + abandon) per gate.
    const neighbors = [getOwn(HUMAN_APPROVAL_EDGES, gate)];
    const gateTable = getOwn(laneTable, gate);
    if (gateTable) neighbors.push(...Object.values(gateTable));
    const steerTable = getOwn(STEERING, gate);
    if (steerTable) neighbors.push(steerTable.park, steerTable.abandon);
    for (const next of neighbors) {
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Attempt a gate transition. Returns updated state on success; error message on failure.
 * Consults the lane-owned table first, then the lane-agnostic steering edges
 * (E10-05). Does not write to disk; reads only the state artifacts needed to
 * check the target gate's precondition (E9-15) — a transition whose required
 * artifact is missing or invalid is refused with the unmet requirements
 * listed — plus, for `resume`, the persisted resume pointer that names the
 * gate to return to. Steering never resets progress: the returned state is a
 * spread of the input, so taskId and completed work carry over.
 * @param {TaskState} state
 * @param {GateEvent} event
 * @param {{ stateDir?: string, checkPrecondition?: typeof checkGatePrecondition }} [opts]
 *        Overrides for tests / non-default state locations.
 * @returns {Promise<TransitionResult>}
 */
export async function transitionGate(state, event, opts = {}) {
  const laneTable = getOwn(TRANSITIONS, state.lane);
  if (!laneTable) {
    return {
      ok: false,
      error: `Illegal transition: unknown lane "${state.lane}". Legal lanes: feature, bug, chore.`,
    };
  }
  const gateTable = getOwn(laneTable, state.workflowGate);
  const steeringTable = getOwn(STEERING, state.workflowGate);
  if (!gateTable && !steeringTable) {
    return {
      ok: false,
      error: `Illegal transition: unknown gate "${state.workflowGate}" for lane "${state.lane}".`,
    };
  }

  const stateDir = opts.stateDir ?? '.devmate/state';

  /** @type {WorkflowGate|undefined} */
  let nextGate =
    (gateTable ? getOwn(gateTable, event) : undefined) ??
    (steeringTable ? getOwn(steeringTable, event) : undefined);

  // E10-05: `resume` returns to the gate recorded by the resume pointer — a
  // dynamic target the static tables cannot express. The pointer must belong
  // to this task and name a parkable gate.
  if (state.workflowGate === 'parked' && event === 'resume') {
    const read = await readResumePointer(stateDir);
    if (!read.ok) {
      return { ok: false, error: `Cannot resume: ${read.error}.` };
    }
    if (read.pointer.taskId !== state.taskId) {
      return {
        ok: false,
        error: `Cannot resume: resume pointer belongs to task "${read.pointer.taskId}", not "${state.taskId}".`,
      };
    }
    if (!PARKABLE_GATES.includes(read.pointer.gate)) {
      return {
        ok: false,
        error: `Cannot resume: recorded gate "${read.pointer.gate}" is not a parkable gate. Parkable gates: ${PARKABLE_GATES.join(', ')}.`,
      };
    }
    nextGate = read.pointer.gate;
  }

  if (!nextGate) {
    const legal = legalTransitions(state.lane, state.workflowGate);
    return {
      ok: false,
      error: `Illegal transition: gate "${state.workflowGate}" does not accept event "${event}". Legal next gates: ${legal.length ? legal.join(', ') : '(none — terminal gate)'}.`,
    };
  }

  // E9-15: refuse an illegal-because-unproven transition — the target gate's
  // required artifact(s) must exist and validate. E10-05 steering events may
  // attach an event-scoped requirement on top (e.g. revise-scope needs a
  // captured scope-change note).
  const check = opts.checkPrecondition ?? checkGatePrecondition;
  const precondition = await check(nextGate, {
    stateDir,
    lane: state.lane,
    event,
    taskId: state.taskId,
  });
  if (!precondition.ok) {
    return {
      ok: false,
      error: `Gate precondition failed for "${nextGate}": ${precondition.missing.join('; ')}`,
    };
  }

  return {
    ok: true,
    from: state.workflowGate,
    to: nextGate,
    state: { ...state, workflowGate: nextGate, currentStep: 0 },
  };
}
