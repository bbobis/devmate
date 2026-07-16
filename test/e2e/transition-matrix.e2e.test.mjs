// @ts-check
/**
 * END-TO-END: the model-based exhaustive (gate × event × lane) transition
 * matrix (issue #9). The MODEL — cells, seed knowledge, and the per-cell
 * oracle — lives in `matrix-generator.mjs` and is derived from the same
 * frozen tables the runtime uses; this file is the SUBJECT side: it seeds a
 * real workspace at every resting gate through the real hooks, drives every
 * event class through the real runtime caller (UserPromptSubmit /
 * `gatectl workflow set` / subagent dispatch trios / a hand-tamper plus the
 * next prompt), and compares what landed on disk against the oracle. Any
 * divergence prints table-said vs hook-did, making "the doc and the code
 * disagree" a red build instead of a user report.
 *
 * ## Budget (the issue's nightly/PR split)
 *
 * The full matrix is hundreds of subprocess-driven cells — minutes, not
 * seconds — so it runs nightly (`DEVMATE_MATRIX=full`, wired in
 * `.github/workflows/eval-nightly.yml`). The default (per-commit `npm test`)
 * runs the hand-pinned GOLDEN cells plus any cell whose gate/steering-event
 * name appears in the working diff of the runtime dirs (`lib/`, `hooks/`,
 * `scripts/`) — the issue's cheap changed-cells heuristic. Excluded
 * (lane, gate) rows are printed with reasons, never silently dropped.
 *
 * ## Seeding fidelity
 *
 * Seeds are BUILT, not written: every gate is reached by replaying compliant
 * agent returns through the registered hooks (the journey recipes), so
 * fabricated evidence passes the same validators real evidence does. Each
 * seed is built once and cached; every cell runs on its own copy. The only
 * post-copy fixups are the absolute-path values in task.json's
 * artifactHashes (re-anchored to the copy) and the steering artifacts
 * (scope-change note / resume pointer) each cell is entitled to — writing
 * those IS the documented steering protocol, and the missing-artifact
 * refusal class is owned by the steering-lifecycle suite, not this matrix.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_SESSION_ID as SESSION_ID,
  REPO_ROOT,
  readState,
  readTraceEvents,
  replaySession,
  seedMonorootWorkspace,
  spawnHook,
  startSession,
  subagentDispatch,
} from './session-harness.mjs';
import { transitionGate } from '../../lib/gate-transitions.mjs';
import {
  EXCLUDED_ROWS,
  PARKED_FROM,
  enumerateCells,
  expectedOutcome,
  matrixDimensions,
  selectCells,
  verifyGoldenAgainstOracle,
} from './matrix-generator.mjs';

/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('./matrix-generator.mjs').MatrixCell} MatrixCell */
/** @typedef {import('./matrix-generator.mjs').ExpectedOutcome} ExpectedOutcome */

/** The one path this workspace makes editable (config: `repo-a/lib/**`). */
const EDIT_PATH = 'repo-a/lib/app.mjs';

/** Compliant agent contract bodies — the journey recipes, per lane. */
const ROUTER_RETURNS = Object.freeze({
  feature: { lane: 'feature', budgetClass: 'standard', confidence: 0.94 },
  bug: { lane: 'bug', budgetClass: 'standard', confidence: 0.94 },
  chore: { lane: 'chore', budgetClass: 'tiny', confidence: 0.94 },
});

const DISCOVERY_RETURN = {
  claims: [{ fact: 'The request handler lives here.', path: EDIT_PATH, confidence: 'high' }],
  unverified: ['[UNVERIFIED] the downstream cache is invalidated on write'],
};

const GRILL_RETURN = {
  mode: 'grill',
  assumptions: ['The caller is authenticated.'],
  missingRequirements: [],
  edgeCases: ['An empty request body.'],
  cornerCases: [],
  securityRisks: ['Unbounded input size.'],
  uxRisks: [],
  blockingQuestions: [],
  recommendedDecisions: ['Reject bodies over the configured cap.'],
  unverifiedItems: ['[UNVERIFIED] the current body-size cap'],
};

