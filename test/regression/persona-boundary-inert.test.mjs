// @ts-check
/**
 * Regression: BOTH persona boundaries were inert, and each one's docstring
 * pointed at the other as the layer that really enforced (#99).
 *
 *   Rule 5 (gate-guard, edit-time) — skipped on every call: `resolveActivePersona`
 *     returns '' unless `state.activePersona` is set, and nothing sets it. Its
 *     comment rested the guarantee on "the completion-time persona-scope check".
 *   Completion-time check (hooks/post-tool-use.mjs) — read the persona from
 *     `tool_input.persona`. The CAPTURED PostToolUse payload
 *     (test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json) shows
 *     `tool_input` arrives as the literal STRING "...", so `maybePersona` was
 *     `undefined` on every real dispatch and the whole block — persona scope AND
 *     the TDD tripwire behind it — was skipped. Its docs, in turn, cited Rule 5
 *     as the edit-time boundary.
 *
 * So a `frontend` worker could edit a backend file, at every gate, with both
 * "enforced" layers green in CI — because every test fed the hook a hand-authored
 * payload carrying a `tool_input` object no host sends.
 *
 * These tests drive the REAL PostToolUse hook as a subprocess and feed it the
 * CAPTURED wire shape. They fail on the pre-fix code: the hook wrote a plain
 * fact-line and never blocked.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { validateHookOutput } from '../../lib/hooks/output-schema.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'post-tool-use.mjs');

const TASK_ID = 'persona-regression-1';

/**
 * A workspace at `impl-started` with two personas that partition the tree, and a
 * `personaScope` mode.
 * `personas` is the consumer's own list — the default `backend`/`frontend`
 * names in one case, arbitrary consumer-declared names (`api`/`web`, which have
 * NO wrapper agent and so can never appear on the wire as an `agent_type`) in
 * the other.
 * @param {readonly Record<string, unknown>[]} personas
 * @param {string} [mode]  personaScope mode; omitted = the shipped default (warn).
 * @returns {string} workspace root
 */
function workspace(personas, mode = 'block') {
  const root = mkdtempSync(join(tmpdir(), 'devmate-persona-reg-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });

  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({ schemaVersion: 1, personaScope: mode, personas }),
    'utf8',
  );

  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: TASK_ID,
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 1,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );

  return root;
}

/**
 * A `runSubagent` PostToolUse payload in the shape the host REALLY sends, per
 * the captured fixture: `tool_input` is the elided string "...", and
 * `tool_response` is the agent's final chat text — prose followed by its JSON
 * contract. The persona is knowable from exactly one place: the contract the
 * worker itself returned.
 * @param {string} root
 * @param {Record<string, unknown>} contract  The worker's returned JSON.
 * @returns {string} JSON payload for stdin
 */
function capturedShapePayload(root, contract) {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'fd634936-8166-4295-a74f-2a397c9c5226',
    tool_name: 'runSubagent',
    tool_input: '...',
    tool_response:
      'Implemented the slice under TDD; tests are green.\n\n' + JSON.stringify(contract),
    tool_use_id: 'toolu_bdrk_01UqQ3JGUVF9NsqCmRoSWWkW__vscode-1783942732395',
    cwd: root,
  });
}

/**
 * Run the real PostToolUse hook against a payload and return its stdout, parsed
 * the way the HOST parses it: a single JSON document, on exit 0. Anything else —
 * a non-zero exit, prose before the JSON, two documents — and VS Code drops the
 * output entirely, so a test that tolerated it could go green on a verdict the
 * host would never see. That is the failure this suite exists to catch, and it
 * must not be able to hide inside the suite's own helper.
 * @param {string} payload
 * @returns {Record<string, unknown>}
 */
