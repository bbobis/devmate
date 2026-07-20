// @ts-check
/**
 * Regression: gate-guard denied EVERY tool call whose hook payload exceeded
 * 4096 bytes.
 *
 * `readStdinSync` read stdin in 4096-byte passes into ONE reused buffer and
 * pushed `buf.slice(0, n)` — a view over that buffer, not a copy. A payload
 * that took two or more reads therefore concatenated to the last read's bytes
 * repeated: the right LENGTH, garbage CONTENT. `JSON.parse` threw, and the
 * fail-closed handler emitted `permissionDecision: "deny"` with reason
 * "malformed JSON in hook payload".
 *
 * In the field this read as a lane/gate block on exactly the dispatches that
 * carry long prompts (tech-design, planner), while short ones (discovery) went
 * through — which is why it was mistaken for a prompt-content problem.
 *
 * The existing suites all pass small synthetic payloads, so none of them cross
 * the 4096-byte line. These tests do, and they fail on the pre-fix code.
 */
import { skipUnlessNode } from '../../lib/test-utils/node-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withMarkedSession } from '../../lib/test-utils/hook-session.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gate-guard.mjs');

/** The reused-buffer size in readStdinSync — the boundary this test straddles. */
const READ_BUFFER_BYTES = 4096;

const TASK_ID = 'large-payload-1';

/**
 * A workspace the guard is happy with, so the only thing left that can change
 * the verdict is the payload's SIZE — which is what these tests are about.
 *
 * #92: the guard now fails closed at impl-started when the task has no edit
 * boundary, so the workspace carries a scope.md admitting the file the payload
 * names. (The test used to point `cwd` at the repo itself and lean on whatever
 * state happened to be committed there — a benign read was "allowed" only
 * because an absent scope.md used to mean "anything goes".)
 * @returns {string}  Absolute workspace root.
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'guard-large-payload-'));
  const stateDir = join(root, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['**'] }],
    }),
    'utf8',
  );
  writeFileSync(
    join(stateDir, 'task.json'),
    JSON.stringify({
      taskId: TASK_ID,
      lane: 'feature',
      workflowGate: 'impl-started',
      artifactHashes: { spec: '.devmate/session/spec.md', specDigest: 'abc123' },
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  const sessionDir = join(root, '.devmate', 'session', TASK_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'scope.md'),
    ['---', 'lane: feature', '---', '# Scope', '', '## Allowed paths', '- README.md', '', '## Allowed globs', ''].join('\n'),
    'utf8',
  );
  return root;
}

/**
 * Run the real hook script with a payload of at least `bytes`, padded through a
 * field a benign tool would actually carry (a long prompt).
 * @param {number} bytes  Minimum total payload size in bytes.
 * @param {string} root   Workspace root the payload points the guard at.
 * @returns {{ decision: string, reason: string }}
 */
function runGuardWithPayloadOfAtLeast(bytes, root) {
  const payload = {
    tool_name: 'Read',
    cwd: root,
    tool_input: { filePath: 'README.md', prompt: 'x'.repeat(bytes) },
  };
  // Marked so the oversized payload traverses the full parse+eval path, not the
  // inert session-scope bail-out (this test is about buffer parsing, not scope).
  return withMarkedSession(payload, (marked) => {
    const input = JSON.stringify(marked);
    assert.ok(input.length > bytes, 'test payload must exceed the requested size');

    const result = spawnSync('node', [SCRIPT], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `hook must exit 0, got ${result.status}: ${result.stderr}`);

    const parsed = JSON.parse((result.stdout ?? '').trim());
    const hso = parsed.hookSpecificOutput ?? {};
    return {
      decision: String(hso.permissionDecision ?? ''),
      reason: String(hso.permissionDecisionReason ?? ''),
    };
  });
}

test(
  'gate-guard.mjs - a payload larger than the read buffer parses (no malformed-JSON deny)',
  skipUnlessNode(24),
  () => {
    const root = makeWorkspace();
    try {
      const { decision, reason } = runGuardWithPayloadOfAtLeast(READ_BUFFER_BYTES * 4, root);
      assert.doesNotMatch(
        reason,
        /malformed JSON/i,
        'a well-formed multi-read payload must not be seen as malformed — stdin is being read into a reused buffer',
      );
      assert.equal(decision, 'allow', 'a benign Read must be allowed regardless of payload size');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'gate-guard.mjs - the verdict does not change across the read-buffer boundary',
  skipUnlessNode(24),
  () => {
    const root = makeWorkspace();
    try {
      const under = runGuardWithPayloadOfAtLeast(READ_BUFFER_BYTES / 4, root);
      const over = runGuardWithPayloadOfAtLeast(READ_BUFFER_BYTES * 50, root);
      assert.equal(
        over.decision,
        under.decision,
        `payload size must not decide the verdict (under: ${under.decision}, over: ${over.decision} "${over.reason}")`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
