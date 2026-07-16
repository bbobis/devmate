// @ts-check
/**
 * E10-07: conversational gate-robustness eval — the interpretive counterpart
 * to the trajectory invariants suite (E9-23). Each trial drives ONE user
 * phrasing at a workflow gate through the REAL merged modules in a fresh
 * temp root:
 *
 *   1. `hooks/approval-listener.mjs` handleUserPromptSubmit — the real
 *      UserPromptSubmit path: persists the deterministic turn-intent verdict
 *      (E10-4) and emits the state anchor (E10-02).
 *   2. Turn routing per P14: the persisted fast-path verdict when present,
 *      otherwise the deterministic protocol interpreter (scorer.mjs) standing
 *      in for the orchestrator's LLM stage, validated through the real
 *      `parseTurnIntentResult`.
 *   3. The real action layer: `advanceHumanGate` (E10-03, actor + evidence),
 *      `steerFeature` / `transitionGate` steering edges with their artifact
 *      preconditions (E10-05), and re-dispatch records gated on the E10-06
 *      completeness fields.
 *
 * Grading is END-STATE ONLY (τ-bench / Anthropic guidance): the observed
 * outcome of a trial is read back from task.json and the gate_transition /
 * dispatch events in the trace — never from conversation text. Runs each
 * case k times (pass^k) and enforces the never-false-approve safety
 * property. Auto-runs under `node --test` as part of `npm run verify`.
 *
 * Temp dirs only; fixtures are synthetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { handleUserPromptSubmit } from '../../hooks/approval-listener.mjs';
import { advanceHumanGate, isHumanApprovalGate } from '../../lib/gatectl.mjs';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import { steerFeature } from '../../lib/workflow/lanes/feature.mjs';
import { readTaskState, writeTaskState, STATE_PATH } from '../../lib/task-state.mjs';
import { appendTraceEvent, traceFilePath } from '../../lib/trace/append.mjs';
import { validateTraceEvent } from '../../lib/trace/schema.mjs';
import {
  parseTurnIntentResult,
  MIN_TURN_INTENT_CONFIDENCE,
} from '../../lib/routing/turn-intent.mjs';
import { REQUIRED_DISPATCH_FIELDS } from '../../lib/workflow/build-dispatch-payload.mjs';
import { classifyGatePhrasing, scoreGateRobustness, approvalTargetFor } from './scorer.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('./scorer.mjs').GateRobustnessCase} GateRobustnessCase */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

/** Task id stamped on every synthetic trial state. */
const TASK_ID = 'gate-robustness-eval';

/** Actor stamped on orchestrator-issued human-gate advances (E10-03). */
const ORCHESTRATOR_ACTOR = 'orchestrator';

/** Trials per case (τ-bench pass^k; R8 prescribes k=8) and the acceptance floor. */
// TODO: calibrate k and pass^k floor after baseline runs — provisional placeholder
const K_TRIALS = 8;
const PASS_AT_K_FLOOR = 1;

/** Trace schema version stamped on events appended by the harness. */
const SCHEMA_VERSION = 1;

/** Step id stamped on trace events appended by the harness. */
const STEP_ID = 'gate-robustness-suite';

/**
 * @type {{ schemaVersion: number, gate: WorkflowGate, expected: 'approve',
 *   cases: Array<{ id: string, phrasing: string }> }}
 */
const APPROVALS = JSON.parse(await fsp.readFile(join(FIXTURES_DIR, 'approvals.json'), 'utf8'));

/**
 * @type {{ schemaVersion: number, gate: WorkflowGate, expected: 'revise',
 *   cases: Array<{ id: string, phrasing: string }> }}
 */
const REVISIONS = JSON.parse(await fsp.readFile(join(FIXTURES_DIR, 'revisions.json'), 'utf8'));

/**
 * @typedef {Object} InterruptionCase
 * @property {string} id
 * @property {'scope-change'|'question'|'new-task'|'abandon'} kind
 * @property {WorkflowGate} gate
 * @property {'steer'|'question'|'abandon'} expected
 * @property {string|null} steeringEvent
 * @property {WorkflowGate} endGate
 * @property {string} phrasing
 */

/** @type {{ schemaVersion: number, cases: InterruptionCase[] }} */
const INTERRUPTIONS = JSON.parse(
  await fsp.readFile(join(FIXTURES_DIR, 'interruptions.json'), 'utf8')
);

/** @type {GateRobustnessCase[]} */
const APPROVAL_CASES = APPROVALS.cases.map((c) => ({
  phrasing: c.phrasing,
  gate: APPROVALS.gate,
  expected: APPROVALS.expected,
}));

