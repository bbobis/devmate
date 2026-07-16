// @ts-check
/**
 * E9-12: default-deny source-edit detection — one case per bypass vector the
 * old four-tool allowlist let through, plus benign-read regressions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSourceEditTool,
  isUnscopeableSourceEdit,
  evaluateGuard,
} from '../../lib/gate-guard-core.mjs';

/** @typedef {import('../../lib/types.mjs').HookPayload} HookPayload */

/**
 * Evaluate a shell command against a task state at the given workflow gate. The
 * tddGuard is pre-satisfied (testFileWritten) so any denial at impl-started is
 * attributable to the terminal-as-editor rule, not the TDD pre-condition.
 * @param {string} command
 * @param {string} gate
 * @returns {import('../../lib/types.mjs').GuardDecision}
 */
function guardAtGate(command, gate) {
  /** @type {HookPayload} */
  const payload = { tool_name: 'run_in_terminal', command };
  const state = /** @type {any} */ ({
    taskId: 't-dd',
    lane: 'feature',
    workflowGate: gate,
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
    schemaVersion: 1,
  });
  const configResult = /** @type {any} */ ({ ok: true, config: { schemaVersion: 1, personas: [] } });
  return evaluateGuard(payload, state, configResult);
}

/**
 * Evaluate a shell command against a pre-impl-started (plan-approved) state.
 * @param {string} command
 * @returns {import('../../lib/types.mjs').GuardDecision}
 */
function guardPreImpl(command) {
  return guardAtGate(command, 'plan-approved');
}

const BYPASS_VECTORS = [
  ['sed -i', "sed -i 's/foo/bar/' lib/app.mjs"],
  ['perl -i', "perl -i -pe 's/foo/bar/' lib/app.mjs"],
  ['python -c', 'python -c "open(\'lib/app.mjs\',\'w\').write(\'x\')"'],
  ['python3 -c', 'python3 -c "open(\'lib/app.mjs\',\'w\').write(\'x\')"'],
  ['node -e', 'node -e "require(\'fs\').writeFileSync(\'lib/app.mjs\',\'x\')"'],
  ['git apply', 'git apply changes.patch'],
  ['patch', 'patch lib/app.mjs < fix.diff'],
  ['tee -a', 'echo hack | tee -a lib/app.mjs'],
  ['> redirect', 'printf "x" > lib/app.mjs'],
  ['>> redirect', 'somecmd >> lib/app.js'],
  ['PowerShell Set-Content', "Set-Content -Path lib/app.mjs -Value 'x'"],
  ['PowerShell Out-File', "'x' | Out-File lib/app.mjs"],
  ['PowerShell Add-Content', "Add-Content lib/app.mjs 'x'"],
  ['mv onto source', 'mv /tmp/evil.mjs lib/app.mjs'],
  ['cp onto source', 'cp /tmp/evil.mjs lib/app.mjs'],
];

for (const [name, command] of BYPASS_VECTORS) {
  test(`denies ${name} pre-impl-started`, () => {
    assert.equal(isSourceEditTool('run_in_terminal', command), true, `classified as edit: ${command}`);
    const decision = guardPreImpl(command);
    assert.equal(decision.decision, 'deny', `denied pre-impl: ${command}`);
  });
}

// Regression: the terminal-as-editor bypass at impl-started. Before Rule 3b,
// every one of these fell through to the default allow once the gate advanced
// past plan-approved (the persona/scope/TDD rules all key on payload.path, and
// shell commands carry `command`, not `path`). The orchestrator has no edit
// tool, so this was its route to editing source inline on follow-up turns.
for (const [name, command] of BYPASS_VECTORS) {
  test(`denies ${name} at impl-started (terminal-as-editor bypass closed)`, () => {
    const decision = guardAtGate(command, 'impl-started');
    assert.equal(decision.decision, 'deny', `denied at impl-started: ${command}`);
    assert.match(decision.reason ?? '', /terminal|@fullstack/i);
  });
  test(`denies ${name} at verification-passed`, () => {
    assert.equal(guardAtGate(command, 'verification-passed').decision, 'deny');
  });
}

