// @ts-check
/**
 * #94 — the reported bug, driven end-to-end through the real hook.
 *
 * A live PreToolUse deny on `session_store_sql`: a tool that edits nothing, from
 * an MCP server, blocked purely for being unfamiliar — and told to fix it by
 * editing `lib/gate-guard-core.mjs`, devmate's own library source, which a plugin
 * consumer cannot touch. Every hook fixture in the suite used a first-party VS
 * Code tool name (`read_file`, `runSubagent`, `replace_string_in_file`,
 * `create_file`, `run_in_terminal`), so the fail-closed branch was only ever
 * exercised with hypotheticals that SHOULD be denied. The traffic that actually
 * breaks was never sampled. It is sampled here.
 *
 * The other half of the contract is asserted alongside it: the same unrecognized
 * tool, now naming a source file, is still denied — under `path`, under `uri`, or
 * behind a `file://` scheme. Classification moved from the tool's NAME to the
 * PATH it names, which is strictly stronger, not weaker.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

const CONFIG = {
  schemaVersion: 1,
  personas: [
    { persona: 'backend', editableGlobs: ['lib/**', 'src/api/**'], offLimitsGlobs: [] },
  ],
};

const TASK = {
  taskId: 'T1',
  lane: 'feature',
  workflowGate: 'impl-started',
  currentStep: 0,
  artifactHashes: {},
  preImplStash: null,
  budget: 10,
  tddGuard: { testFileWritten: true, consecutiveNonTestWrites: 0, overrideGranted: false },
  schemaVersion: 1,
};

/**
 * A workspace with a config and a task at impl-started — the state in which the
 * reported deny happened.
 * @returns {string}
 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gg-mcp-'));
  const stateDir = join(dir, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(dir, '.devmate', 'devmate.config.json'), JSON.stringify(CONFIG), 'utf8');
  writeFileSync(join(stateDir, 'task.json'), JSON.stringify(TASK), 'utf8');
  return dir;
}

/**
 * Run the real hook entrypoint as a subprocess, exactly as VS Code does.
 * @param {Record<string, unknown>} payload
 * @param {string} cwd
 * @returns {{ decision: string|undefined, reason: string }}
 */
function runHook(payload, cwd) {
  const r = spawnSync('node', [SCRIPT], {
    input: JSON.stringify({ cwd, ...payload }),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  const parsed = JSON.parse((r.stdout ?? '').trim());
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PreToolUse');
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason ?? '',
  };
}

test('session_store_sql — an MCP tool naming no file — is ALLOWED', skipUnlessNode(24), () => {
  const dir = workspace();
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'session_store_sql',
        tool_input: { query: 'SELECT * FROM sessions WHERE id = ?', params: ['T1'] },
      },
      dir,
    );
    assert.equal(
      r.decision,
      'allow',
      'an MCP tool that names no protected path has nothing for any rule to check',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unfamiliar read-only tool is not denied for being unfamiliar', skipUnlessNode(24), () => {
  const dir = workspace();
  try {
    for (const [tool_name, tool_input] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
      ['mcp_memory_search', { query: 'auth module', limit: 5 }],
      ['jira_get_issue', { issueKey: 'ENG-1234' }],
      ['browser_navigate', { url: 'https://example.com/docs' }],
    ])) {
      const r = runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input }, dir);
      assert.equal(r.decision, 'allow', `${tool_name} must not be gated`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognized tool naming a source file is still DENIED', skipUnlessNode(24), () => {
  const dir = workspace();
  /** @type {Array<[string, Record<string, unknown>]>} */
  const cases = [
    ['under `path`', { path: 'lib/a.mjs' }],
    ['under `uri`', { uri: 'lib/a.mjs' }],
    ['behind a file:// scheme', { uri: 'file:///c:/dev/lib/a.mjs' }],
    ['nested in an array', { edits: [{ target: 'lib/a.mjs', text: 'x' }] }],
  ];
  try {
    for (const [label, tool_input] of cases) {
      const r = runHook(
        { hook_event_name: 'PreToolUse', tool_name: 'mcp_editor_write', tool_input },
        dir,
      );
      assert.equal(r.decision, 'deny', `${label}: a named source path must be gated`);
      assert.match(r.reason, /lib\/a\.mjs/, `${label}: the deny must name the path`);
      // The deny must be actionable by the caller, not by devmate's maintainers.
      assert.doesNotMatch(r.reason, /gate-guard-core\.mjs/, `${label}: unactionable reason`);
      assert.match(r.reason, /@fullstack/, `${label}: names the route the change should take`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognized tool naming a session artifact is DENIED', skipUnlessNode(24), () => {
  // Protected by LOCATION, not extension (#93): an MCP tool cannot rewrite the
  // human-approved spec just because devmate has never heard of it.
  const dir = workspace();
  try {
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp_doc_writer',
        tool_input: { destination: '.devmate/session/T1/spec.md', body: 'approved!' },
      },
      dir,
    );
    assert.equal(r.decision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