function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook must exit 0 for the host to read stdout; stderr: ${res.stderr}`);
  const out = String(res.stdout).trim();
  assert.doesNotMatch(out, /\n/, `stdout must be ONE JSON document, got:\n${out}`);
  return JSON.parse(out);
}

/** The default persona pair — the names that DO have wrapper agents. */
const DEFAULT_PERSONAS = [
  { persona: 'backend', editableGlobs: ['lib/**', 'src/**'], offLimitsGlobs: ['src/ui/**'] },
  { persona: 'frontend', editableGlobs: ['src/ui/**'] },
];

/** Consumer-declared personas with no wrapper agent and no PERSONA_MAP entry. */
const CONSUMER_PERSONAS = [
  { persona: 'api', editableGlobs: ['services/**'] },
  { persona: 'web', editableGlobs: ['apps/web/**'] },
];

test('regression: a frontend dispatch that edits a backend file is denied on the captured wire shape', skipUnlessNode(24), () => {
  const root = workspace(DEFAULT_PERSONAS);
  try {
    // The exact case Rule 5 existed for, and the one a task-wide scope.md cannot
    // catch: both files are legitimately in the FEATURE's scope; only the
    // WORKER's territory separates them.
    const out = runHook(
      capturedShapePayload(root, {
        agentName: 'fullstack',
        persona: 'frontend',
        status: 'ok',
        payload: {
          verification: 'unit tests green',
          summary: 'wired the button to the new endpoint',
          changedFiles: ['src/ui/button.mjs', 'lib/orders/service.mjs'],
        },
      }),
    );
    assert.equal(out['decision'], 'block', `expected a block, got: ${JSON.stringify(out)}`);
    assert.equal(out['reason'], 'persona_scope_violation');
    assert.deepEqual(out['violations'], ['lib/orders/service.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regression: an in-territory dispatch is not blocked', skipUnlessNode(24), () => {
  const root = workspace(DEFAULT_PERSONAS);
  try {
    const out = runHook(
      capturedShapePayload(root, {
        agentName: 'fullstack',
        persona: 'frontend',
        status: 'ok',
        payload: {
          verification: 'unit tests green',
          summary: 'button',
          changedFiles: ['src/ui/button.mjs', 'src/ui/button.test.mjs'],
        },
      }),
    );
    assert.notEqual(out['decision'], 'block', `expected no block, got: ${JSON.stringify(out)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regression: consumer-declared personas with no wrapper agent are enforced identically', skipUnlessNode(24), () => {
  // The hard case any wrapper-name-derived design fails: `api`/`web` have no
  // wrapper agent, so they never appear as an `agent_type` on any hook event.
  // The persona rides the worker's OWN return contract, so the name it was
  // dispatched with is the name that is checked — whatever the consumer calls it.
  const root = workspace(CONSUMER_PERSONAS);
  try {
    const out = runHook(
      capturedShapePayload(root, {
        agentName: 'fullstack',
        persona: 'web',
        status: 'ok',
        payload: {
          verification: 'green',
          summary: 'checkout page',
          changedFiles: ['apps/web/checkout.tsx', 'services/orders/handler.ts'],
        },
      }),
    );
    assert.equal(out['decision'], 'block', `expected a block, got: ${JSON.stringify(out)}`);
    assert.deepEqual(out['violations'], ['services/orders/handler.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regression: the DEFAULT warn mode surfaces the breach without halting the dispatch', skipUnlessNode(24), () => {
  // `warn` is the shipped default, and docs/gate-guard.md has always said it
  // records and surfaces without halting. The code emitted a hard block for both
  // modes — invisible only because the check never fired. Switching the check on
  // unchanged would have flipped every default-config consumer from "warn" to
  // "halt" in one release, on a rule they had never seen enforce anything.
  const root = workspace(DEFAULT_PERSONAS, 'warn');
  try {
    const out = runHook(
      capturedShapePayload(root, {
        agentName: 'fullstack',
        persona: 'frontend',
        status: 'ok',
        payload: {
          verification: 'green',
          summary: 'reached into the backend',
          changedFiles: ['lib/orders/service.mjs'],
        },
      }),
    );
    assert.notEqual(out['decision'], 'block', 'warn must not halt the dispatch');
    // Reported under devmate's OWN key, never the host's `reason` — the host reads
    // `reason` only alongside decision:"block", so emitting it here would be a key
    // that means something in one mode and nothing in the other.
    assert.equal(out['devmateReason'], 'persona_scope_violation', 'the breach is still reported');
    assert.equal(out['reason'], undefined, 'a host key must not be emitted where the host ignores it');
    // …and it reaches the model, on the channel PostToolUse documents for context.
    const hookOut = /** @type {Record<string, unknown>} */ (out['hookSpecificOutput']);
    assert.equal(hookOut['hookEventName'], 'PostToolUse');
    assert.match(String(hookOut['additionalContext']), /lib\/orders\/service\.mjs/);
    // And the whole envelope is legal on this event, per devmate's own validator —
    // which is what would have caught a `reason` emitted with no `decision: "block"`.
    const verdict = validateHookOutput('PostToolUse', JSON.stringify(out), 0);
    assert.deepEqual(verdict.errors, [], 'warn output must satisfy the PostToolUse output contract');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regression: a fullstack result that declares no persona is a contract violation, not a free pass', skipUnlessNode(24), () => {
  // Fail closed. If a missing `persona` silently skipped the check, the boundary
  // would be optional — a worker could opt out of its own territory by omitting
  // one field, which is precisely how this layer spent its life inert.
  const root = workspace(DEFAULT_PERSONAS);
  try {
    const out = runHook(
      capturedShapePayload(root, {
        agentName: 'fullstack',
        status: 'ok',
        payload: {
          verification: 'green',
          summary: 'no persona declared',
          changedFiles: ['src/ui/button.mjs'],
        },
      }),
    );
    assert.equal(out['decision'], 'block', `expected a block, got: ${JSON.stringify(out)}`);
    assert.equal(out['reason'], 'persona_missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
