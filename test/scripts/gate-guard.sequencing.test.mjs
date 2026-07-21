// @ts-check
/**
 * RC-3 (#231): the PreToolUse gate-guard surfaces an out-of-order ANALYSIS
 * dispatch — a model-visible advisory by default (warn), a deny when a repo opts
 * into 'block', and nothing when 'off' or when the dispatch is in order.
 *
 * The scenario: a devmate session dispatches `@spec-writer` while the gate is only
 * at `grill-done` (spec-writer's minimum is `plan-done`). Pre-fix, the guard let
 * this through silently, and the wasted spec.md surfaced far downstream. These
 * tests fail on the pre-fix guard (no advisory, no deny) and pass with it.
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
function hookOut(stdout) {
  const parsed = JSON.parse(stdout.trim());
  assert.ok(parsed.hookSpecificOutput, 'must use the PreToolUse wire shape');
  return parsed.hookSpecificOutput;
}

/**
 * A workspace with a feature task at a given gate, optionally with a config.
 * @param {string} gate
 * @param {Record<string, unknown>} [config]
 */
function workspace(gate, config) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-seq-'));
  mkdirSync(join(dir, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    join(dir, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't1',
      lane: 'feature',
      workflowGate: gate,
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
  );
  if (config !== undefined) {
    // A valid devmate.config.json requires an integer schemaVersion and a
    // non-empty personas array; without them the config fails to load and the
    // mode falls back to the 'warn' default (masking off/block under test).
    writeFileSync(
      join(dir, '.devmate', 'devmate.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
        ...config,
      }),
    );
  }
  return dir;
}

/** @param {string} agentName */
const dispatch = (agentName) => ({ tool_name: 'runSubagent', tool_input: { agentName } });

test('warn (default): an out-of-order @spec-writer is ALLOWED with a model-visible advisory', skipUnlessNode(24), () => {
  const dir = workspace('grill-done');
  const sid = randomUUID();
  markDevmateSession(sid, 'router');
  try {
    const r = runGuard({ ...dispatch('spec-writer'), session_id: sid }, dir);
    const out = hookOut(r.stdout);
    assert.equal(out.permissionDecision, 'allow', 'warn must not block');
    assert.match(
      String(out.additionalContext),
      /spec-writer.*plan-done|dispatched at gate.*before/is,
      `the advisory must be model-visible; got: ${JSON.stringify(out)}`,
    );
  } finally {
    clearDevmateSession(sid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('block: the SAME out-of-order dispatch is DENIED when the repo opts in', skipUnlessNode(24), () => {
  const dir = workspace('grill-done', { dispatchSequencing: 'block' });
  const sid = randomUUID();
  markDevmateSession(sid, 'router');
  try {
    const r = runGuard({ ...dispatch('spec-writer'), session_id: sid }, dir);
    const out = hookOut(r.stdout);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(String(out.permissionDecisionReason), /spec-writer|plan-done/);
  } finally {
    clearDevmateSession(sid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('off: the guard is silent when disabled', skipUnlessNode(24), () => {
  const dir = workspace('grill-done', { dispatchSequencing: 'off' });
  const sid = randomUUID();
  markDevmateSession(sid, 'router');
  try {
    const r = runGuard({ ...dispatch('spec-writer'), session_id: sid }, dir);
    const out = hookOut(r.stdout);
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.additionalContext, undefined, 'off must add no advisory');
  } finally {
    clearDevmateSession(sid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in order: @spec-writer at plan-done is a clean allow, no advisory', skipUnlessNode(24), () => {
  const dir = workspace('plan-done');
  const sid = randomUUID();
  markDevmateSession(sid, 'router');
  try {
    const r = runGuard({ ...dispatch('spec-writer'), session_id: sid }, dir);
    const out = hookOut(r.stdout);
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.additionalContext, undefined, 'an in-order dispatch must be silent');
  } finally {
    clearDevmateSession(sid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inert outside a devmate session: an out-of-order dispatch is a plain allow', skipUnlessNode(24), () => {
  // spec-writer is not an implementation dispatch, so an UNMARKED session exits
  // inert before the sequencing check ever runs — the never-block guarantee.
  const dir = workspace('grill-done');
  try {
    const r = runGuard({ ...dispatch('spec-writer'), session_id: randomUUID() }, dir);
    const out = hookOut(r.stdout);
    assert.equal(out.permissionDecision, 'allow');
    assert.equal(out.additionalContext, undefined, 'outside a devmate session the guard must be inert');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
