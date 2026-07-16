// @ts-check
/**
 * #76 — wire-level tests for the SubagentStart/Stop guard: spawn the real
 * entrypoint the way the host does and feed it REAL payload shapes.
 *
 * The parser used to read `repoRoot`/`taskId`/`agentName`/`persona` — keys no
 * host sends — so in production every value took its fallback: the root became
 * raw process cwd (the workspace's own `.devmate/` folder when that is
 * workspaceFolders[0]) and the ids became the literal "unknown". Net effect on
 * a user's disk: `.devmate/.devmate/state/trace/unknown.jsonl`, and a HITL-1
 * SubagentStart layer that never evaluated. The handler suites call the
 * handlers directly with the internal event shape; only a spawn test can catch
 * the parser reading fields that are not there.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'subagent-budget-guard.mjs');

/**
 * @param {unknown} payload
 * @param {string} cwd
 * @param {string} [mode]
 */
function spawnHook(payload, cwd, mode = 'start') {
  const r = spawnSync('node', [HOOK, mode], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: r.stderr ?? '',
  };
}

/** Seed a workspace; optionally with an active task. */
function workspace(opts = { task: false }) {
  const root = mkdtempSync(join(tmpdir(), 'sbg-wire-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  if (opts.task) {
    writeFileSync(
      join(root, '.devmate', 'state', 'task.json'),
      JSON.stringify({
        taskId: 'feat-76',
        lane: 'feature',
        workflowGate: 'impl-started',
        artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc' },
        preImplStash: null,
        currentStep: 0,
        budget: 10,
        activePersona: 'backend',
        schemaVersion: 1,
      }),
      'utf8',
    );
  }
  return root;
}

test(
  'cwd = the workspace .devmate folder: NO nested .devmate/.devmate is created',
  skipUnlessNode(24),
  () => {
    // The production repro: monoroot lists .devmate first in the
    // .code-workspace, VS Code uses workspaceFolders[0] as the hook cwd, and
    // the old parser fell back to raw process.cwd(). One dispatch was enough
    // to mint .devmate/.devmate/state/trace/unknown.jsonl.
    const root = workspace();
    const devmateDir = join(root, '.devmate');
    try {
      const r = spawnHook(
        { hook_event_name: 'SubagentStart', agent_type: 'discovery', agent_id: 'a1', cwd: devmateDir },
        devmateDir,
      );
      assert.equal(r.status, 0);
      assert.equal(
        existsSync(join(devmateDir, '.devmate')),
        false,
        'the doubled .devmate/.devmate must never be created',
      );
      // And no sentinel-keyed trace anywhere: pre-task, the append is skipped.
      const traceDir = join(root, '.devmate', 'state', 'trace');
      const files = existsSync(traceDir) ? readdirSync(traceDir) : [];
      assert.ok(!files.includes('unknown.jsonl'), 'no unknown.jsonl, ever');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'payload with NO cwd still resolves: falls back to process cwd and climbs',
  skipUnlessNode(24),
  () => {
    // payload.cwd is optional in the official schema. With it absent the
    // resolver must fall back to the process cwd — here the .devmate folder —
    // and still land state one level up.
    const root = workspace({ task: true });
    const devmateDir = join(root, '.devmate');
    try {
      const r = spawnHook(
        { hook_event_name: 'SubagentStart', agent_type: 'discovery', agent_id: 'a1' },
        devmateDir,
      );
      assert.equal(r.status, 0, 'an allowed dispatch exits 0');
      assert.equal(existsSync(join(devmateDir, '.devmate')), false);
      // The dispatch traced into the REAL task's file at the REAL location.
      assert.ok(existsSync(join(root, '.devmate', 'state', 'trace', 'feat-76.jsonl')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'HITL-1 fires on the wire: agent_type "fullstack" with no task is BLOCKED',
  skipUnlessNode(24),
  () => {
    // Two separate defects had to die for this deny to reach the host.
    //
    // #76: the parser read `agentName` (never sent), got "unknown", and
    // isImplementationDispatch("unknown") is false — so the deny was never even
    // computed. `agent_type` is the field VS Code sends.
    //
    // #77: once computed, the deny was emitted as `{"decision":"denied"}` with
    // exit 0. VS Code documents NO blocking field for SubagentStart — its
    // hookSpecificOutput carries additionalContext and nothing else — and
    // "denied" is not a value in its vocabulary anywhere. The verdict was
    // correct and the host threw it away. The documented stops are
    // `continue: false` and exit 2; the guard now uses both.
    const root = workspace(); // no task.json
    try {
      const r = spawnHook(
        { hook_event_name: 'SubagentStart', agent_type: 'fullstack', agent_id: 'a2', cwd: root },
        root,
      );
      assert.equal(r.status, 2, 'exit 2 is the documented blocking error');
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, false, 'the common output format stops the run');
      assert.match(String(out.stopReason), /init-task-state/);
      // On a blocking exit the model is shown stderr — so the reason has to be there.
      assert.match(r.stderr, /init-task-state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('with an active task, the dispatch traces under the STATE taskId', skipUnlessNode(24), () => {
  const root = workspace({ task: true });
  try {
    const r = spawnHook(
      { hook_event_name: 'SubagentStart', agent_type: 'discovery', agent_id: 'a3', cwd: root },
      root,
    );
    assert.equal(r.status, 0);
    // An allowed start says nothing to the host: SubagentStart has no field for
    // "allowed", so stdout stays empty rather than carrying a shape the host
    // would only ignore.
    assert.equal(r.stdout.trim(), '');
    const tracePath = join(root, '.devmate', 'state', 'trace', 'feat-76.jsonl');
    assert.ok(existsSync(tracePath), 'trace keyed on task.json taskId, not a payload field');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