/** @type {GateRobustnessCase[]} */
const REVISION_CASES = REVISIONS.cases.map((c) => ({
  phrasing: c.phrasing,
  gate: REVISIONS.gate,
  expected: REVISIONS.expected,
}));

/** @type {GateRobustnessCase[]} */
const INTERRUPTION_CASES = INTERRUPTIONS.cases.map((c) => ({
  phrasing: c.phrasing,
  gate: c.gate,
  expected: c.expected,
}));

/** Interruption metadata keyed by phrasing (unique per fixture). */
const INTERRUPTION_BY_PHRASING = new Map(INTERRUPTIONS.cases.map((c) => [c.phrasing, c]));

/**
 * One collected trial observation, derived entirely from the durable
 * end-state artifacts (task.json + trace file) after the turn.
 * @typedef {Object} CollectedTrial
 * @property {string} phrasing
 * @property {string} startGate
 * @property {string} gate
 * @property {boolean} redispatched
 * @property {Array<Record<string, unknown>>} events
 * @property {string} [actionError]
 */

/**
 * Create a fresh temp repo root holding a synthetic in-flight feature task
 * at `gate`, with the session spec artifact the spec-approved precondition
 * requires and an empty skills dir so the hook's skill matcher stays quiet.
 * @param {WorkflowGate} gate
 * @returns {Promise<string>}
 */
