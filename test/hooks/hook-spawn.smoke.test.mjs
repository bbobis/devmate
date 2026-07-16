// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..');
const HOOKS_JSON_PATH = resolve(REPO_ROOT, 'hooks', 'hooks.json');
const PLUGIN_ROOT_PLACEHOLDER = '${PLUGIN_ROOT}';

/**
 * @typedef {Object} HookCommandEntry
 * @property {'command'} type
 * @property {string} command
 * @property {string} [windows]
 * @property {string} [linux]
 * @property {string} [osx]
 */

/**
 * @typedef {Object} HookManifest
 * @property {Record<string, HookCommandEntry[]>} hooks
 * @property {number} schemaVersion
 */

/**
 * Load the real hook manifest from the repo.
 * @returns {HookManifest}
 */
function loadManifest() {
  return /** @type {HookManifest} */ (JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf8')));
}

/**
 * Select the command string that the current platform would execute.
 * @param {HookCommandEntry} entry
 * @returns {string}
 */
function selectPlatformCommand(entry) {
  if (process.platform === 'win32') return entry.windows ?? entry.command;
  if (process.platform === 'darwin') return entry.osx ?? entry.command;
  return entry.linux ?? entry.command;
}

/**
 * Create a hook input payload that is valid enough for command-resolution smoke tests.
 * The test only proves shell resolution and process launch, so synthetic fields are fine.
 * @param {string} eventName
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function makeHookInput(eventName, cwd) {
  /** @type {Record<string, unknown>} */
  const payload = {
    timestamp: new Date().toISOString(),
    cwd,
    session_id: 'hook-spawn-smoke',
    hook_event_name: eventName,
  };

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    payload['tool_name'] = 'read_file';
    payload['tool_input'] = { filePath: 'smoke.txt' };
  }

  if (eventName === 'UserPromptSubmit') {
    payload['prompt'] = 'smoke test';
  }

  return payload;
}

/**
 * Execute a hook command via the platform shell and capture the result.
 * @param {string} command
 * @param {Record<string, unknown>} input
 * @param {string} cwd
 * @returns {Promise<{ error: Error | null, stdout: string, stderr: string }>}
 */
function execHookCommand(command, input, cwd) {
  return new Promise((resolveResult) => {
    // eslint-disable-next-line security/detect-child-process -- smoke test deliberately executes the repo's own hooks.json command string (loaded from the checked-in manifest), to prove the spawn path works end-to-end; no external input reaches `command`.
    const child = exec(command, { cwd, timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolveResult({
        error: error instanceof Error ? error : null,
        stdout,
        stderr,
      });
    });

    child.stdin?.end(JSON.stringify(input));
  });
}

/**
 * Return true when the shell could not find the node runtime.
 * @param {Error | null} error
 * @param {string} stderr
 * @returns {boolean}
 */
function isMissingNodeRuntime(error, stderr) {
  const text = `${error?.message ?? ''}\n${stderr}`;
  const lower = text.toLowerCase();
  return (
    lower.includes('enoent') ||
    lower.includes('node: not found') ||
    lower.includes('node.exe: not found') ||
    lower.includes('is not recognized as an internal or external command')
  );
}

test('real hook commands resolve through the platform shell', async (t) => {
  const manifest = loadManifest();
  const postToolUse = manifest.hooks['PostToolUse'] ?? [];
  assert.ok(
    postToolUse.some((entry) =>
      (entry.command ?? '').includes('hooks/contract-validator.mjs')
    ),
    'PostToolUse should include hooks/contract-validator.mjs'
  );
  const scratchDir = mkdtempSync(resolve(tmpdir(), 'devmate-hook-smoke-'));

  t.after(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  for (const [eventName, entries] of Object.entries(manifest.hooks)) {
    for (const [index, entry] of entries.entries()) {
      await t.test(`${eventName}[${index}] resolves`, async () => {
        const shellCommand = selectPlatformCommand(entry).replaceAll(PLUGIN_ROOT_PLACEHOLDER, REPO_ROOT);
        const result = await execHookCommand(shellCommand, makeHookInput(eventName, scratchDir), scratchDir);

        if (isMissingNodeRuntime(result.error, result.stderr)) {
          t.skip('node is not available on PATH for shell-based hook execution');
          return;
        }

        const combined = `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
        const combinedLower = combined.toLowerCase();
        assert.ok(
          !combined.includes('MODULE_NOT_FOUND') && !combinedLower.includes('cannot find module'),
          `hook command did not resolve its script: ${shellCommand}\n${combined}`
        );
      });
    }
  }
});