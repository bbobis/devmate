// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateGuard } from '../../lib/gate-guard-core.mjs';
import { writeTaskState } from '../../lib/task-state.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').HookPayload} HookPayload */

/**
 * Minimal valid DevmateConfig result for a persona that owns all src files.
 * @returns {import('../../lib/types.mjs').ConfigResult}
 */
function validConfigResult() {
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      personas: [{ persona: 'fullstack', editableGlobs: ['src/**'] }],
    },
  };
}

/**
 * Minimal invalid ConfigResult simulating missing devmate.config.json.
 * @returns {import('../../lib/types.mjs').ConfigResult}
 */
function missingConfigResult() {
  return { ok: false, error: 'Config file not found: .devmate/devmate.config.json. Run `devmate init` to create it.' };
}

/**
 * Build a minimal HookPayload for an edit tool.
 * @param {string} [path]
 * @returns {HookPayload}
 */
function editPayload(path = 'src/app.mjs') {
  return /** @type {HookPayload} */ ({ tool_name: 'write_file', path });
}

/**
 * Build a minimal HookPayload for a read-only tool.
 * @returns {HookPayload}
 */
function readPayload() {
  return /** @type {HookPayload} */ ({ tool_name: 'read_file', path: 'src/app.mjs' });
}

/**
 * Minimal valid TaskState at the given gate.
 * @param {import('../../lib/types.mjs').WorkflowGate} gate
 * @returns {TaskState}
 */
function stateAt(gate) {
  return {
    taskId: 'T1',
    lane: 'feature',
    workflowGate: gate,
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    tddGuard: {
      testFileWritten: true,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    },
    schemaVersion: 1,
  };
}

// ─── Rule 1: missing config blocks edits ────────────────────────────────────

test('gate-guard-flow — Rule 1: missing devmate.config.json → edit denied', () => {
  const result = evaluateGuard(editPayload(), null, missingConfigResult());
  assert.equal(result.decision, 'deny');
  assert.ok(result.reason?.includes('devmate init'), `reason: ${result.reason}`);
});

test('gate-guard-flow — Rule 1: missing config → non-edit still allowed', () => {
  const result = evaluateGuard(readPayload(), null, missingConfigResult());
  assert.equal(result.decision, 'allow');
});

// ─── Rule 2: task.json missing blocks edits ──────────────────────────────────

test('gate-guard-flow — Rule 2: state === null + edit → denied with unreadable message', () => {
  const result = evaluateGuard(editPayload(), null, validConfigResult());
  assert.equal(result.decision, 'deny');
  assert.ok(result.reason?.includes('unreadable'), `reason: ${result.reason}`);
});

test('gate-guard-flow — Rule 2: state === null + read → allowed', () => {
  const result = evaluateGuard(readPayload(), null, validConfigResult());
  assert.equal(result.decision, 'allow');
});

// ─── Rule 3: plan-approved gate blocks edits ─────────────────────────────────

test('gate-guard-flow — Rule 3: workflowGate plan-approved + edit → denied', () => {
  const result = evaluateGuard(editPayload(), stateAt('plan-approved'), validConfigResult());
  assert.equal(result.decision, 'deny');
  assert.ok(result.reason?.includes('plan-approved'), `reason: ${result.reason}`);
});

test('gate-guard-flow — Rule 3: workflowGate plan-approved + read → allowed', () => {
  const result = evaluateGuard(readPayload(), stateAt('plan-approved'), validConfigResult());
  assert.equal(result.decision, 'allow');
});

// ─── Happy path: impl-started gate allows edits ──────────────────────────────

/**
 * #92: at impl-started the lane's edit boundary is required (Rule 6 fails
 * closed), so a fixture that expects an ALLOW must carry the contract naming the
 * path it edits.
 * @type {import('../../lib/types.mjs').ParsedScope}
 */
const SCOPE = {
  lane: 'feature',
  allowedPaths: ['src/app.mjs'],
  allowedGlobs: [],
};

test('gate-guard-flow — impl-started gate + valid config + owned file → edit allowed', () => {
  const result = evaluateGuard(
    editPayload('src/app.mjs'),
    stateAt('impl-started'),
    validConfigResult(),
    { scope: SCOPE }
  );
  assert.equal(result.decision, 'allow');
});

test('gate-guard-flow — impl-started gate + out-of-scope file → edit denied by scope.md', () => {
  // Was "denied by persona scope" (Rule 5), which needed a persona the production
  // path never had. Rule 6 is the boundary that actually runs at the tool call
  // (#99): a file outside the task's contract is denied, and the deny names it.
  const result = evaluateGuard(
    editPayload('infra/deploy.sh'),
    stateAt('impl-started'),
    validConfigResult(),
    { scope: SCOPE });
  assert.equal(result.decision, 'deny');
  assert.ok(result.reason?.includes('out of scope per scope.md'), `reason: ${result.reason}`);
  assert.ok(result.reason?.includes('infra/deploy.sh'), `reason: ${result.reason}`);
});

// ─── Full integration flow: plan-approved → impl-started → edit allowed ──────

test('gate-guard-flow — full flow: gate advance plan-approved→impl-started unblocks edits', async () => {
  const dir = join(tmpdir(), `gate-flow-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'task.json');

  try {
    // 1. Write initial state at plan-approved (as init-task-state.mjs would)
    const initialState = stateAt('plan-approved');
    await writeTaskState(initialState, statePath);

    // 2. Before gate advance: edit must be denied (Rule 3)
    const beforeAdvance = evaluateGuard(editPayload(), initialState, validConfigResult());
    assert.equal(beforeAdvance.decision, 'deny', 'edit must be denied at plan-approved');

    // 3. Advance gate to impl-started (as orchestrator must do via gatectl)
    const advancedState = { ...initialState, workflowGate: /** @type {import('../../lib/types.mjs').WorkflowGate} */ ('impl-started') };
    await writeTaskState(advancedState, statePath);

    // 4. After gate advance: edit must be allowed — under the lane's edit
    //    boundary, which #92 made a precondition of editing at all.
    const afterAdvance = evaluateGuard(
      editPayload('src/app.mjs'),
      advancedState,
      validConfigResult(),
      { scope: SCOPE }
    );
    assert.equal(afterAdvance.decision, 'allow', 'edit must be allowed at impl-started');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HITL-1: evaluateGuard treats a runSubagent dispatch as a non-edit → allow (dispatch enforcement is layered in the script wrapper, not the pure guard)', () => {
  const dispatchPayload = /** @type {HookPayload} */ ({
    tool_name: 'runSubagent',
    tool_input: { agentName: 'fullstack', persona: 'frontend' },
  });
  // Even at plan-approved (where a source edit is denied by Rule 3), a
  // runSubagent call is not a source-edit tool, so the pure guard allows it.
  const result = evaluateGuard(dispatchPayload, stateAt('plan-approved'), validConfigResult());
  assert.equal(result.decision, 'allow');
});