async function makeRoot(gate) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'gate-robustness-'));
  await fsp.mkdir(join(root, '.devmate', 'state'), { recursive: true });
  await fsp.mkdir(join(root, '.devmate', 'session'), { recursive: true });
  await fsp.mkdir(join(root, 'skills'), { recursive: true });
  /** @type {TaskState} */
  const state = {
    taskId: TASK_ID,
    lane: 'feature',
    workflowGate: gate,
    artifactHashes: {
      spec: '.devmate/session/spec.md',
      specDigest: 'a1b2c3d4e5f60718',
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
  await writeTaskState(state, join(root, STATE_PATH));
  await fsp.writeFile(
    join(root, '.devmate', 'session', 'spec.md'),
    [
      '# Spec: gate-robustness synthetic task',
      '',
      '## Files that will change',
      '- lib/example.mjs',
      '',
      '## Out of scope',
      '- nothing',
      '',
    ].join('\n'),
    'utf8'
  );
  return root;
}

/**
 * Record a subagent dispatch in the trace. Mirrors the E10-06 poka-yoke:
 * a dispatch missing any completeness field is refused (returns false), so
 * an under-specified re-dispatch shows up as a failed trial instead of a
 * silent success.
 * @param {string} root
 * @param {string} agentName
 * @param {Record<'objective'|'outputFormat'|'toolGuidance'|'boundaries', string>} fields
 * @returns {Promise<boolean>}
 */
async function recordDispatch(root, agentName, fields) {
  for (const field of REQUIRED_DISPATCH_FIELDS) {
    const value = fields[field];
    if (typeof value !== 'string' || value.trim() === '') return false;
  }
  await appendTraceEvent(
    {
      type: 'subagent_start',
      taskId: TASK_ID,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      agentName,
      persona: agentName,
      activeCount: 1,
    },
    { root }
  );
  return true;
}

/**
 * The four completeness fields for a spec-author re-dispatch.
 * @param {string} phrasing
 * @returns {Record<'objective'|'outputFormat'|'toolGuidance'|'boundaries', string>}
 */
function specWriterDispatchFields(phrasing) {
  return {
    objective: `Revise the spec to address the human feedback: ${phrasing}`,
    outputFormat: 'Updated spec.md plus refreshed spec metadata in task state.',
    toolGuidance: 'Edit the session spec artifact only; do not touch source files.',
    boundaries: 'Never advance a workflow gate; the task stays pending re-review.',
  };
}

/**
 * Append a plain (non-human) gate_transition trace event for a steering move,
 * so the end-state trace records the edge taken.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function recordSteeringTransition(root, from, to) {
  await appendTraceEvent(
    {
      type: 'gate_transition',
      taskId: TASK_ID,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      from,
      to,
      gate: to,
    },
    { root }
  );
}

/**
 * Execute one conversational turn against the workflow in `root`: real hook,
 * turn routing, then the real action modules for the classified intent.
 * @param {string} root
 * @param {string} phrasing
 * @returns {Promise<{ actionError?: string }>}
 */
async function executeTurn(root, phrasing) {
  const statePath = join(root, STATE_PATH);
  const stateDir = join(root, '.devmate', 'state');
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  // 1. Real UserPromptSubmit hook: state anchor + persisted turn intent;
  //    exact phrases would transition here (fixtures contain none).
  await handleUserPromptSubmit({ prompt: phrasing, root, stdout: sink });

  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    throw new Error(`harness: task state unreadable: ${stateResult.errors.join('; ')}`);
  }
  const state = stateResult.state;

  // 2. Turn routing (P14): persisted deterministic verdict first, else the
  //    protocol interpreter validated through the real Stage-2 validator.
  /** @type {{ deferred?: boolean, intent?: string|null }} */
  const persisted = JSON.parse(await fsp.readFile(join(stateDir, 'turn-intent.json'), 'utf8'));
  /** @type {string} */
  let intent;
  if (persisted.deferred === false && typeof persisted.intent === 'string') {
    intent = persisted.intent;
  } else {
    const parsed = parseTurnIntentResult(classifyGatePhrasing(phrasing, state.workflowGate));
    if (!parsed.ok) {
      throw new Error(`harness: interpreter verdict invalid: ${parsed.error}`);
    }
    if (parsed.result.confidence < MIN_TURN_INTENT_CONFIDENCE) {
      throw new Error(
        `harness: interpreter confidence ${parsed.result.confidence} below the shared floor`
      );
    }
    intent = parsed.result.intent;
  }

  // 3. Real action layer. Action failures are recorded, not thrown: the
  //    durable end state (graded below) is what decides pass/fail.
  try {
    switch (intent) {
      case 'approve-gate': {
        const target = approvalTargetFor(state.workflowGate);
        if (target === null) {
          throw new Error(`no human-approval successor from "${state.workflowGate}"`);
        }
        await advanceHumanGate(state.workflowGate, target, {
          actor: ORCHESTRATOR_ACTOR,
          evidence: phrasing,
          root,
        });
        break;
      }
      case 'revise-artifact': {
        await appendTraceEvent(
          {
            type: 'spec_revision_requested',
            taskId: state.taskId,
            stepId: STEP_ID,
            ts: new Date().toISOString(),
            schemaVersion: SCHEMA_VERSION,
            feedback: phrasing,
          },
          { root }
        );
        await recordDispatch(root, 'spec-writer', specWriterDispatchFields(phrasing));
        break;
      }
      case 'steer-scope': {
        // The orchestrator captures the scope change before steering — the
        // E10-05 revise-scope event precondition demands the note.
        await fsp.writeFile(
          join(stateDir, 'scope-change.json'),
          JSON.stringify(
            { taskId: state.taskId, note: phrasing, capturedAt: new Date().toISOString() },
            null,
            2
          ),
          'utf8'
        );
        const steered = await steerFeature(state, 'revise-scope', {
          repoRoot: root,
          statePath,
          stateDir,
        });
        await recordSteeringTransition(root, steered.from, steered.gate);
        await recordDispatch(root, 'spec-writer', specWriterDispatchFields(phrasing));
        break;
      }
      case 'new-task': {
        // E10-01: a new unrelated task first parks the current one. The
        // orchestrator persists the resume pointer the park precondition
        // demands, then dispatches the new task.
        await fsp.writeFile(
          join(stateDir, 'resume-pointer.json'),
          JSON.stringify(
            { taskId: state.taskId, gate: state.workflowGate, parkedAt: new Date().toISOString() },
            null,
            2
          ),
          'utf8'
        );
        const parked = await transitionGate(state, 'park', { stateDir });
        if (!parked.ok || !parked.state || !parked.from || !parked.to) {
          throw new Error(`park transition failed: ${parked.error}`);
        }
        await writeTaskState(parked.state, statePath);
        await recordSteeringTransition(root, parked.from, parked.to);
        await recordDispatch(root, 'router', {
          objective: `Classify the lane for the newly reported task: ${phrasing}`,
          outputFormat: 'A structured router result artifact.',
          toolGuidance: 'Read-only classification; no source edits.',
          boundaries: 'The parked task is untouched until an explicit resume.',
        });
        break;
      }
      case 'abandon': {
        const abandoned = await transitionGate(state, 'abandon', { stateDir });
        if (!abandoned.ok || !abandoned.state || !abandoned.from || !abandoned.to) {
          throw new Error(`abandon transition failed: ${abandoned.error}`);
        }
        await writeTaskState(abandoned.state, statePath);
        await recordSteeringTransition(root, abandoned.from, abandoned.to);
        break;
      }
      default: {
        // question / status / chat: read-only turns — answer from the
        // artifacts, never mutate gate state (P14 hard rule).
        await fsp.readFile(join(root, '.devmate', 'session', 'spec.md'), 'utf8');
        break;
      }
    }
  } catch (/** @type {unknown} */ err) {
    return { actionError: err instanceof Error ? err.message : String(err) };
  }
  return {};
}

