// @ts-check
/**
 * Issue #5 — E2E: manual task.json tampering and state-corruption detection +
 * recovery.
 *
 * These run the REAL hooks (scripts/session-start.mjs SessionStart,
 * hooks/approval-listener.mjs UserPromptSubmit) and the REAL doctor
 * (scripts/devmate-doctor.mjs) as subprocesses against a temp workspace, then
 * tamper with the durable artifacts by hand — exactly what a user editing
 * task.json, forging an approval, or corrupting a trace would do — and assert:
 *
 *   - the gate/evidence divergence is DETECTED and surfaced as a one-line
 *     `state: desynced` field in the model-visible anchor;
 *   - the doctor exits non-zero on an unreconciled desync and names the
 *     recovery command;
 *   - `devmate-doctor --fix` reconciles the gate to the last evidence-backed
 *     gate and a re-check comes back clean;
 *   - corrupt/deleted task.json and a stale resume pointer never CRASH a hook
 *     (no exit 2, the subprocess always completes) — the fail-safe invariant.
 *
 * Every write lands in a fresh temp workspace; nothing touches the repo tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  HOST_CWD_REL,
  DEFAULT_SESSION_ID,
  seedMonorootWorkspace,
  replaySession,
  spawnHook,
  readState,
} from './session-harness.mjs';

/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

const SESSION_START = 'scripts/session-start.mjs';
const APPROVAL_LISTENER = 'hooks/approval-listener.mjs';
const DOCTOR = 'scripts/devmate-doctor.mjs';

/**
 * Seed a minimal *healthy* memory pipeline (one promoted repo-ledger fact that
 * MEMORY.md renders) so the doctor's memory stage is green. Without this the
 * doctor exits 1 on the empty-workspace "no facts anywhere" diagnosis, which
 * would confound the gate-consistency exit-code assertions these tests make.
 * @param {string} root
 */