test('benign orchestration shell commands stay allowed at impl-started', () => {
  // Non-edit commands the orchestrator legitimately runs must not be caught.
  assert.equal(guardAtGate('npm run verify', 'impl-started').decision, 'allow');
  assert.equal(guardAtGate('git commit -m "wip"', 'impl-started').decision, 'allow');
  assert.equal(guardAtGate('git add -A', 'impl-started').decision, 'allow');
  assert.equal(
    guardAtGate('node scripts/gatectl.mjs workflow set start-impl', 'impl-started').decision,
    'allow',
  );
  assert.equal(guardAtGate('cat lib/app.mjs', 'impl-started').decision, 'allow');
});

// ---- isUnscopeableSourceEdit ----

test('isUnscopeableSourceEdit - shell source write with no path is unscopeable', () => {
  assert.equal(
    isUnscopeableSourceEdit({ tool_name: 'run_in_terminal', command: 'sed -i s/a/b/ lib/app.mjs' }),
    true,
  );
});

test('isUnscopeableSourceEdit - benign shell command is not an edit', () => {
  assert.equal(isUnscopeableSourceEdit({ tool_name: 'run_in_terminal', command: 'npm run verify' }), false);
});

test('isUnscopeableSourceEdit - path-based edit tool carries a path (scopeable)', () => {
  // A normal editor call has a path, so it is left to the persona/scope/TDD rules.
  assert.equal(
    isUnscopeableSourceEdit({ tool_name: 'write_file', path: 'lib/app.mjs' }),
    false,
  );
});

test('isUnscopeableSourceEdit - non-edit tool is never unscopeable', () => {
  assert.equal(isUnscopeableSourceEdit({ tool_name: 'read_file' }), false);
});

test('tee (non-append) is classified as an edit', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'echo x | tee lib/app.mjs'), true);
});

// #128: the source-edit classifier must not misread a `>` that lives inside a
// quoted argument as a redirect operator, and `tee` is a write only when its
// actual target names a source path — not for every capture-to-log. All four
// cases produced (or must keep producing) the exact denial that strands a user
// mid-verification with no working escape, since the command was never an edit.
test('#128 - a `>` inside a quoted arg is not a redirect (git commit)', () => {
  const command = 'git commit -m "renamed > foo.mjs"';
  assert.equal(isSourceEditTool('run_in_terminal', command), false);
  // The real symptom: this must not be denied while verifying.
  assert.equal(guardAtGate(command, 'verification-passed').decision, 'allow');
});

test('#128 - a quoted `> path.ext` grep pattern is not a redirect', () => {
  const command = 'grep "> some/path.mjs" README.md';
  assert.equal(isSourceEditTool('run_in_terminal', command), false);
  assert.equal(guardAtGate(command, 'impl-started').decision, 'allow');
});

test('#128 - tee onto a non-source log is not a source write', () => {
  const command = 'npm test 2>&1 | tee test-results.log';
  assert.equal(isSourceEditTool('run_in_terminal', command), false);
  assert.equal(guardAtGate(command, 'verification-passed').decision, 'allow');
});

test('#128 - tee onto a real source path is STILL a source write (fail-closed intact)', () => {
  const command = 'npm test 2>&1 | tee lib/gate-guard-core.mjs';
  assert.equal(isSourceEditTool('run_in_terminal', command), true);
  assert.equal(guardAtGate(command, 'verification-passed').decision, 'deny');
});

// The narrowing must not reopen the deliberate holes: a genuinely unquoted
// redirect onto a source path or session artifact is still a write.
test('#128 - an actual unquoted redirect onto source is still caught', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'printf "x" > lib/app.mjs'), true);
  assert.equal(isSourceEditTool('run_in_terminal', 'somecmd >> lib/app.js'), true);
  assert.equal(isSourceEditTool('run_in_terminal', 'echo "# forged" > .devmate/session/spec.md'), true);
});

test('allows cat/grep/ls read', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'cat lib/app.mjs'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'grep -n "foo" lib/app.mjs'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'ls -la lib/'), false);
  assert.equal(guardPreImpl('cat lib/app.mjs').decision, 'allow');
});

test('allows node --test', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'node --test test/lib/app.test.mjs'), false);
  assert.equal(guardPreImpl('node --test').decision, 'allow');
});

