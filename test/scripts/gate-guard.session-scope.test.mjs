// @ts-check
/**
 * The never-block guarantee: gate-guard must be INERT outside an active devmate
 * session, and ENFORCE inside one — for the SAME denial condition.
 *
 * This pins the user's hard requirement: whatever state `task.json` is in
 * (missing, lane-less, stale), a user who is not running devmate is never
 * blocked. Enforcement (fail-closed) applies only once a devmate agent has been
 * dispatched, which the session marker records from SubagentStart.agent_type.
 *
 * The scenario is exactly the `#35` case from the field log: an implementation
 * dispatch (`runSubagent` → `fullstack`) with no usable task state. Unmarked →
 * allow; marked → deny. The test process writes the marker to the shared OS
 * temp dir that the spawned hook reads.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { markDevmateSession, clearDevmateSession } from '../../lib/hooks/session-marker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

/** @param {unknown} stdinObj @param {string} cwd */
function runGuard(stdinObj, cwd) {
  const r = spawnSync('node', [SCRIPT], {
    input: JSON.stringify(stdinObj),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

/** @param {string} stdout */
function decision(stdout) {
  const parsed = JSON.parse(stdout.trim());
  assert.ok(parsed.hookSpecificOutput, 'must use the PreToolUse wire shape');
  return String(parsed.hookSpecificOutput.permissionDecision ?? '');
}

/** An implementation dispatch — self-identifying as devmate; always gate-checked. */
const DISPATCH = { tool_name: 'runSubagent', tool_input: { agentName: 'fullstack', persona: 'frontend' } };
/** A plain source edit — a user's own action; never blocked outside a devmate session. */
const SOURCE_EDIT = { tool_name: 'create_file', tool_input: { filePath: 'src/app.mjs', content: 'x' } };

/** @returns {string} bare workspace dir (no .devmate at all) */
function bareWorkspace() {
  return mkdtempSync(join(tmpdir(), 'gg-scope-'));
}

test('unmarked session: a source EDIT with a lane-less task.json is ALLOWED (never-block guarantee)', skipUnlessNode(24), () => {
  const dir = bareWorkspace();
  try {
    mkdirSync(join(dir, '.devmate', 'state'), { recursive: true });
    // The user's own edits are what the never-block guarantee protects: a
    // stray/lane-less task.json must never block someone not running devmate.
    writeFileSync(join(dir, '.devmate', 'state', 'task.json'), JSON.stringify({ schemaVersion: 1 }));
    const r = runGuard({ ...SOURCE_EDIT, session_id: randomUUID() }, dir);
    assert.equal(decision(r.stdout), 'allow', 'a lane-less task.json must not block a non-devmate user edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unmarked session: a plain read is ALLOWED', skipUnlessNode(24), () => {
  const dir = bareWorkspace();
  try {
    const r = runGuard({ tool_name: 'read_file', tool_input: { filePath: 'README.md' }, session_id: randomUUID() }, dir);
    assert.equal(decision(r.stdout), 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unmarked session: an IMPLEMENTATION DISPATCH is still DENIED (self-identifying devmate; #35 restore)', skipUnlessNode(24), () => {
  // The one exception to inert-without-a-marker: runSubagent → fullstack cannot
  // come from a plain-Copilot session, and starting a worker at a
  // pre-implementation gate is the highest-risk action. It must be denied at
  // dispatch time even before the first SubagentStart marks the session.
  const dir = bareWorkspace();
  try {
    const r = runGuard({ ...DISPATCH, session_id: randomUUID() }, dir);
    assert.equal(r.status, 0);
    assert.equal(decision(r.stdout), 'deny', 'an impl dispatch with no lane in flight must be blocked at dispatch time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marked session: the SAME dispatch is DENIED (enforcement works inside devmate too)', skipUnlessNode(24), () => {
  const dir = bareWorkspace();
  const sid = randomUUID();
  markDevmateSession(sid, 'router');
  try {
    const r = runGuard({ ...DISPATCH, session_id: sid }, dir);
    assert.equal(r.status, 0);
    assert.equal(decision(r.stdout), 'deny', 'inside a devmate session, an impl dispatch with no task state must be blocked');
  } finally {
    clearDevmateSession(sid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed stdin is ALLOWED, not denied (cannot confirm devmate → never-block)', skipUnlessNode(24), () => {
  const r = spawnSync('node', [SCRIPT], { input: '{ not json', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(decision(r.stdout ?? ''), 'allow');
});
