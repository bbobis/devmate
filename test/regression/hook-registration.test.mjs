// @ts-check
/**
 * E0-1 regression: hooks/hooks.json must register only valid .mjs command
 * entrypoints, no .ps1, with type "command" on every entry, and required
 * events present. Reconciled to real API: loadHookManifest + validateHookManifest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHookManifest,
  validateHookManifest,
  extractScriptPath,
} from '../../lib/hooks/registry.mjs';

/**
 * Flatten all hook entries across every event into a single array.
 * @param {Record<string, unknown>} hooks
 * @returns {Array<Record<string, unknown>>}
 */
function allEntries(hooks) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      for (const e of entries) out.push(/** @type {Record<string, unknown>} */ (e));
    }
  }
  return out;
}

test('hook-registration › all registered entries have type: "command"', () => {
  const manifest = loadHookManifest();
  const result = validateHookManifest(manifest);
  assert.equal(result.ok, true, `manifest invalid: ${result.errors.join('; ')}`);

  const hooks = /** @type {Record<string, unknown>} */ (manifest.hooks);
  for (const entry of allEntries(hooks)) {
    assert.equal(entry['type'], 'command', `entry type must be "command": ${JSON.stringify(entry)}`);
  }
});

test('hook-registration › all registered commands point to a .mjs script', () => {
  // Commands now run through `node` and reference the script via the
  // ${PLUGIN_ROOT} plugin-root token, so the raw command no longer
  // ends in ".mjs" (it ends in '.mjs"' with a closing quote). Extract the
  // script path and assert it resolves to a .mjs file.
  const manifest = loadHookManifest();
  const hooks = /** @type {Record<string, unknown>} */ (manifest.hooks);
  for (const entry of allEntries(hooks)) {
    const cmd = String(entry['command']);
    const scriptPath = extractScriptPath(cmd);
    assert.ok(scriptPath !== null, `command must reference a .mjs script: ${cmd}`);
    assert.ok(scriptPath.endsWith('.mjs'), `extracted script must end in .mjs: ${scriptPath} (from: ${cmd})`);
  }
});

test('hook-registration › no .ps1 entries', () => {
  const manifest = loadHookManifest();
  const hooks = /** @type {Record<string, unknown>} */ (manifest.hooks);
  for (const entry of allEntries(hooks)) {
    const cmd = String(entry['command']);
    assert.ok(!cmd.includes('.ps1'), `PowerShell hook entrypoint found: ${cmd}`);
  }
});

test('hook-registration › required hook events are present', () => {
  const manifest = loadHookManifest();
  const hooks = /** @type {Record<string, unknown>} */ (manifest.hooks);
  for (const event of ['PostToolUse', 'SessionStart']) {
    const entries = hooks[event];
    assert.ok(Array.isArray(entries) && entries.length >= 1, `event "${event}" must have >= 1 entry`);
  }
});
