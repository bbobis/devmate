// @ts-check
/**
 * The inert half of runtime session-scoping (lib/hooks/session-marker.mjs).
 *
 * The enforcement half is covered by every migrated enforcement test (marked
 * session → hooks act). This file pins the OTHER half — the one a devmate bug
 * classically leaves untested: in an UNMARKED session the state-writing hooks
 * must do NOTHING. No [BUDGET] context injection, no fact/trace writes, no gate
 * moves — even when a stray task.json sits on disk.
 *
 * Each case drives the REAL hook entrypoint as a subprocess with a host-shaped
 * payload whose session_id has no marker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** A workspace with an in-flight-looking task.json — bait the hooks must ignore. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'inert-scope-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't-inert',
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
  );
  return root;
}

/**
 * @param {string} script  Repo-relative hook script.
 * @param {Record<string, unknown>} payload
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function spawnUnmarked(script, payload) {
  const r = spawnSync('node', [join(REPO_ROOT, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** @param {string} root */
function stateOf(root) {
  return JSON.parse(readFileSync(join(root, '.devmate', 'state', 'task.json'), 'utf8'));
}

test('unmarked: post-tool-use writes no fact, no trace, no worker return', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    const r = spawnUnmarked('hooks/post-tool-use.mjs', {
      hook_event_name: 'PostToolUse',
      session_id: randomUUID(),
      tool_name: 'replace_string_in_file',
      tool_input: { filePath: 'lib/example.mjs' },
      cwd: root,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'no output in an unmarked session');
    assert.equal(existsSync(join(root, '.devmate', 'memory')), false, 'no fact ledger');
    assert.equal(existsSync(join(root, '.devmate', 'state', 'trace')), false, 'no trace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked: check-session-budget injects no [BUDGET] context', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    const r = spawnUnmarked('scripts/check-session-budget.mjs', {
      hook_event_name: 'PostToolUse',
      session_id: randomUUID(),
      tool_name: 'read_file',
      tool_input: { filePath: 'README.md' },
      tool_response: 'x'.repeat(200),
      cwd: root,
    });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('[BUDGET'), `no budget line, got: ${r.stdout}`);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked: gate-advance moves no gate', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    const r = spawnUnmarked('hooks/gate-advance.mjs', {
      hook_event_name: 'PostToolUse',
      session_id: randomUUID(),
      tool_name: 'read_file',
      tool_input: { filePath: 'README.md' },
      tool_response: '',
      cwd: root,
    });
    assert.equal(r.status, 0);
    assert.equal(stateOf(root).workflowGate, 'impl-started', 'gate must not move');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked: spec-integrity-guard performs no rollback on a spec edit', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    // Bait: an approved gate + an on-disk spec whose digest cannot match.
    const state = stateOf(root);
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({ ...state, workflowGate: 'spec-approved', artifactHashes: { specDigest: 'stale' } }),
    );
    mkdirSync(join(root, '.devmate', 'session'), { recursive: true });
    const specAbs = join(root, '.devmate', 'session', 'spec.md');
    writeFileSync(specAbs, '# spec\nedited after approval\n');

    const r = spawnUnmarked('hooks/spec-integrity-guard.mjs', {
      hook_event_name: 'PostToolUse',
      session_id: randomUUID(),
      tool_name: 'applyPatch',
      tool_input: { filePath: specAbs },
      cwd: root,
    });
    assert.equal(r.status, 0);
    assert.equal(stateOf(root).workflowGate, 'spec-approved', 'no rollback in an unmarked session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked: contract-validator does not block a malformed artifact write', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    const artifact = join(root, '.devmate', 'state', 'diagnosis.json');
    writeFileSync(artifact, '{ "not": "a diagnosis" }');
    const r = spawnUnmarked('hooks/contract-validator.mjs', {
      hook_event_name: 'PostToolUse',
      session_id: randomUUID(),
      tool_name: 'create_file',
      tool_input: { filePath: artifact },
      cwd: root,
    });
    assert.equal(r.status, 0, 'must not exit 2 (blocking) in an unmarked session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmarked: subagent-budget-guard ignores a NON-devmate agent_type entirely', skipUnlessNode(24), () => {
  const root = makeWorkspace();
  try {
    const r = spawnSync('node', [join(REPO_ROOT, 'hooks/subagent-budget-guard.mjs'), 'start'], {
      input: JSON.stringify({
        hook_event_name: 'SubagentStart',
        session_id: randomUUID(),
        agent_id: 'x1',
        agent_type: 'someone-elses-agent',
        cwd: root,
      }),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 0, "another plugin's subagent must never be denied or metered");
    assert.equal((r.stdout ?? '').trim(), '');
    // And it must NOT mark the session: activeSubagents untouched.
    assert.equal(stateOf(root).activeSubagents ?? undefined, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
