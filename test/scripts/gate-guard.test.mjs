// @ts-check
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withMarkedSession } from '../../lib/test-utils/hook-session.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

/**
 * Read the guard's verdict out of the VS Code PreToolUse wire shape.
 *
 * The hook must emit `{hookSpecificOutput: {hookEventName, permissionDecision,
 * permissionDecisionReason}}` — a bare top-level `{decision}` is the
 * PostToolUse/Stop schema and VS Code silently IGNORES it on PreToolUse, so the
 * tool runs regardless of what the guard decided (#74). Asserting through this
 * helper means every test below exercises the contract the host actually reads,
 * not devmate's internal type.
 * @param {string} stdout  Raw hook stdout.
 * @returns {{ decision: string, reason: string }}
 */
function parseDecision(stdout) {
  const parsed = JSON.parse(stdout.trim());
  assert.ok(
    parsed.hookSpecificOutput,
    'PreToolUse output must be nested under hookSpecificOutput or VS Code ignores it',
  );
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  return {
    decision: String(parsed.hookSpecificOutput.permissionDecision ?? ''),
    reason: String(parsed.hookSpecificOutput.permissionDecisionReason ?? ''),
  };
}

/**
 * Run gate-guard.mjs with given stdin JSON and optional cwd.
 * @param {unknown} stdinObj
 * @param {string} [cwd]
 * @returns {{ stdout: string, stderr: string, status: number|null }}
 */
