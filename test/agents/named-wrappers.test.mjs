// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAgent } from '../../lib/agent-validator.mjs';
import { evaluateGuard } from '../../lib/gate-guard-core.mjs';
import { assertPersonaScope } from '../../lib/workflow/orchestrator.mjs';

/** @typedef {import('../../lib/types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../../lib/types.mjs').ConfigResult} ConfigResult */
/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').HookPayload} HookPayload */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/** Load the live devmate.config.json and return a ConfigResult. */
function loadLiveConfig() {
  const raw = readFileSync(resolve(ROOT, '.devmate', 'devmate.config.json'), 'utf8');
  /** @type {DevmateConfig} */
  const config = JSON.parse(raw);
  /** @type {ConfigResult} */
  const result = { ok: true, config };
  return result;
}

/** @returns {TaskState} */
function makeState() {
  return {
    taskId: 'wrappers-test',
    lane: /** @type {Lane} */ ('feature'),
    workflowGate: /** @type {WorkflowGate} */ ('impl-started'),
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
  };
}

// ---- File existence + validator schema ----

test('named-wrappers - agents/backend.agent.md exists and passes validate-agents.mjs', async () => {
  const filePath = resolve(ROOT, 'agents/backend.agent.md');
  assert.equal(existsSync(filePath), true, 'agents/backend.agent.md must exist');
  const result = await validateAgent(filePath);
  assert.equal(result.ok, true, `backend wrapper should pass validation; violations: ${JSON.stringify(result.violations)}`);
});

test('named-wrappers - agents/frontend.agent.md exists and passes validate-agents.mjs', async () => {
  const filePath = resolve(ROOT, 'agents/frontend.agent.md');
  assert.equal(existsSync(filePath), true, 'agents/frontend.agent.md must exist');
  const result = await validateAgent(filePath);
  assert.equal(result.ok, true, `frontend wrapper should pass validation; violations: ${JSON.stringify(result.violations)}`);
});

test('named-wrappers - agents/editor.agent.md exists and passes validate-agents.mjs', async () => {
  const filePath = resolve(ROOT, 'agents/editor.agent.md');
  assert.equal(existsSync(filePath), true, 'agents/editor.agent.md must exist');
  const result = await validateAgent(filePath);
  assert.equal(result.ok, true, `editor wrapper should pass validation; violations: ${JSON.stringify(result.violations)}`);
});

// ---- Capability registry ----

test('named-wrappers - all three appear in docs/AGENTS.md', () => {
  const docs = readFileSync(resolve(ROOT, 'docs/AGENTS.md'), 'utf8');
  // v2 roster table uses backtick format: | `backend` |
  assert.ok(docs.includes('| `backend` |'), 'docs/AGENTS.md should list backend');
  assert.ok(docs.includes('| `frontend` |'), 'docs/AGENTS.md should list frontend');
  assert.ok(docs.includes('| `editor` |'), 'docs/AGENTS.md should list editor');
});

// ---- The wrapper's persona boundary is enforced at COMPLETION, not at the edit ----
//
// These three tests used to call `evaluateGuard(payload, makeState('backend'), cfg, 'backend')`
// and assert a deny — passing an `activePersona` that production never sets, into
// a rule (5) that production therefore never ran. They tested a boundary that did
// not exist in any session, which is precisely the class of green-CI-over-inert-code
// this repo keeps finding (#99). Rule 5 is gone; the per-worker boundary is
// `assertPersonaScope`, applied to the `changedFiles` a dispatch reports when it
// completes. Same config, same globs, same verdict — at a point where the persona
// is actually knowable.

test('named-wrappers - backend persona is denied a frontend-owned file (completion-time)', () => {
  const cfg = loadLiveConfig();
  const result = assertPersonaScope('backend', ['src/ui/Button.tsx'], cfg.config);
  assert.equal(result.ok, false, 'backend must not own a frontend file');
  assert.deepEqual(result.violations, ['src/ui/Button.tsx']);
});

test('named-wrappers - frontend persona is denied a backend-owned file (completion-time)', () => {
  const cfg = loadLiveConfig();
  const result = assertPersonaScope(
    'frontend',
    ['src/main/java/com/example/Service.java'],
    cfg.config,
  );
  assert.equal(result.ok, false, 'frontend must not own a backend file');
  assert.deepEqual(result.violations, ['src/main/java/com/example/Service.java']);
});

test('named-wrappers - editor persona is denied a src/main file (completion-time)', () => {
  const cfg = loadLiveConfig();
  const result = assertPersonaScope(
    'editor',
    ['src/main/java/com/example/Service.java'],
    cfg.config,
  );
  assert.equal(result.ok, false, 'editor must not own a backend file');
  assert.deepEqual(result.violations, ['src/main/java/com/example/Service.java']);
});

// ---- At the edit itself, scope.md is what bounds a @fullstack worker ----

test('named-wrappers - fullstack is DENIED an edit without a scope contract', () => {
  // This asserted `allow` — "fullstack persona can still write any file (no
  // regression)" — and it passed, at gate impl-started, with no scope contract
  // of any kind. That WAS the defect (#92): Rule 5 was skipped (nothing pinned a
  // persona), and Rule 6 used to skip too whenever scope.md was absent — which it
  // always was, because no lane could write one. So an @fullstack worker could
  // edit any path in the repository, and a green test said that was correct.
  const cfg = loadLiveConfig();
  /** @type {HookPayload} */
  const payload = { tool_name: 'write_file', path: 'src/main/java/com/example/Service.java' };
  const result = evaluateGuard(payload, makeState(), cfg);
  assert.equal(result.decision, 'deny', `expected deny, got ${result.decision}: ${result.reason ?? ''}`);
  assert.match(String(result.reason), /scope contract/i);
});

test('named-wrappers - fullstack CAN write a path inside the scope contract', () => {
  // The other half: the boundary bounds, it does not brick. A path the lane's
  // scope.md permits is allowed.
  const cfg = loadLiveConfig();
  /** @type {HookPayload} */
  const payload = { tool_name: 'write_file', path: 'src/main/java/com/example/Service.java' };
  const result = evaluateGuard(payload, makeState(), cfg, {
    scope: {
      lane: /** @type {Lane} */ ('feature'),
      allowedPaths: ['src/main/java/com/example/Service.java'],
      allowedGlobs: [],
    },
  });
  assert.equal(result.decision, 'allow', `expected allow, got ${result.decision}: ${result.reason ?? ''}`);
});
