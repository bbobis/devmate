// @ts-check
/**
 * #93: session-artifact enforcement (Rule 4) — the unit half.
 *
 * The E2E (test/e2e/session-artifact-guard.e2e.test.mjs) proves the rule fires in
 * the live hook path, which is where it was dead. These tests pin the policy the
 * rule expresses: protected by DEFAULT (no opts required, because "caller forgot
 * the input" is how it stayed dormant), identity can only permit, and an absent
 * or ambiguous identity denies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_ARTIFACT_PATHS,
  DEFAULT_SESSION_ARTIFACT_WRITERS,
  evaluateGuard,
  isSourceEditTool,
  normalizeArtifactPath,
  resolveActiveAgent,
} from '../../lib/gate-guard-core.mjs';

/** @typedef {import('../../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */

const CONFIG_OK = /** @type {any} */ ({
  ok: true,
  config: { schemaVersion: 1, personas: [] },
});

/** A scope wide enough that Rule 6 allows everything — so only Rule 4 can deny. */
const SCOPE = /** @type {any} */ ({
  lane: 'feature',
  allowedPaths: [],
  allowedGlobs: ['**'],
});

/**
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides = {}) {
  return /** @type {TaskState} */ ({
    taskId: 't-93',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
    ...overrides,
  });
}

/**
 * Evaluate an edit at impl-started with every other rule satisfied.
 * @param {string} filePath
 * @param {{ activeAgent?: string, activeAgentAmbiguous?: boolean }} [opts]
 */
function editAt(filePath, opts = {}) {
  return evaluateGuard(
    /** @type {HookPayload} */ ({ tool_name: 'create_file', path: filePath }),
    makeState(),
    CONFIG_OK,
    { scope: SCOPE, ...opts },
  );
}

// ---- The default is protection, not permission ----

test('protects the session artifacts with NO opts supplied', () => {
  // The dormancy bug in one assertion: `sessionArtifactPaths` defaulted to [],
  // so every caller that omitted it disabled the rule — and every caller omitted
  // it. The default must be the protective one.
  const decision = evaluateGuard(
    /** @type {HookPayload} */ ({ tool_name: 'create_file', path: '.devmate/state/task.json' }),
    makeState(),
    CONFIG_OK,
    { scope: SCOPE },
  );
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /session artifact/i);
});

test('the default policy protects state and session, and names exactly one writer', () => {
  assert.deepEqual([...DEFAULT_SESSION_ARTIFACT_PATHS], [
    '.devmate/state/**',
    '.devmate/session/**',
  ]);
  assert.equal(DEFAULT_SESSION_ARTIFACT_WRITERS.length, 1);
  assert.deepEqual([...(DEFAULT_SESSION_ARTIFACT_WRITERS[0]?.agents ?? [])], ['spec-writer']);
});

test('denies every artifact in the evidence chain, whatever its extension', () => {
  for (const artifact of [
    '.devmate/state/task.json',
    '.devmate/state/diagnosis.json',
    '.devmate/session/spec.md',
    '.devmate/session/t-93/plan.json',
    '.devmate/session/t-93/discovery.json',
    '.devmate/session/t-93/scope.md',
    '.devmate/session/t-93/trace.jsonl',
  ]) {
    assert.equal(editAt(artifact, { activeAgent: 'fullstack' }).decision, 'deny', artifact);
  }
});

test('leaves non-artifact paths to the other rules', () => {
  assert.equal(editAt('lib/app.mjs', { activeAgent: 'fullstack' }).decision, 'allow');
  // `.devmate/` is not blanket-protected — only the gate and the evidence chain.
  assert.equal(editAt('.devmate/memory/tasks/t-93.jsonl', { activeAgent: 'fullstack' }).decision, 'allow');
});

// ---- Identity permits; it never gates ----

test('spec-writer may write spec.md; nobody else may', () => {
  assert.equal(editAt('.devmate/session/spec.md', { activeAgent: 'spec-writer' }).decision, 'allow');
  assert.equal(editAt('.devmate/session/spec.md', { activeAgent: 'planner' }).decision, 'deny');
});

test("spec-writer's permission does not extend to the gate state", () => {
  const decision = editAt('.devmate/state/task.json', { activeAgent: 'spec-writer' });
  assert.equal(decision.decision, 'deny');
});

test('no agent in flight = deny, and the reason says so', () => {
  const decision = editAt('.devmate/session/spec.md', { activeAgent: '' });
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /top-level session/i);
});

test('ambiguous identity = deny, and the reason says so', () => {
  const decision = editAt('.devmate/session/spec.md', {
    activeAgent: '',
    activeAgentAmbiguous: true,
  });
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /attributed/i);
});