test('allows plain node script execution and npm/git reads', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'node scripts/view-trace.mjs'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'npm run lint'), false);
  assert.equal(isSourceEditTool('run_in_terminal', 'git diff lib/app.mjs'), false);
});

test('classifies the real VS Code edit tools as edits', () => {
  assert.equal(isSourceEditTool('replace_string_in_file', undefined), true);
  assert.equal(isSourceEditTool('create_file', undefined), true);
  assert.equal(isSourceEditTool('insert_edit_into_file', undefined), true);
  assert.equal(isSourceEditTool('multi_replace_string_in_file', undefined), true);
  assert.equal(isSourceEditTool('apply_patch', undefined), true);
});

test('unclassifiable shell touching source path is denied pre-impl', () => {
  const command = 'mystery-tool --input lib/app.mjs';
  assert.equal(isSourceEditTool('run_in_terminal', command), true, 'fail closed on unknown command');
  assert.equal(guardPreImpl(command).decision, 'deny');
});

test('unclassifiable shell with no source token stays allowed', () => {
  assert.equal(isSourceEditTool('run_in_terminal', 'mystery-tool --flag value'), false);
});

// The anti-drift guarantee (#74), preserved by #94 in its stronger form: a call
// that NAMES a source file is gated, whatever the tool is called. A renamed
// `replace_string_in_file` still carries `filePath`, so the guarantee no longer
// depends on devmate having enumerated the tool's name in time.
test('an unrecognized tool NAMING a source file is a source edit', () => {
  assert.equal(isSourceEditTool('new_write_tool', undefined, ['lib/app.mjs']), true);
  assert.equal(isSourceEditTool('some_future_copilot_tool', undefined, ['src/ui/x.tsx']), true);
  // Session artifacts are protected by location, not extension (#93).
  assert.equal(
    isSourceEditTool('some_mcp_tool', undefined, ['.devmate/session/T1/spec.md']),
    true,
  );
});

// The #94 false positive: name-membership alone denied every MCP and
// extension-contributed tool on first contact. A tool that names no protected
// path has nothing for ANY rule in evaluateGuard to check — all of them key on a
// file path — so denying it protected nothing.
test('an unrecognized tool naming NO source path is not a source edit', () => {
  assert.equal(isSourceEditTool('session_store_sql', undefined, []), false);
  assert.equal(isSourceEditTool('some_mcp_tool', undefined, ['https://example.com/x']), false);
  assert.equal(isSourceEditTool('', undefined, []), false);
});

// The evals contract: evals/trajectory/scorer.mjs classifies off a trace
// `actionType` and has no tool_input to offer. A caller that inspected nothing
// must not be handed an allow.
test('an unrecognized tool with NO namedPaths at all still fails closed', () => {
  assert.equal(isSourceEditTool('new_write_tool', undefined), true);
  assert.equal(isSourceEditTool('some_future_copilot_tool', undefined), true);
  assert.equal(isSourceEditTool('', undefined), true);
});

// A known editor is an edit whatever its input says — an unparseable tool_input
// must not become an escape hatch for the tools devmate DOES know write source.
test('a known edit tool is an edit even when it names no path', () => {
  assert.equal(isSourceEditTool('replace_string_in_file', undefined, []), true);
  assert.equal(isSourceEditTool('apply_patch', undefined, []), true);
  assert.equal(isSourceEditTool('create_file', undefined, []), true);
});

test('a known read tool is never an edit, even when it names a source file', () => {
  assert.equal(isSourceEditTool('read_file', undefined, ['lib/app.mjs']), false);
  assert.equal(isSourceEditTool('runSubagent', undefined, ['lib/app.mjs']), false);
});

test('known read-only and control-plane tools are not edits', () => {
  for (const t of ['read_file', 'grep_search', 'semantic_search', 'list_dir', 'file_search']) {
    assert.equal(isSourceEditTool(t, undefined), false, `${t} must not be gated as an edit`);
  }
  // runSubagent must never be an edit: it falls through to evaluateGuard, so
  // gating it would make Rule 2 deny every dispatch before a task exists —
  // deadlocking the orchestrator, since dispatch is how a task starts.
  assert.equal(isSourceEditTool('runSubagent', undefined), false);
});
