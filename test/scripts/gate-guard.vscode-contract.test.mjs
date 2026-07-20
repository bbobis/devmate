// @ts-check
/**
 * #74 — the regression suite that would have caught the bug.
 *
 * Every fixture below is a VERBATIM-SHAPED VS Code Copilot PreToolUse payload,
 * captured from a real session (tool names cross-checked against the `ToolName`
 * enum in microsoft/vscode-copilot-chat, src/extension/tools/common/toolNames.ts;
 * `tool_input` keys against that repo's tool inputSchemas). The pre-existing
 * suites hand-authored Claude-Code-shaped payloads (`write_file`,
 * `tool_input.path`) and therefore proved the bug rather than catching it:
 *
 *   - `SOURCE_EDIT_TOOLS` contained no VS Code tool, so `isEdit` was false for
 *     every real edit and the guard returned `allow` for all of them.
 *   - `tool_input.path` is a key VS Code never sends (it sends `filePath`), so
 *     `payload.path` was always undefined and Rules 4-7 — persona scope,
 *     scope.md, TDD — were UNREACHABLE. They could not deny anything.
 *   - The verdict was written as a bare `{decision}`, which is the
 *     PostToolUse/Stop schema; VS Code ignores it on PreToolUse and runs the
 *     tool regardless.
 *
 * All three are asserted here against the real wire contract.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withMarkedSession } from '../../lib/test-utils/hook-session.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

/**
 * Run the real hook entrypoint as a subprocess, the way VS Code does. The
 * workspace dir is injected as `payload.cwd` (the field the guard resolves its
 * root from since #76) as well as the process cwd; a payload that sets its own
 * `cwd` keeps it, mirroring a host that reports a different folder.
 * @param {Record<string, unknown>} payload
 * @param {string} cwd
 * @returns {{ decision: string|undefined, reason: string, status: number|null }}
 */
function runHook(payload, cwd) {
  return withMarkedSession({ cwd, ...payload }, (marked) => {
    const r = spawnSync('node', [SCRIPT], {
      input: JSON.stringify(marked),
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    });
    const parsed = JSON.parse((r.stdout ?? '').trim());
    // The host reads ONLY this shape. A bare top-level `decision` is silently
    // ignored on PreToolUse — which is why the guard denied nothing for so long.
    assert.ok(
      parsed.hookSpecificOutput,
      'PreToolUse verdict must be nested under hookSpecificOutput',
    );
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    return {
      decision: parsed.hookSpecificOutput.permissionDecision,
      reason: parsed.hookSpecificOutput.permissionDecisionReason ?? '',
      status: r.status,
    };
  });
}

/**
 * A workspace with a devmate.config.json and optionally a task.json.
 * @param {{ config?: unknown, state?: unknown, scope?: string }} [opts]
 * @returns {string}
 */
function workspace(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-vscode-'));
  const stateDir = join(dir, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  if (opts.config !== undefined) {
    writeFileSync(
      join(dir, '.devmate', 'devmate.config.json'),
      JSON.stringify(opts.config),
      'utf8',
    );
  }
  if (opts.state !== undefined) {
    writeFileSync(join(stateDir, 'task.json'), JSON.stringify(opts.state), 'utf8');
  }
  if (opts.scope !== undefined && opts.state) {
    const taskId = String(/** @type {Record<string, unknown>} */ (opts.state)['taskId']);
    const sdir = join(dir, '.devmate', 'session', taskId);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'scope.md'), opts.scope, 'utf8');
  }
  return dir;
}

const CONFIG = {
  schemaVersion: 1,
  personas: [
    {
      persona: 'backend',
      editableGlobs: ['src/api/**', 'src/db/**'],
      offLimitsGlobs: ['src/api/secrets/**'],
    },
  ],
};

/** @param {string} gate */
const taskAt = (gate) => ({
  taskId: 'T1',
  lane: 'feature',
  workflowGate: gate,
  currentStep: 0,
  artifactHashes: {},
  preImplStash: null,
  budget: 10,
  tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
  schemaVersion: 1,
});

/**
 * The task's edit contract, allowing exactly one file. Rule 6 is the only
 * path-keyed boundary left at the tool call (#99 deleted the persona rule), so
 * it is the observable for every "the guard actually read the path" assertion
 * below: its deny names the file it rejected.
 */
const SCOPE_ONE_FILE = '---\nlane: feature\n---\n# Scope\n\n## Allowed paths\n- src/api/user.mjs\n';

/**
 * The exact tool + tool_input shape observed in a real session. `cwd` is
 * injected by runHook — since #76 the guard resolves its root from it, so the
 * old fixture value (a deliberately bogus path, from when the guard ignored
 * the field entirely) would now be honored and break every state read.
 */
const replaceString = (filePath = 'src/api/user.mjs') => ({
  timestamp: '2026-07-13T00:32:36.405Z',
  hook_event_name: 'PreToolUse',
  session_id: '90d5b813-679d-42e6-962a-667b7d918dbe',
  tool_name: 'replace_string_in_file',
  tool_input: { filePath, oldString: 'a', newString: 'b' },
  tool_use_id: 'toolu_bdrk_017vgKxToHGQrkcYcEGWoSpJ__vscode-1',
});