function seedHealthyMemory(root) {
  const repoLedgerDir = join(root, '.devmate', 'state', 'repo');
  mkdirSync(repoLedgerDir, { recursive: true });
  writeFileSync(
    join(repoLedgerDir, 'repo.jsonl'),
    `${JSON.stringify({ event: 'fact', ts: 1, text: 'seed fact' })}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, '.devmate', 'MEMORY.md'),
    '# Memory\n\n<!-- devmate:facts:start -->\n- seed fact\n<!-- devmate:facts:end -->\n',
    'utf8',
  );
}

/**
 * Seed a workspace and bootstrap task.json via a real SessionStart, so a task
 * exists to tamper with.
 * @returns {{ root: string, hostCwd: string, stateDir: string, taskId: string }}
 */
function bootstrap() {
  const ws = seedMonorootWorkspace();
  replaySession(
    [{ hook_event_name: 'SessionStart', session_id: DEFAULT_SESSION_ID, source: 'new', timestamp: '2026-01-01T00:00:00.000Z' }],
    ws.hostCwd,
  );
  seedHealthyMemory(ws.root);
  const state = readState(ws.root);
  return { root: ws.root, hostCwd: ws.hostCwd, stateDir: ws.stateDir, taskId: state.taskId };
}

/**
 * Overwrite task.json with a hand-edited copy (the tamper), preserving every
 * field the validator requires and changing only what a caller asks.
 * @param {string} root
 * @param {Partial<Record<string, unknown>>} patch
 */
function tamperState(root, patch) {
  const statePath = join(root, '.devmate', 'state', 'task.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...state, ...patch }, null, 2), 'utf8');
}

/** @param {string} stateDir @param {unknown} result */
function writeRouterResult(stateDir, result) {
  writeFileSync(join(stateDir, 'router-result.json'), JSON.stringify(result), 'utf8');
}

/**
 * Write a JSONL trace for a task from an array of event objects (and optional
 * raw garbage lines to simulate corruption).
 * @param {string} stateDir
 * @param {string} taskId
 * @param {Array<Record<string, unknown>|string>} lines
 */
function writeTrace(stateDir, taskId, lines) {
  const traceDir = join(stateDir, 'trace');
  mkdirSync(traceDir, { recursive: true });
  const body = lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n');
  writeFileSync(join(traceDir, `${taskId}.jsonl`), `${body}\n`, 'utf8');
}

/**
 * A valid gate_transition trace event.
 * @param {string} taskId
 * @param {WorkflowGate} from
 * @param {WorkflowGate} to
 * @param {{ actor?: string, evidence?: string }} [audit]
 * @returns {Record<string, unknown>}
 */
function gateTransition(taskId, from, to, audit = {}) {
  return {
    type: 'gate_transition',
    taskId,
    stepId: 'test-seed',
    ts: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    from,
    to,
    gate: to,
    ...(audit.actor !== undefined ? { actor: audit.actor } : {}),
    ...(audit.evidence !== undefined ? { evidence: audit.evidence } : {}),
  };
}

/**
 * Run a real SessionStart against the (tampered) workspace and return the raw
 * subprocess result.
 * @param {{ root: string, hostCwd: string }} ws
 */
function runSessionStart(ws) {
  return spawnHook(
    SESSION_START,
    [],
    { hook_event_name: 'SessionStart', session_id: DEFAULT_SESSION_ID, source: 'resume', cwd: ws.hostCwd, timestamp: '2026-01-01T00:00:00.000Z' },
    ws.hostCwd,
  );
}

/**
 * Run a real UserPromptSubmit against the (tampered) workspace.
 * @param {{ root: string, hostCwd: string }} ws
 * @param {string} [prompt]
 */
function runPrompt(ws, prompt = 'what is the current status?') {
  return spawnHook(
    APPROVAL_LISTENER,
    [],
    { hook_event_name: 'UserPromptSubmit', session_id: DEFAULT_SESSION_ID, prompt, cwd: ws.hostCwd, timestamp: '2026-01-01T00:00:00.000Z' },
    ws.hostCwd,
  );
}

/**
 * Run the doctor against a workspace root and parse its single-line JSON
 * summary from stdout.
 * @param {string} root
 * @param {string[]} [extra]
 * @returns {{ status: number, stdout: string, stderr: string, summary: any }}
 */
function runDoctor(root, extra = []) {
  const r = spawnHook(DOCTOR, ['--root', root, ...extra], {}, join(root, HOST_CWD_REL));
  const lastLine = r.stdout.trim().split('\n').filter((l) => l.trim() !== '').at(-1) ?? '{}';
  let summary = {};
  try {
    summary = JSON.parse(lastLine);
  } catch {
    summary = {};
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary };
}

// ---------------------------------------------------------------------------

test('forward tamper: gate hand-advanced past the evidence is detected everywhere', () => {
  const ws = bootstrap();
  // Gate hand-set to spec-approved with NO evidence artifacts and NO trace —
  // the exact tamper the issue names.
  tamperState(ws.root, { lane: 'feature', workflowGate: 'spec-approved' });

  // (a) SessionStart anchor surfaces the desync, names the rollback target, and
  // states dispatch stays denied. The hook exits cleanly (never blocks).
  const ss = runSessionStart(ws);
  assert.equal(ss.status, 0);
  assert.match(ss.stdout, /state: desynced/);
  assert.match(ss.stdout, /Dispatch stays denied/);
  assert.match(ss.stdout, /no-lane/); // last evidence-backed gate with no artifacts

  // (b) UserPromptSubmit anchor surfaces the same desync on an ordinary prompt.
  const up = runPrompt(ws);
  assert.equal(up.status, 0);
  assert.match(up.stdout, /state: desynced/);

  // (c) doctor (no --fix) exits 1, flags 'forward', and names the recovery cmd.
  const doc = runDoctor(ws.root);
  assert.equal(doc.status, 1);
  assert.equal(doc.summary.gateConsistency.ok, false);
  assert.ok(doc.summary.gateConsistency.divergences.includes('forward'));
  assert.match(doc.stderr, /\[gate-consistency\]/);
  assert.match(doc.stderr, /recovery:/);
});

test('recovery journey: devmate-doctor --fix reconciles the gate and re-check is clean', () => {
  const ws = bootstrap();
  tamperState(ws.root, { lane: 'feature', workflowGate: 'spec-approved' });

  const fixed = runDoctor(ws.root, ['--fix']);
  assert.equal(fixed.status, 0);
  assert.equal(fixed.summary.gateFixed, true);
  assert.equal(fixed.summary.gateConsistency.ok, true);

  // The durable gate was rolled back to the last evidence-backed gate.
  assert.equal(readState(ws.root).workflowGate, 'no-lane');

  // A reconcile stamps an audited gate_transition so the fix itself is auditable.
  const trace = readFileSync(join(ws.stateDir, 'trace', `${ws.taskId}.jsonl`), 'utf8');
  assert.match(trace, /"actor":"devmate-doctor"/);

  // A fresh doctor run is now green with nothing left to fix.
  const recheck = runDoctor(ws.root);
  assert.equal(recheck.status, 0);
  assert.equal(recheck.summary.gateFixed, false);
});

test('backward tamper: trace records more progress than the persisted gate', () => {
  const ws = bootstrap();
  // Back lane-set with a valid router result so `forward` cannot fire, then
  // reset the gate to lane-set while the trace shows advancement to grill-done.
  writeRouterResult(ws.stateDir, { lane: 'feature', budgetClass: 'standard', confidence: 0.9 });
  writeTrace(ws.stateDir, ws.taskId, [
    gateTransition(ws.taskId, 'no-lane', 'lane-set'),
    gateTransition(ws.taskId, 'lane-set', 'discovery-done'),
    gateTransition(ws.taskId, 'discovery-done', 'grill-done'),
  ]);
  tamperState(ws.root, { lane: 'feature', workflowGate: 'lane-set' });

  const doc = runDoctor(ws.root);
  assert.equal(doc.status, 1);
  assert.ok(doc.summary.gateConsistency.divergences.includes('backward'));
  assert.match(doc.stderr, /gate behind trace/);
  assert.match(doc.stderr, /do NOT re-dispatch/);

  // The anchor also surfaces it on the next prompt, without crashing.
  const up = runPrompt(ws);
  assert.equal(up.status, 0);
  assert.match(up.stdout, /state: desynced/);
});

test('forged approval: a human gate with no audited transition is detected', () => {
  const ws = bootstrap();
  // Draft a spec so spec-approved's artifact is present, but record NO audited
  // gate_transition into spec-approved — the approval was never stamped.
  mkdirSync(join(ws.root, '.devmate', 'session'), { recursive: true });
  writeFileSync(join(ws.root, '.devmate', 'session', 'spec.md'), '# Spec\n\nContent.\n', 'utf8');
  writeTrace(ws.stateDir, ws.taskId, [
    // A transition INTO spec-approved that is unaudited (no actor/evidence).
    gateTransition(ws.taskId, 'spec-draft', 'spec-approved'),
  ]);
  tamperState(ws.root, { lane: 'feature', workflowGate: 'spec-approved' });

  const doc = runDoctor(ws.root);
  assert.equal(doc.status, 1);
  assert.ok(doc.summary.gateConsistency.divergences.includes('forged'));
  assert.match(doc.stderr, /forged approval/);
});

test('malformed trace above threshold: reported as corrupt, names the file, no crash', () => {
  const ws = bootstrap();
  writeRouterResult(ws.stateDir, { lane: 'feature', budgetClass: 'standard', confidence: 0.9 });
  // 1 good line + 1 garbage line = 50% malformed (> 5% threshold).
  writeTrace(ws.stateDir, ws.taskId, [
    gateTransition(ws.taskId, 'no-lane', 'lane-set'),
    '{ this is not valid json',
  ]);
  tamperState(ws.root, { lane: 'feature', workflowGate: 'lane-set' });

  const doc = runDoctor(ws.root);
  assert.equal(doc.status, 1);
  assert.ok(doc.summary.gateConsistency.divergences.includes('malformed-trace'));
  assert.ok(doc.stderr.includes(`${ws.taskId}.jsonl`), doc.stderr);

  const up = runPrompt(ws);
  assert.equal(up.status, 0);
  assert.match(up.stdout, /state: desynced/);
});

test('malformed trace below threshold: not flagged as corrupt', () => {
  const ws = bootstrap();
  writeRouterResult(ws.stateDir, { lane: 'feature', budgetClass: 'standard', confidence: 0.9 });
  // 20 good lines + 1 garbage line ≈ 4.76% malformed (< 5% threshold).
  /** @type {Array<Record<string, unknown>|string>} */
  const lines = [];
  for (let i = 0; i < 20; i += 1) lines.push(gateTransition(ws.taskId, 'no-lane', 'lane-set'));
  lines.push('not json at all');
  writeTrace(ws.stateDir, ws.taskId, lines);
  tamperState(ws.root, { lane: 'feature', workflowGate: 'lane-set' });

  const doc = runDoctor(ws.root);
  // lane-set is fully evidence-backed (router present) and the trace is within
  // tolerance, so the gate is consistent.
  assert.equal(doc.status, 0);
  assert.equal(doc.summary.gateConsistency.ok, true);
});

test('corrupt task.json never crashes a hook and the doctor tolerates it', () => {
  const ws = bootstrap();
  writeFileSync(join(ws.stateDir, 'task.json'), '{ "taskId": "x", not valid', 'utf8');

  // Neither hook may block (exit 2) or throw uncaught; both must complete.
  const ss = runSessionStart(ws);
  assert.notEqual(ss.status, 2);
  assert.equal(typeof ss.status, 'number');

  const up = runPrompt(ws);
  assert.notEqual(up.status, 2);
  assert.equal(typeof up.status, 'number');

  // The doctor completes (does not throw) and its gate stage is a no-op —
  // an unreadable state file is not a desync it can or should reconcile.
  const doc = runDoctor(ws.root);
  assert.equal(typeof doc.status, 'number');
  assert.equal(doc.summary.gateConsistency, null);
});

test('deleted task.json mid-task never crashes a hook', () => {
  const ws = bootstrap();
  rmSync(join(ws.stateDir, 'task.json'), { force: true });

  const up = runPrompt(ws);
  assert.notEqual(up.status, 2);
  assert.equal(typeof up.status, 'number');

  const doc = runDoctor(ws.root);
  assert.equal(typeof doc.status, 'number');
  assert.equal(doc.summary.gateConsistency, null);
});

test('stale resume pointer naming a nonexistent task never crashes a hook', () => {
  const ws = bootstrap();
  tamperState(ws.root, { lane: 'feature', workflowGate: 'parked' });
  writeFileSync(
    join(ws.stateDir, 'resume-pointer.json'),
    JSON.stringify({ taskId: 'ghost-task-does-not-exist', gate: 'grill-done', recordedAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  );

  const ss = runSessionStart(ws);
  assert.notEqual(ss.status, 2);
  assert.equal(typeof ss.status, 'number');

  const up = runPrompt(ws);
  assert.notEqual(up.status, 2);
  assert.equal(typeof up.status, 'number');
});

// A parity guard: the real SessionStart and UserPromptSubmit hooks are the ones
// actually registered in hooks/hooks.json (not stand-ins used above).
test('the hooks under test are the registered ones', async () => {
  const { hooksFor } = await import('./session-harness.mjs');
  const ssScripts = hooksFor('SessionStart').map((h) => h.script);
  const upScripts = hooksFor('UserPromptSubmit').map((h) => h.script);
  assert.ok(ssScripts.includes(SESSION_START), `SessionStart hooks: ${ssScripts.join(', ')}`);
  assert.ok(upScripts.includes(APPROVAL_LISTENER), `UserPromptSubmit hooks: ${upScripts.join(', ')}`);
  assert.ok(REPO_ROOT.length > 0);
});