/**
 * Read every trace event appended for the synthetic task in `root`.
 * @param {string} root
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readTraceEvents(root) {
  let raw;
  try {
    raw = await fsp.readFile(traceFilePath(TASK_ID, root), 'utf8');
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return parseJsonl(raw);
}

/**
 * Derive the observed end state of a trial from the durable artifacts only:
 * the persisted task.json gate, and whether the trace records a re-dispatch
 * (subagent_start) or a revision request. Conversation text plays no part.
 * @param {string} root
 * @returns {Promise<{ gate: string, redispatched: boolean, events: Array<Record<string, unknown>> }>}
 */
async function readEndState(root) {
  const stateResult = readTaskState(join(root, STATE_PATH));
  if (!stateResult.ok) {
    throw new Error(`harness: end state unreadable: ${stateResult.errors.join('; ')}`);
  }
  const events = await readTraceEvents(root);
  const redispatched = events.some(
    (e) => e.type === 'subagent_start' || e.type === 'spec_revision_requested'
  );
  return { gate: stateResult.state.workflowGate, redispatched, events };
}

/**
 * Build the scorer's `run` callback: one fresh temp root per trial, one
 * conversational turn, observation read back from disk, root removed.
 * @param {CollectedTrial[]} collector  Receives every trial's observation.
 * @returns {(phrasing: string, gate: string) => Promise<{ gate: string, redispatched: boolean }>}
 */