// ── The headline regression: a real edit is no longer waved through ──────────

test(
  'replace_string_in_file with no config is DENIED (was: allow)',
  skipUnlessNode(24),
  () => {
    const dir = workspace(); // no devmate.config.json
    try {
      const r = runHook(replaceString(), dir);
      assert.equal(r.status, 0);
      assert.equal(
        r.decision,
        'deny',
        'a real VS Code edit tool must reach Rule 1; before #74 this returned "allow"',
      );
      assert.match(r.reason, /devmate init/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('read_file is still allowed — no false positive on the read path', skipUnlessNode(24), () => {
  const dir = workspace();
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'read_file',
        tool_input: { filePath: 'src/api/user.mjs', startLine: 1, endLine: 200 },
      },
      dir,
    );
    assert.equal(r.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The anti-drift guarantee ────────────────────────────────────────────────

test(
  'an UNRECOGNIZED tool is gated, not allowed by default (anti-drift)',
  skipUnlessNode(24),
  () => {
    // Same workspace, same absent task. The ONLY difference is the tool name —
    // so this isolates the classification, which is the whole bug.
    const dir = workspace({ config: CONFIG });
    try {
      const known = runHook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'read_file',
          tool_input: { filePath: 'src/api/user.mjs' },
        },
        dir,
      );
      assert.equal(known.decision, 'allow', 'a known read tool is not gated');

      // A tool VS Code might add or rename to tomorrow. The old edit-allowlist
      // would have waved this through — that is exactly how #74 happened.
      const unknown = runHook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'some_future_edit_tool',
          tool_input: { filePath: 'src/api/user.mjs' },
        },
        dir,
      );
      assert.equal(unknown.decision, 'deny', 'an unknown tool must fail CLOSED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('an unrecognized tool gets an honest reason, not a bogus one', skipUnlessNode(24), () => {
  // `path` is a key VS Code never sends, so no TARGET is extracted and the call
  // reaches Rule 3b — but it plainly names a source file, so it is still an edit
  // (#94). It must NOT be told "terminal edits are blocked": it ran no shell
  // command, and that reason would send the caller chasing a phantom. The
  // tool_input used to be `{}` here, back when an unrecognized name was gated on
  // the name alone.
  const dir = workspace({ config: CONFIG, state: taskAt('impl-started') });
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'some_future_edit_tool',
        tool_input: { path: 'lib/app.mjs' },
      },
      dir,
    );
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /not a tool devmate recognizes/);
    assert.match(r.reason, /lib\/app\.mjs/, 'the deny must name the path the tool asked for');
    assert.doesNotMatch(r.reason, /through the terminal/);
    // The old reason told the caller to edit devmate's own library source, which
    // a plugin consumer cannot touch — an unactionable deny (#94).
    assert.doesNotMatch(r.reason, /gate-guard-core\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSubagent is never gated as an edit — dispatch must not deadlock', skipUnlessNode(24), () => {
  // Classifying runSubagent as an edit would make Rule 2 ("no active task") deny
  // every dispatch before a task exists — and dispatch is the only way a task
  // ever starts. The orchestrator would be unable to begin any work at all.
  const dir = workspace({ config: CONFIG }); // deliberately no task.json
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'runSubagent',
        tool_input: { agentName: 'discovery' },
      },
      dir,
    );
    assert.equal(r.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Rules 4-7 are REACHABLE. Before #74 every one of them was dead code,
//    because payload.path was always '' (devmate read `path`, VS Code sends
//    `filePath`). A rule that cannot fire is a rule that proves nothing.

test('Rule 5 (persona scope) is GONE: the persona does not gate an edit', skipUnlessNode(24), () => {
  // The inverse of what used to be asserted here, and the wire-level proof that
  // #99 landed. `src/ui/button.tsx` is owned by NO declared persona ('backend'
  // owns src/api/** and src/db/**), and it is inside the task's scope contract.
  // The old Rule 5 denied it; there is now no persona rule to deny it, because
  // PreToolUse carries no agent identity and so cannot attribute the edit to a
  // worker in the first place. The persona boundary is checked when the dispatch
  // returns (hooks/post-tool-use.mjs) — see test/regression/persona-boundary-inert.test.mjs.
  const scope = '---\nlane: feature\n---\n# Scope\n\n## Allowed paths\n- src/ui/button.tsx\n';
  const dir = workspace({ config: CONFIG, state: taskAt('impl-started'), scope });
  try {
    const r = runHook(replaceString('src/ui/button.tsx'), dir);
    assert.equal(r.decision, 'allow', 'no persona rule may gate this edit');
    assert.doesNotMatch(r.reason, /editableGlobs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Rule 6 (scope.md) is reachable AND prints the allowed paths', skipUnlessNode(24), () => {
  const scope = '---\nlane: feature\n---\n# Scope\n\n## Allowed paths\n- src/api/user.mjs\n';
  const dir = workspace({ config: CONFIG, state: taskAt('impl-started'), scope });
  try {
    const r = runHook(replaceString('src/api/order.mjs'), dir);
    assert.equal(r.decision, 'deny', 'Rule 6 must be reachable');
    assert.match(r.reason, /out of scope per scope\.md/);
    assert.match(r.reason, /src\/api\/user\.mjs/, 'prints allowedPaths rather than hiding them');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Rule 3 (plan-approved) denies WITH a lane-aware recovery action', skipUnlessNode(24), () => {
  const dir = workspace({ config: CONFIG, state: taskAt('plan-approved') });
  try {
    const r = runHook(replaceString(), dir);
    assert.equal(r.decision, 'deny');
    // HITL-2: on the feature lane the only legal move out of plan-approved is
    // draft-spec -> spec-draft. A generic "advance the gate" would send the
    // caller to impl-started, which the transition table forbids.
    assert.match(r.reason, /spec-draft/);
    assert.match(r.reason, /approve spec/);
    assert.doesNotMatch(
      r.reason,
      /^Gate guard: implementation not yet started \(gate: plan-approved\)\.$/,
      'must not be the old bare, action-free reason',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── tool_input path extraction, per VS Code's per-tool keys ──────────────────

test('extracts the target path from every VS Code tool_input key shape', skipUnlessNode(24), () => {
  const dir = workspace({
    config: CONFIG,
    state: taskAt('impl-started'),
    scope: SCOPE_ONE_FILE,
  });
  const outOfScope = 'src/ui/x.tsx'; // outside the scope contract -> Rule 6 denies, naming it
  /** @type {Array<[string, Record<string, unknown>]>} */
  const cases = [
    ['create_file', { filePath: outOfScope, content: 'x' }],
    ['insert_edit_into_file', { filePath: outOfScope, code: 'x', explanation: 'e' }],
    ['create_directory', { dirPath: outOfScope }],
    ['multi_replace_string_in_file', { replacements: [{ filePath: outOfScope, oldString: 'a', newString: 'b' }] }],
    ['edit_files', { files: [outOfScope] }],
    ['apply_patch', { input: `*** Update File: ${outOfScope}\n@@\n-a\n+b\n` }],
  ];
  try {
    for (const [tool_name, tool_input] of cases) {
      const r = runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input }, dir);
      assert.equal(r.decision, 'deny', `${tool_name}: expected a path-keyed deny`);
      assert.match(
        r.reason,
        /src\/ui\/x\.tsx/,
        `${tool_name}: the path must be extracted, or every path-keyed rule silently no-ops`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decoy `path` cannot mask the real target of a multi-file edit', skipUnlessNode(24), () => {
  // tool_input is model-controlled. If the legacy `path` key were consulted
  // before the real VS Code shapes, a payload carrying an in-scope decoy
  // alongside an out-of-scope real target would be vetted against the decoy and
  // the actual edit would land unchecked. `path` is therefore read LAST.
  const dir = workspace({
    config: CONFIG,
    state: taskAt('impl-started'),
    scope: SCOPE_ONE_FILE,
  });
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'multi_replace_string_in_file',
        tool_input: {
          path: 'src/api/user.mjs', // the one file scope.md allows — the decoy
          replacements: [
            { filePath: 'src/api/secrets/keys.mjs', oldString: 'a', newString: 'b' },
          ],
        },
      },
      dir,
    );
    assert.equal(r.decision, 'deny', 'the REAL target must be the one vetted');
    assert.match(r.reason, /secrets/, 'the deny must name the real target, not the decoy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard finds its config when cwd IS the workspace .devmate folder', skipUnlessNode(24), () => {
  // The captured production payload: cwd = <WSROOT>/.devmate, because monoroot
  // lists .devmate as workspaceFolders[0] and the host uses that as cwd. The
  // guard used to read every .devmate/ path relative to raw cwd, looked for
  // .devmate/.devmate/devmate.config.json, and concluded the workspace was
  // uninitialized (#76). resolveHookRoot must climb out.
  //
  // The observable is Rule 6: reaching it at all proves BOTH files one level up
  // were found — a missing config would have short-circuited at Rule 1 ("run
  // devmate init"), and missing state at Rule 2.
  const dir = workspace({
    config: CONFIG,
    state: taskAt('impl-started'),
    scope: SCOPE_ONE_FILE,
  });
  const devmateDir = join(dir, '.devmate');
  try {
    const r = runHook({ ...replaceString('src/ui/button.tsx'), cwd: devmateDir }, devmateDir);
    assert.equal(r.decision, 'deny', 'Rule 6 must fire — the files one level up must be found');
    assert.match(
      r.reason,
      /out of scope per scope\.md/,
      'the deny must be the scope verdict, not a bogus "run devmate init"',
    );
    assert.doesNotMatch(r.reason, /devmate init/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit whose target path cannot be determined fails CLOSED', skipUnlessNode(24), () => {
  const dir = workspace({ config: CONFIG, state: taskAt('impl-started') });
  try {
    // A known edit tool with no resolvable target: the path-keyed rules cannot
    // vet it, so it must not slip through to the default allow (Rule 3b).
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'replace_string_in_file', tool_input: {} },
      dir,
    );
    assert.equal(r.decision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