const PLANNER_RETURN = {
  tasks: [
    {
      description: 'Add the size cap to the request handler.',
      tddApproach: 'Write a failing test for an over-cap body, then clamp it.',
      persona: 'backend',
      ac: ['AC1: a body over the cap is rejected with a 413.'],
      files: [EDIT_PATH],
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

const CRITIQUE_RETURN = {
  mode: 'critique',
  missingAcceptanceCriteria: [],
  missingTests: [],
  riskySequencing: [],
  unlistedFiles: [],
  backwardsCompatRisks: [],
  rollbackRisk: 'Low — the change is additive and behind a size check.',
  verdict: 'APPROVE_PLAN',
};

const DIAGNOSE_RETURN = {
  bugScope: 'backend',
  suspectedLayer: EDIT_PATH,
  reproCommand: 'npm test -- cursor',
  fixerRecommendation: 'clamp the batch cursor at the final page boundary',
  allowedPaths: [EDIT_PATH],
  allowedGlobs: [],
};

/** The spec the human reviews (full: continuation-ready). */
const SPEC_MD = [
  '# Spec: request body size cap',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] AC1: a body over the configured cap is rejected with a 413.',
  '',
  '## Files that will change',
  '',
  `- \`${EDIT_PATH}\``,
  '',
].join('\n');

/** A spec with no files section: approval persists, continuation fails. */
const SPEC_MD_NO_FILES = [
  '# Spec: request body size cap',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] AC1: a body over the configured cap is rejected with a 413.',
  '',
].join('\n');

/** @param {string} root @param {string} name */
function stateArtifact(root, name) {
  return join(root, '.devmate', 'state', name);
}

/** @param {string} root */
function hostCwdOf(root) {
  return join(root, '.devmate');
}

/**
 * Drive the workspace's own spec write + digest stamp (plain PostToolUse).
 * @param {string} root
 * @param {string} spec
 * @param {boolean} metadata  Emulate spec-writer's writeMetadata.
 */
function writeSpecAndStamp(root, spec, metadata) {
  mkdirSync(join(root, '.devmate', 'session'), { recursive: true });
  writeFileSync(join(root, '.devmate', 'session', 'spec.md'), spec, 'utf8');
  if (metadata) {
    const state = JSON.parse(readFileSync(stateArtifact(root, 'task.json'), 'utf8'));
    writeFileSync(
      stateArtifact(root, 'task.json'),
      JSON.stringify({
        ...state,
        specFiles: [EDIT_PATH],
        acceptanceCriteria: ['a body over the configured cap is rejected with a 413.'],
      }),
      'utf8',
    );
  }
  replaySession(
    [
      {
        hook_event_name: 'PostToolUse',
        session_id: SESSION_ID,
        tool_name: 'str_replace_editor',
        tool_input: { filePath: '.devmate/session/spec.md' },
        tool_response: 'ok',
        tool_use_id: 'toolu_spec_write__vscode-1',
      },
    ],
    hostCwdOf(root),
  );
}

/**
 * Executor-only edge (pass-verification / complete): drive transitionGate and
 * persist, exactly as the lane executor would — the journey-suite pattern for
 * the two events no hook fires.
 * @param {string} root
 * @param {import('../../lib/types.mjs').GateEvent} event
 */
async function executorEdge(root, event) {
  const state = /** @type {import('../../lib/types.mjs').TaskState} */ (
    JSON.parse(readFileSync(stateArtifact(root, 'task.json'), 'utf8'))
  );
  const result = await transitionGate(state, event, {
    stateDir: join(root, '.devmate', 'state'),
  });
  assert.ok(result.ok, `seed executor edge ${event} refused: ${result.ok ? '' : result.error}`);
  writeFileSync(stateArtifact(root, 'task.json'), JSON.stringify(result.state), 'utf8');
}

/** Write fresh verify evidence matching the recorded spec digest (or none). @param {string} root */
function writeVerifyEvidence(root) {
  const state = JSON.parse(readFileSync(stateArtifact(root, 'task.json'), 'utf8'));
  writeFileSync(
    stateArtifact(root, 'verify-result.json'),
    JSON.stringify({
      passed: true,
      completedAt: new Date().toISOString(),
      specDigest: state.artifactHashes?.specDigest ?? '',
    }),
    'utf8',
  );
}

/** Persist the steering resume pointer. @param {string} root @param {string} taskId @param {string} gate */
function writeResumePointer(root, taskId, gate) {
  writeFileSync(
    stateArtifact(root, 'resume-pointer.json'),
    JSON.stringify({ taskId, gate, parkedAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  );
}

/**
 * Run the real gatectl CLI over the workspace, as the terminal would.
 * @param {string} root
 * @param {string[]} args
 */
function gatectl(root, args) {
  return spawnHook('scripts/gatectl.mjs', ['workflow', 'set', ...args], {}, hostCwdOf(root));
}

/**
 * Build the template workspace for one (lane, gate) — the drive recipes.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {Promise<string>} template root
 */
async function buildSeed(lane, gate) {
  const ws = seedMonorootWorkspace();
  const root = ws.root;
  startSession(ws.hostCwd, SESSION_ID);
  if (gate === 'no-lane') return root;

  // parked/abandoned are steered FROM the lane's PARKED_FROM gate.
  const restingGate = gate === 'parked' || gate === 'abandoned' ? PARKED_FROM[lane] : gate;

  replaySession(subagentDispatch('toolu_router_1', 'router', ROUTER_RETURNS[lane]), ws.hostCwd);

  if (lane === 'feature') {
    const order = ['lane-set', 'discovery-done', 'grill-done', 'plan-done', 'spec-draft', 'spec-approved', 'impl-started', 'verification-passed', 'pr-ready', 'done'];
    const target = order.indexOf(restingGate);
    if (target >= order.indexOf('discovery-done')) {
      replaySession(subagentDispatch('toolu_discovery_1', 'discovery', DISCOVERY_RETURN), ws.hostCwd);
    }
    if (target >= order.indexOf('grill-done')) {
      replaySession(subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_RETURN), ws.hostCwd);
    }
    if (target >= order.indexOf('plan-done')) {
      replaySession(
        [
          ...subagentDispatch('toolu_planner_1', 'planner', PLANNER_RETURN),
          ...subagentDispatch('toolu_critique_1', 'rubber-duck', CRITIQUE_RETURN),
        ],
        ws.hostCwd,
      );
    }
    if (restingGate === 'spec-approved') {
      // The continuation-failure resting state: approval persists, the
      // continuation throws (no files section, no metadata).
      writeSpecAndStamp(root, SPEC_MD_NO_FILES, false);
      replaySession(
        [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve spec' }],
        ws.hostCwd,
      );
    } else if (target >= order.indexOf('spec-draft')) {
      writeSpecAndStamp(root, SPEC_MD, true);
      if (target >= order.indexOf('impl-started')) {
        replaySession(
          [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve spec' }],
          ws.hostCwd,
        );
      }
    }
    if (target >= order.indexOf('verification-passed')) {
      writeVerifyEvidence(root);
      await executorEdge(root, 'pass-verification');
    }
    if (target >= order.indexOf('pr-ready')) {
      replaySession(
        [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve pr' }],
        ws.hostCwd,
      );
    }
    if (target >= order.indexOf('done')) {
      await executorEdge(root, 'complete');
    }
  } else if (lane === 'bug') {
    const order = ['lane-set', 'plan-approved', 'impl-started', 'verification-passed', 'pr-ready', 'done'];
    const target = order.indexOf(restingGate);
    if (target >= order.indexOf('plan-approved')) {
      // finish-grill lands the evidence; present-plan is precondition-free,
      // so the same walk continues to plan-approved.
      replaySession(subagentDispatch('toolu_grill_1', 'rubber-duck', GRILL_RETURN), ws.hostCwd);
    }
    if (target >= order.indexOf('impl-started')) {
      replaySession(
        [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve plan' }],
        ws.hostCwd,
      );
    }
    if (target >= order.indexOf('verification-passed')) {
      writeVerifyEvidence(root);
      await executorEdge(root, 'pass-verification');
    }
    if (target >= order.indexOf('pr-ready')) {
      replaySession(
        [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'approve pr' }],
        ws.hostCwd,
      );
    }
    if (target >= order.indexOf('done')) {
      await executorEdge(root, 'complete');
    }
  } else {
    // chore: the router return alone walks no-lane → impl-started.
    const order = ['impl-started', 'verification-passed', 'done'];
    const target = order.indexOf(restingGate);
    if (target >= order.indexOf('verification-passed')) {
      writeVerifyEvidence(root);
      await executorEdge(root, 'pass-verification');
    }
    if (target >= order.indexOf('done')) {
      await executorEdge(root, 'complete');
    }
  }

  if (gate === 'parked' || gate === 'abandoned') {
    const taskId = readState(root).taskId;
    if (gate === 'parked') {
      writeResumePointer(root, taskId, restingGate);
      const r = gatectl(root, ['park']);
      assert.equal(r.status, 0, `seed park at ${lane}/${restingGate} refused:\n${r.stdout}${r.stderr}`);
    } else {
      const r = gatectl(root, ['abandon']);
      assert.equal(r.status, 0, `seed abandon at ${lane}/${restingGate} refused:\n${r.stdout}${r.stderr}`);
    }
  }

  const landed = readState(root).workflowGate;
  assert.equal(landed, gate, `seed drive for ${lane}/${gate} landed at ${landed}`);
  return root;
}

/** Template cache: one built workspace per (lane, gate). @type {Map<string, string>} */
const seedCache = new Map();
/** Every root created by this run, for teardown. @type {string[]} */
const allRoots = [];

/**
 * Get (build-once) the seed template for a cell.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {Promise<string>}
 */
async function getSeed(lane, gate) {
  const key = `${lane}:${gate}`;
  const cached = seedCache.get(key);
  if (cached !== undefined) return cached;
  const root = await buildSeed(lane, gate);
  seedCache.set(key, root);
  allRoots.push(root);
  return root;
}

/**
 * Copy a seed template into a fresh cell workspace: re-anchor the absolute
 * artifactHashes paths onto the copy and seed the steering artifacts every
 * cell is entitled to (see the file header).
 * @param {string} templateRoot
 * @param {WorkflowGate} gate
 * @returns {string} the cell's root
 */
function copySeed(templateRoot, gate) {
  const cellRoot = mkdtempSync(join(tmpdir(), 'e2e-matrix-'));
  allRoots.push(cellRoot);
  cpSync(templateRoot, cellRoot, { recursive: true });

  const statePath = stateArtifact(cellRoot, 'task.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  // Re-anchor recorded absolute artifact paths onto the copy (path strings,
  // not digests — digest fields never carry the root prefix).
  const recorded = state.artifactHashes ?? {};
  for (const [k, v] of Object.entries(recorded)) {
    if (typeof v === 'string' && v.startsWith(templateRoot)) {
      recorded[k] = cellRoot + v.slice(templateRoot.length);
    }
  }
  writeFileSync(statePath, JSON.stringify(state), 'utf8');

  writeFileSync(
    stateArtifact(cellRoot, 'scope-change.json'),
    JSON.stringify({
      taskId: state.taskId,
      note: 'The cap must also apply to multipart bodies.',
      capturedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
  if (gate !== 'parked') {
    // A parked seed already carries its own pointer (recording the gate it
    // was parked FROM) — never overwrite it.
    writeResumePointer(cellRoot, state.taskId, gate);
  }
  return cellRoot;
}

/**
 * What actually happened when a cell was driven.
 * @typedef {Object} CellRun
 * @property {WorkflowGate} gateBefore
 * @property {WorkflowGate} gateAfter
 * @property {string} taskIdBefore
 * @property {string} taskIdAfter
 * @property {string} output          Combined stdout+stderr of every spawn.
 * @property {number[]} statuses      Exit codes of every spawn, in order.
 * @property {number} revisionDelta   spec_revision_requested count delta.
 */

/**
 * Drive one cell's event against its copied workspace.
 * @param {string} root
 * @param {MatrixCell} cell
 * @returns {CellRun}
 */
function runCell(root, cell) {
  const hostCwd = hostCwdOf(root);
  const before = readState(root);
  const traceFile = join(root, '.devmate', 'state', 'trace', `${before.taskId}.jsonl`);
  const revisionsBefore = countRevisions(traceFile);

  /** @type {{ status: number, stdout: string, stderr: string }[]} */
  // @bounded-alloc — the handful of hook spawns one event triggers.
  let outputs = [];

  const event = cell.event;
  if (event.kind === 'phrase') {
    outputs = replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: /** @type {string} */ (event.prompt) }],
      hostCwd,
    );
  } else if (event.kind === 'gatectl') {
    outputs = [gatectl(root, [/** @type {string} */ (event.event)])];
  } else if (event.kind === 'return') {
    outputs = replaySession(subagentDispatch('toolu_cell_1', wireAgent(event.agent ?? ''), returnBody(cell)), hostCwd);
  } else if (event.kind === 'malformed') {
    outputs = replaySession(
      [
        {
          hook_event_name: 'SubagentStart',
          session_id: SESSION_ID,
          agent_id: 'toolu_cell_1',
          agent_type: 'rubber-duck',
        },
        {
          hook_event_name: 'PostToolUse',
          session_id: SESSION_ID,
          tool_name: 'runSubagent',
          tool_input: '...',
          tool_response: 'Looks fine to me. No structured output at all.',
          tool_use_id: 'toolu_cell_1__vscode-1',
        },
        {
          hook_event_name: 'SubagentStop',
          session_id: SESSION_ID,
          agent_id: 'toolu_cell_1',
          agent_type: 'rubber-duck',
        },
      ],
      hostCwd,
    );
  } else {
    // tamper: hand-set an unearned forward gate, then the next prompt.
    writeFileSync(
      stateArtifact(root, 'task.json'),
      JSON.stringify({ ...before, workflowGate: 'impl-started' }),
      'utf8',
    );
    outputs = replaySession(
      [{ hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'status?' }],
      hostCwd,
    );
  }

  const afterState = readState(root); // JSON.parse throws on a torn file
  return {
    gateBefore: before.workflowGate,
    gateAfter: afterState.workflowGate,
    taskIdBefore: before.taskId,
    taskIdAfter: afterState.taskId,
    output: outputs.map((o) => o.stdout + o.stderr).join('\n'),
    statuses: outputs.map((o) => o.status),
    revisionDelta: countRevisions(traceFile) - revisionsBefore,
  };
}

/** @param {string} traceFile */
function countRevisions(traceFile) {
  try {
    return readTraceEvents(traceFile).filter((e) => e.type === 'spec_revision_requested').length;
  } catch {
    return 0;
  }
}

/** Map a matrix agent id to the wire agent_type. @param {string} agent */
function wireAgent(agent) {
  return agent.startsWith('rubber-duck') ? 'rubber-duck' : agent;
}

/** The contract body a matrix return carries. @param {MatrixCell} cell */
function returnBody(cell) {
  switch (cell.event.agent) {
    case 'router':
      return ROUTER_RETURNS[cell.lane];
    case 'discovery':
      return DISCOVERY_RETURN;
    case 'rubber-duck-grill':
      return GRILL_RETURN;
    case 'rubber-duck-critique':
      return CRITIQUE_RETURN;
    case 'planner':
      return PLANNER_RETURN;
    default:
      return DIAGNOSE_RETURN;
  }
}

/**
 * The divergence report: assert the run matches the oracle, printing
 * table-said vs hook-did on failure.
 * @param {MatrixCell} cell
 * @param {ExpectedOutcome} expected
 * @param {CellRun} run
 */
function assertCell(cell, expected, run) {
  const label = `[matrix ${cell.lane}/${cell.gate} × ${cell.event.id}]`;
  const diverged = (/** @type {string} */ what) =>
    `${label} DIVERGENCE (${what}) — table-said=${JSON.stringify(expected)} hook-did={gate:${run.gateBefore}→${run.gateAfter}, statuses:[${run.statuses.join(',')}]}\n${run.output}`;

  // Universal invariants: the task never changes identity, the state file is
  // never torn (readState parsed it), and no handler crashed uncaught.
  assert.equal(run.taskIdAfter, run.taskIdBefore, diverged('taskId changed'));
  assert.ok(
    !/(TypeError|ReferenceError|RangeError):/.test(run.output),
    diverged('a handler threw an uncaught runtime error'),
  );

  switch (expected.kind) {
    case 'advance':
      assert.equal(run.gateAfter, expected.to, diverged('gate'));
      return;
    case 'refusal':
      assert.ok(run.statuses.some((s) => s !== 0), diverged('a refused transition exited 0'));
      assert.equal(run.gateAfter, run.gateBefore, diverged('a refused transition moved the gate'));
      if (expected.mustMention) {
        assert.ok(run.output.includes(expected.mustMention), diverged(`output lacks "${expected.mustMention}"`));
      }
      return;
    case 'revision':
      assert.equal(run.gateAfter, run.gateBefore, diverged('a revision request moved the gate'));
      assert.equal(run.revisionDelta, 1, diverged('spec_revision_requested was not traced exactly once'));
      return;
    case 'desync':
      assert.ok(run.statuses.every((s) => s === 0), diverged('the tamper prompt was blocked'));
      assert.ok(run.output.includes('desynced'), diverged('the anchor does not flag the tampered gate'));
      assert.equal(run.gateAfter, 'impl-started', diverged('detection rewrote the tampered gate (must be non-destructive)'));
      return;
    default:
      // no-move
      assert.equal(run.gateAfter, run.gateBefore, diverged('gate moved'));
      if (expected.mustMention) {
        assert.ok(run.output.includes(expected.mustMention), diverged(`output lacks "${expected.mustMention}"`));
      }
  }
}

/**
 * One best-effort `git diff` over the RUNTIME dirs only (lib/, hooks/,
 * scripts/), so editing the matrix itself never re-selects the whole space.
 * @param {string[]} range  Range args, e.g. ['HEAD'] or ['origin/main...HEAD'].
 * @returns {string}  Empty on any git failure — no git, no selection.
 */
function gitRuntimeDiff(range) {
  try {
    const r = spawnSync('git', ['diff', ...range, '--', 'lib', 'hooks', 'scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    return r.status === 0 ? (r.stdout ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * The changed-cells heuristic input (#23). Two sources, unioned:
 *  - the WORKING diff against HEAD — a local run with uncommitted runtime
 *    edits re-runs the cells those edits touch;
 *  - when `DEVMATE_MATRIX_BASE` names a ref (e.g. origin/main), the
 *    merge-base diff `<base>...HEAD` — so a clean CI checkout of a branch
 *    still selects the cells its COMMITTED runtime changes touch. Opt-in by
 *    design: unset keeps default runs golden-only-fast, so nobody's npm test
 *    slows down because a long-lived branch accumulated runtime diffs.
 * Best-effort in both halves — a missing ref or no git yields no selection.
 * @returns {string}
 */
function runtimeDiff() {
  const working = gitRuntimeDiff(['HEAD']);
  // Ref-shaped values only (static pattern, per the repo's command-validation
  // posture): a leading `-` would reach git as an OPTION, not a revision —
  // e.g. --output=<path> writes a file and silently yields no selection.
  const base = process.env.DEVMATE_MATRIX_BASE ?? '';
  const refShaped = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base) && !base.includes('..');
  const merged = refShaped ? gitRuntimeDiff([`${base}...HEAD`]) : '';
  return `${working}\n${merged}`.trim();
}

// ---------------------------------------------------------------------------

const MODE = process.env.DEVMATE_MATRIX === 'full' ? 'full' : 'smoke';
const CELLS = selectCells(enumerateCells(), { mode: MODE, changedText: runtimeDiff() });
const DIMS = matrixDimensions();

after(() => {
  for (const root of allRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe(`E2E transition matrix — mode=${MODE}: ${CELLS.length} of ${DIMS.cells} cells (${DIMS.events} events × per-lane resting gates)`, () => {
  it('golden cells agree with the derived oracle (a broken generator cannot green its own matrix)', () => {
    const verdict = verifyGoldenAgainstOracle();
    assert.ok(verdict.ok, `golden/oracle mismatches:\n${verdict.mismatches.join('\n')}`);
  });

  it('every excluded (lane, gate) row carries a reason — no silent gaps', () => {
    for (const row of EXCLUDED_ROWS) {
      assert.ok(row.reason.length > 20, `${row.lane}/${row.gate} is excluded without a real reason`);
    }
  });

  for (const cell of CELLS) {
    const expected = expectedOutcome(cell);
    const name = `${cell.lane}/${cell.gate} × ${cell.event.id} → ${expected.kind}${expected.to ? `:${expected.to}` : ''}`;

    if (expected.kind === 'skip') {
      it(`${name} (${expected.reason})`, (t) => t.skip(expected.reason));
      continue;
    }

    it(name, async () => {
      const template = await getSeed(cell.lane, cell.gate);
      const root = copySeed(template, cell.gate);
      try {
        const run = runCell(root, cell);
        assertCell(cell, expected, run);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