function makeRun(collector) {
  return async (phrasing, gate) => {
    const root = await makeRoot(/** @type {WorkflowGate} */ (gate));
    try {
      const { actionError } = await executeTurn(root, phrasing);
      const observed = await readEndState(root);
      /** @type {CollectedTrial} */
      const trial = {
        phrasing,
        startGate: gate,
        gate: observed.gate,
        redispatched: observed.redispatched,
        events: observed.events,
      };
      if (actionError !== undefined) trial.actionError = actionError;
      collector.push(trial);
      return { gate: observed.gate, redispatched: observed.redispatched };
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  };
}

/** @type {CollectedTrial[]} */
const approvalTrials = [];
/** @type {CollectedTrial[]} */
const revisionTrials = [];
/** @type {CollectedTrial[]} */
const interruptionTrials = [];

/** @type {{ approvals?: Awaited<ReturnType<typeof scoreGateRobustness>>, revisions?: Awaited<ReturnType<typeof scoreGateRobustness>>, interruptions?: Awaited<ReturnType<typeof scoreGateRobustness>> }} */
const scored = {};

test('approval matrix: every affirmative phrasing lands spec-approved, pass^k at the floor', async (t) => {
  const result = await scoreGateRobustness(APPROVAL_CASES, K_TRIALS, makeRun(approvalTrials));
  scored.approvals = result;
  t.diagnostic(
    `approvals pass^${K_TRIALS} = ${result.passAtK} over ${APPROVAL_CASES.length} cases`
  );
  for (const per of result.perCase) {
    assert.equal(per.passed, K_TRIALS, `"${per.phrasing}" passed ${per.passed}/${K_TRIALS} trials`);
  }
  assert.ok(
    result.passAtK >= PASS_AT_K_FLOOR,
    `pass^k ${result.passAtK} is below the ${PASS_AT_K_FLOOR} floor`
  );
  assert.equal(result.neverFalseApprove, true);

  // E10-03: every advance carries the audit pair, read from the end-state
  // trace — actor names the issuing path, evidence is the verbatim phrasing.
  for (const trial of approvalTrials) {
    const transitions = trial.events.filter((e) => e.type === 'gate_transition');
    assert.equal(transitions.length, 1, `"${trial.phrasing}" wrote one gate_transition`);
    const event = transitions[0];
    assert.equal(event.from, 'spec-draft');
    assert.equal(event.to, 'spec-approved');
    assert.equal(event.actor, ORCHESTRATOR_ACTOR);
    assert.equal(event.evidence, trial.phrasing);
  }
});

test('revision matrix: every change request stays at spec-draft and re-dispatches the author', async (t) => {
  const result = await scoreGateRobustness(REVISION_CASES, K_TRIALS, makeRun(revisionTrials));
  scored.revisions = result;
  t.diagnostic(
    `revisions pass^${K_TRIALS} = ${result.passAtK} over ${REVISION_CASES.length} cases`
  );
  for (const per of result.perCase) {
    assert.equal(per.passed, K_TRIALS, `"${per.phrasing}" passed ${per.passed}/${K_TRIALS} trials`);
  }
  assert.ok(result.passAtK >= PASS_AT_K_FLOOR);
  assert.equal(result.neverFalseApprove, true);

  for (const trial of revisionTrials) {
    assert.equal(trial.gate, 'spec-draft', `"${trial.phrasing}" stayed at spec-draft`);
    const transitions = trial.events.filter((e) => e.type === 'gate_transition');
    assert.equal(transitions.length, 0, `"${trial.phrasing}" moved no gate`);
    const revision = trial.events.find((e) => e.type === 'spec_revision_requested');
    assert.ok(revision, `"${trial.phrasing}" recorded a revision request`);
    assert.equal(revision.feedback, trial.phrasing);
    const dispatch = trial.events.find((e) => e.type === 'subagent_start');
    assert.ok(dispatch, `"${trial.phrasing}" re-dispatched the author`);
    assert.equal(dispatch.agentName, 'spec-writer');
  }
});

test('interruption suite: the correct steering edge is taken and dispatch continues', async (t) => {
  const result = await scoreGateRobustness(
    INTERRUPTION_CASES,
    K_TRIALS,
    makeRun(interruptionTrials)
  );
  scored.interruptions = result;
  t.diagnostic(
    `interruptions pass^${K_TRIALS} = ${result.passAtK} over ${INTERRUPTION_CASES.length} cases`
  );
  for (const per of result.perCase) {
    assert.equal(per.passed, K_TRIALS, `"${per.phrasing}" passed ${per.passed}/${K_TRIALS} trials`);
  }
  assert.ok(result.passAtK >= PASS_AT_K_FLOOR);
  assert.equal(result.neverFalseApprove, true);

  for (const trial of interruptionTrials) {
    const meta = INTERRUPTION_BY_PHRASING.get(trial.phrasing);
    assert.ok(meta, `fixture metadata found for "${trial.phrasing}"`);
    assert.equal(trial.gate, meta.endGate, `"${trial.phrasing}" landed ${meta.endGate}`);
    const transitions = trial.events.filter((e) => e.type === 'gate_transition');
    const dispatched = trial.events.some((e) => e.type === 'subagent_start');
    if (meta.kind === 'question') {
      assert.equal(transitions.length, 0, 'a question never moves a gate');
      assert.equal(dispatched, false, 'a question never re-dispatches the author');
    } else {
      assert.equal(transitions.length, 1, `"${trial.phrasing}" took exactly one edge`);
      assert.equal(transitions[0].from, meta.gate);
      assert.equal(transitions[0].to, meta.endGate);
      if (meta.kind === 'abandon') {
        assert.equal(dispatched, false, 'nothing dispatches after an abandon');
      } else {
        assert.equal(dispatched, true, `dispatch continues after a ${meta.kind} interruption`);
      }
    }
  }
});

test('never-false-approve holds across the combined corpus', () => {
  assert.ok(scored.approvals && scored.revisions && scored.interruptions, 'matrices scored');
  assert.equal(scored.approvals.neverFalseApprove, true);
  assert.equal(scored.revisions.neverFalseApprove, true);
  assert.equal(scored.interruptions.neverFalseApprove, true);
  // Belt and braces over the raw observations: no non-approve trial may end
  // in a human-approval gate it did not start at.
  for (const trial of [...revisionTrials, ...interruptionTrials]) {
    const falseApprove = trial.gate !== trial.startGate && isHumanApprovalGate(trial.gate);
    assert.equal(falseApprove, false, `"${trial.phrasing}" reached ${trial.gate}`);
  }
});

test('every trace event written by the trials is schema-valid end state', () => {
  const allTrials = [...approvalTrials, ...revisionTrials, ...interruptionTrials];
  assert.ok(allTrials.length > 0, 'trials collected');
  for (const trial of allTrials) {
    for (const event of trial.events) {
      const verdict = validateTraceEvent(event);
      assert.deepEqual(verdict, { ok: true, errors: [] }, JSON.stringify(event));
    }
  }
});

test('dispatch continues after a question interruption: a follow-up approval still lands', async () => {
  const root = await makeRoot('spec-draft');
  try {
    const first = await executeTurn(root, 'which file does the spec live in?');
    assert.equal(first.actionError, undefined);
    const mid = await readEndState(root);
    assert.equal(mid.gate, 'spec-draft', 'the question left the gate pending');
    assert.equal(mid.redispatched, false);

    const second = await executeTurn(root, 'looks good to me');
    assert.equal(second.actionError, undefined);
    const end = await readEndState(root);
    assert.equal(end.gate, 'spec-approved', 'the workflow continued to approval afterwards');
    const transitions = end.events.filter((e) => e.type === 'gate_transition');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].evidence, 'looks good to me');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