function runGuard(stdinObj, cwd) {
  // Enforcement is session-scoped: gate-guard is inert unless the session is a
  // devmate workflow. These tests exercise the ENFORCEMENT path, so they run
  // inside a marked session (see lib/test-utils/hook-session.mjs).
  return withMarkedSession(stdinObj, (payload) => {
    const result = spawnSync('node', [SCRIPT], {
      input: JSON.stringify(payload),
      cwd: cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  });
}

test('gate-guard.mjs - malformed stdin JSON exits 0, stdout is allow (cannot confirm devmate → never-block)', skipUnlessNode(24), () => {
  const result = spawnSync('node', [SCRIPT], {
    input: '{ not valid json !!',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, 'Should exit 0');
  const parsed = parseDecision(result.stdout);
  assert.equal(parsed.decision, 'allow');
});

test('gate-guard.mjs - empty stdin exits 0, stdout is JSON object', skipUnlessNode(24), () => {
  const result = spawnSync('node', [SCRIPT], {
    input: '',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, 'Should exit 0');
  const parsed = parseDecision(result.stdout);
  assert.ok(['allow', 'deny'].includes(parsed.decision));
});

test('gate-guard.mjs - non-edit tool with missing config exits 0, stdout is allow', skipUnlessNode(24), () => {
  // Use a temp dir with no devmate.config.json and no task.json
  const tmpDir = join(tmpdir(), `guard-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const payload = { tool_name: 'read_file', tool_input: { path: 'src/api/user.mjs' } };
    const result = runGuard(payload, tmpDir);
    assert.equal(result.status, 0);
    const parsed = parseDecision(result.stdout);
    // Non-edit tool should be allowed even without config
    assert.equal(parsed.decision, 'allow');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - source-edit tool with missing config exits 0, stdout is deny with init hint', skipUnlessNode(24), () => {
  const tmpDir = join(tmpdir(), `guard-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const payload = { tool_name: 'write_file', tool_input: { path: 'src/api/user.mjs' } };
    const result = runGuard(payload, tmpDir);
    assert.equal(result.status, 0);
    const parsed = parseDecision(result.stdout);
    assert.equal(parsed.decision, 'deny');
    assert.ok(parsed.reason?.includes('devmate init') || parsed.reason?.includes('config'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HITL-1: lane-gated implementation dispatch (PreToolUse / gate-guard.mjs).
// ---------------------------------------------------------------------------

/**
 * Build a tmp workspace for a runSubagent dispatch test.
 * @param {{ state?: Record<string, unknown>, scope?: string, diagnosis?: unknown }} [opts]
 * @returns {string} workspace dir
 */
function makeDispatchWorkspace(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-runsub-'));
  const stateDir = join(dir, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  if (opts.state) {
    writeFileSync(join(stateDir, 'task.json'), JSON.stringify(opts.state), 'utf8');
  }
  if (opts.diagnosis !== undefined) {
    writeFileSync(join(stateDir, 'diagnosis.json'), JSON.stringify(opts.diagnosis), 'utf8');
  }
  if (opts.scope !== undefined && opts.state) {
    const sdir = join(dir, '.devmate', 'session', String(opts.state['taskId']));
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'scope.md'), opts.scope, 'utf8');
  }
  return dir;
}

const FEATURE_IMPL = {
  taskId: 'T1',
  lane: 'feature',
  workflowGate: 'impl-started',
  artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc' },
  preImplStash: null,
  currentStep: 0,
  budget: 5,
  schemaVersion: 1,
};
const SUB_SCOPE = '---\nlane: bug\n---\n# Scope\n\n## Allowed paths\n- src/main/foo.mjs\n';
// #92: the feature lane's implementation dispatch now requires the same edit
// boundary the bug and chore lanes always did.
const FEATURE_SCOPE = '---\nlane: feature\n---\n# Scope\n\n## Allowed paths\n- src/main/foo.mjs\n';
const SUB_DIAGNOSIS = {
  bugScope: 'backend',
  suspectedLayer: 'service',
  reproCommand: 'npm test',
  fixerRecommendation: 'fix',
  // #92: the bug lane's edit boundary travels in the DiagnosisResult itself —
  // @diagnose has no edit tool and never could write a scope.md. Without these
  // fields the diagnosis is invalid, and an invalid diagnosis is treated exactly
  // like a missing one (fail-closed).
  allowedPaths: ['src/main/foo.mjs'],
  allowedGlobs: [],
  taskId: 'T1',
  schemaVersion: 1,
};

/** @param {{stdout: string}} r */
const parse = (r) => parseDecision(r.stdout);

test('gate-guard.mjs - runSubagent fullstack allowed when feature impl-started with spec + scope', skipUnlessNode(24), () => {
  const dir = makeDispatchWorkspace({ state: FEATURE_IMPL, scope: FEATURE_SCOPE });
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'frontend' } }, dir);
    assert.equal(parse(r).decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - runSubagent fullstack denied on missing spec metadata', skipUnlessNode(24), () => {
  const dir = makeDispatchWorkspace({ state: { ...FEATURE_IMPL, artifactHashes: {} } });
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'frontend' } }, dir);
    const parsed = parse(r);
    assert.equal(parsed.decision, 'deny');
    assert.match(parsed.reason, /spec artifact metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - runSubagent fullstack denied when gate not impl-started', skipUnlessNode(24), () => {
  const dir = makeDispatchWorkspace({ state: { ...FEATURE_IMPL, workflowGate: 'plan-approved' } });
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'frontend' } }, dir);
    const parsed = parse(r);
    assert.equal(parsed.decision, 'deny');
    assert.match(parsed.reason, /impl-started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - runSubagent fullstack denied with no task.json', skipUnlessNode(24), () => {
  const dir = makeDispatchWorkspace();
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'editor' } }, dir);
    const parsed = parse(r);
    assert.equal(parsed.decision, 'deny');
    assert.match(parsed.reason, /init-task-state/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - runSubagent discovery allowed with no task.json (analysis not gated)', skipUnlessNode(24), () => {
  const dir = makeDispatchWorkspace();
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'discovery', persona: 'discovery' } }, dir);
    assert.equal(parse(r).decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-guard.mjs - runSubagent bug fullstack: denied without diagnosis, allowed with diagnosis+scope', skipUnlessNode(24), () => {
  const bugState = { ...FEATURE_IMPL, lane: 'bug', artifactHashes: {} };

  const noDiag = makeDispatchWorkspace({ state: bugState, scope: SUB_SCOPE });
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'backend' } }, noDiag);
    const parsed = parse(r);
    assert.equal(parsed.decision, 'deny');
    assert.match(parsed.reason, /diagnosis\.json/);
  } finally {
    rmSync(noDiag, { recursive: true, force: true });
  }

  const ok = makeDispatchWorkspace({ state: bugState, scope: SUB_SCOPE, diagnosis: SUB_DIAGNOSIS });
  try {
    const r = runGuard({ tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'backend' } }, ok);
    assert.equal(parse(r).decision, 'allow');
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
});