test('the deny names the declared writers, so the caller can route the write', () => {
  const decision = editAt('.devmate/state/task.json', { activeAgent: 'fullstack' });
  assert.match(decision.reason ?? '', /spec-writer/);
});

// ---- resolveActiveAgent: the parallel-@fullstack question, answered ----

test('resolveActiveAgent — one sub-agent in flight is that identity', () => {
  const state = makeState({ activeAgents: [{ agentName: 'spec-writer', agentId: 'a1' }] });
  assert.deepEqual(resolveActiveAgent(state), { agent: 'spec-writer', ambiguous: false });
});

test('resolveActiveAgent — N instances of the SAME agent are one identity, not an ambiguity', () => {
  // The feature lane dispatches @fullstack in parallel. Rule 4 gates on the agent
  // NAME, so two fullstack workers are one identity as far as it is concerned —
  // nothing is guessed, and the rule stays usable during the fan-out.
  const state = makeState({
    activeAgents: [
      { agentName: 'fullstack', agentId: 'a1' },
      { agentName: 'fullstack', agentId: 'a2' },
    ],
  });
  assert.deepEqual(resolveActiveAgent(state), { agent: 'fullstack', ambiguous: false });
});

test('resolveActiveAgent — a MIXED set is ambiguous (and Rule 4 denies)', () => {
  const state = makeState({
    activeAgents: [
      { agentName: 'fullstack', agentId: 'a1' },
      { agentName: 'spec-writer', agentId: 'a2' },
    ],
  });
  assert.deepEqual(resolveActiveAgent(state), { agent: '', ambiguous: true });
});

test('resolveActiveAgent — empty roster, absent field, and null state are all "no identity"', () => {
  assert.deepEqual(resolveActiveAgent(makeState({ activeAgents: [] })), { agent: '', ambiguous: false });
  assert.deepEqual(resolveActiveAgent(makeState()), { agent: '', ambiguous: false });
  assert.deepEqual(resolveActiveAgent(null), { agent: '', ambiguous: false });
});

// ---- Path spelling: an absolute path is the same file ----

test('normalizeArtifactPath reduces both spellings to the .devmate tail', () => {
  assert.equal(normalizeArtifactPath('.devmate/state/task.json'), '.devmate/state/task.json');
  assert.equal(normalizeArtifactPath('./.devmate/state/task.json'), '.devmate/state/task.json');
  assert.equal(
    normalizeArtifactPath('C:\\ws\\.devmate\\session\\spec.md'),
    '.devmate/session/spec.md',
  );
  assert.equal(normalizeArtifactPath('/home/me/ws/.devmate/state/task.json'), '.devmate/state/task.json');
  // A path with no .devmate segment is returned slash-normalized, untouched.
  assert.equal(normalizeArtifactPath('lib\\app.mjs'), 'lib/app.mjs');
});

test('case is a spelling, not a different file — .DEVMATE is denied too', () => {
  // Windows and macOS have case-insensitive filesystems, so `.DEVMATE/state/task.json`
  // opens the very same file. A case-sensitive glob match would wave it through: a
  // guard defeated by pressing shift is not a guard.
  for (const spelling of [
    '.DEVMATE/state/task.json',
    '.Devmate/Session/Spec.md',
    'C:\\WS\\.DevMate\\state\\task.json',
  ]) {
    assert.equal(editAt(spelling, { activeAgent: 'fullstack' }).decision, 'deny', spelling);
  }
  // ...and the writer exception survives the same spelling.
  assert.equal(editAt('.DEVMATE/session/SPEC.md', { activeAgent: 'spec-writer' }).decision, 'allow');
});

test('an absolute artifact path is denied exactly like the relative one', () => {
  const decision = editAt('C:\\ws\\.devmate\\state\\task.json', { activeAgent: 'fullstack' });
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /session artifact/i);
});

// ---- The terminal bypass: .md was not a "source" extension ----

test('a shell write to a session artifact is a source edit (the .md hole, closed)', () => {
  for (const command of [
    'echo "# forged" > .devmate/session/spec.md',
    'echo "{}" >> .devmate/state/task.json',
    'cat spec-draft.txt | tee .devmate/session/spec.md',
    "sed -i 's/a/b/' .devmate/session/spec.md",
    'cp /tmp/forged.md .devmate/session/spec.md',
  ]) {
    assert.equal(isSourceEditTool('run_in_terminal', command), true, command);
  }
});

test('reading a session artifact from the terminal stays allowed', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'cat .devmate/state/task.json'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'ls .devmate/session'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'node scripts/compact-session.mjs'), false);
});
