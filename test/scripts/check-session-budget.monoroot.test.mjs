// @ts-check
/**
 * Regression: the PostToolUse budget guard must find task.json in the monoroot
 * worktree layout.
 *
 * hooks.json registers `check-session-budget.mjs` with NO arguments, so it fell
 * back to the bare RELATIVE string `.devmate/state/task.json` — resolved against
 * the hook process's cwd. In the monoroot layout (`.devmate/` at the workspace
 * root, sibling repo subfolders each with their own `.git`) the hook's cwd lands
 * inside a repo subfolder, where no `.devmate/` exists. So the guard reported
 * `[BUDGET:unclassified]` on every single tool call while a perfectly valid
 * OutputContract sat one directory up, and `measureSession` measured nothing.
 *
 * This spawns the hook as a REAL process — the only way to exercise the cwd and
 * stdin handling that the bug lived in. Calling main() with an explicit path
 * argument (as the other suites do) bypasses the defect entirely.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { markSessionForFile } from '../../lib/test-utils/hook-session.mjs';

// Enforcement is session-scoped (lib/hooks/session-marker.mjs): these tests
// exercise handlers inside an ACTIVE devmate session, so mark one for the
// whole file (cleared via an after() hook by the helper) and stamp its id into
// each payload.
const TEST_SESSION_ID = markSessionForFile('devmate-test-budget-monoroot');

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-session-budget.mjs');

/**
 * Build the monoroot shape and seed a classified task at the workspace root:
 *   <root>/.devmate/state/task.json   (with an OutputContract)
 *   <root>/repo-a/.git/
 *   <root>/repo-b/.git/
 * @returns {{ root: string, repoA: string, cleanup: () => void }}
 */
function makeMonorootWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'budget-monoroot-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  mkdirSync(join(root, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(root, 'repo-b', '.git'), { recursive: true });

  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't-monoroot',
      lane: 'feature',
      loadedSkills: [],
      outputContract: { token_budget_class: 'standard' },
    }),
  );

  return {
    root,
    repoA: join(root, 'repo-a'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Spawn the hook exactly as hooks.json does — no args, payload on stdin.
 * @param {string} cwd  The cwd VS Code hands the hook.
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runHook(cwd, payload) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('check-session-budget — monoroot: finds the workspace-root task.json from inside a sibling repo', async () => {
  const { repoA, cleanup } = makeMonorootWorkspace();
  try {
    const { code, stdout, stderr } = await runHook(repoA, {
      hook_event_name: 'PostToolUse',
      session_id: TEST_SESSION_ID,
      cwd: repoA,
      tool_name: 'read_file',
      tool_input: { filePath: 'smoke.txt' },
    });
    const output = stdout + stderr;

    // The whole point: the contract IS persisted, one directory up. Reporting it
    // as unclassified is the bug.
    assert.ok(
      !output.includes('[BUDGET:unclassified]'),
      `expected the persisted OutputContract to be found, got: ${output}`,
    );
    assert.ok(output.includes('[BUDGET:ok]'), `expected a budget verdict, got: ${output}`);
    assert.equal(code, 0);
  } finally {
    cleanup();
  }
});

test('check-session-budget — monoroot: still reports unclassified when no task exists', async () => {
  const { root, repoA, cleanup } = makeMonorootWorkspace();
  try {
    // Remove the task, keep the layout: the guard must now honestly say so
    // rather than silently assuming a class — an unclassified session is only a
    // useful signal if it means what it says.
    rmSync(join(root, '.devmate', 'state', 'task.json'));

    const { stdout } = await runHook(repoA, {
      hook_event_name: 'PostToolUse',
      session_id: TEST_SESSION_ID,
      cwd: repoA,
      tool_name: 'read_file',
      tool_input: { filePath: 'smoke.txt' },
    });

    // On exit 0 the host parses stdout as JSON, so read it the way VS Code does
    // rather than substring-matching an escaped path out of the raw text.
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;

    assert.ok(
      context.includes('[BUDGET:unclassified]'),
      `expected unclassified with no task.json, got: ${context}`,
    );
    // …and it must name the path it actually looked at — the workspace root's,
    // not a cwd-relative one it never consulted.
    assert.ok(
      context.includes(join(root, '.devmate', 'state', 'task.json')),
      `expected the resolved workspace-root path in the diagnostic, got: ${context}`,
    );
  } finally {
    cleanup();
  }
});
