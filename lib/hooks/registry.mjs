// @ts-check
import { resolve } from 'node:path';
import { pathExists, readTextFileSync } from '../fs-safe.mjs';
import { isNonEmptyString } from '../object-utils.mjs';
import { resolvePluginRoot } from '../plugin-root.mjs';

/** @typedef {import('../types.mjs').HookManifest} HookManifest */
/** @typedef {import('../types.mjs').HookEntry} HookEntry */
/** @typedef {import('../types.mjs').HookEvent} HookEvent */

/**
 * The official VS Code Copilot hook event names.
 * Source: https://code.visualstudio.com/docs/copilot/customization/hooks
 * @type {readonly HookEvent[]}
 */
export const OFFICIAL_HOOK_EVENTS = /** @type {const} */ ([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

/**
 * Load and JSON-parse `hooks/hooks.json` from the **plugin root**.
 *
 * `hooks/hooks.json` is a plugin-shipped artifact (`.plugin/plugin.json`
 * declares it as `"hooks": "hooks/hooks.json"`), so it is resolved against the
 * plugin install directory — never against the consumer's repo root, which has
 * no `hooks/` directory of its own.
 *
 * Throws a typed error on malformed JSON or if the file is missing.
 * Does NOT validate event names — call validateHookManifest() for that.
 * @param {string} [pluginRoot]  Plugin install dir; defaults to resolvePluginRoot().
 * @returns {HookManifest}
 */
export function loadHookManifest(pluginRoot) {
  const hooksJsonPath = resolve(pluginRoot ?? resolvePluginRoot(), 'hooks/hooks.json');

  let raw;
  try {
    raw = readTextFileSync(hooksJsonPath);
  } catch (/** @type {any} */ err) {
    throw new Error(`Failed to read hooks manifest at ${hooksJsonPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (/** @type {any} */ err) {
    throw new Error(
      `Malformed JSON in hooks manifest at ${hooksJsonPath}: ${err.message}. ` +
      'The file has not been modified — fix it manually.'
    );
  }
}

/**
 * The plugin-root token VS Code expands at runtime for Claude-format plugins.
 * The expanded value is the plugin's install directory, which for this repo is
 * the repo root. Source:
 * https://code.visualstudio.com/docs/agent-customization/agent-plugins
 */
const PLUGIN_ROOT_PLACEHOLDER = '${PLUGIN_ROOT}';

/**
 * Find the first token in a command string that points to a .mjs file.
 * Keeps the original path separators but strips surrounding quotes.
 * @param {string} command
 * @returns {string|null}
 */
function extractScriptToken(command) {
  const tokens = command.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  return tokens.find((t) => t.replace(/\\/g, '/').endsWith('.mjs')) ?? null;
}

/**
 * Check whether a hook command invokes node directly.
 * @param {string} command
 * @param {boolean} allowNodeExe
 * @returns {boolean}
 */
function hasNodeRuntime(command, allowNodeExe) {
  const runtime = command.trim().split(' ')[0]?.toLowerCase();
  return runtime === 'node' || (allowNodeExe && runtime === 'node.exe');
}

/**
 * Check whether the script token is wrapped in double quotes after the runtime.
 * Allows optional trailing args after the quoted path.
 * @param {string} command
 * @param {boolean} allowNodeExe
 * @returns {boolean}
 */
function hasQuotedScriptPath(command, allowNodeExe) {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return false;
  const runtime = trimmed.slice(0, firstSpace).toLowerCase();
  if (allowNodeExe) {
    if (runtime !== 'node' && runtime !== 'node.exe') return false;
  } else if (runtime !== 'node') {
    return false;
  }

  const rest = trimmed.slice(firstSpace).trimStart();
  if (!rest.startsWith('"')) return false;
  const closingQuote = rest.indexOf('"', 1);
  if (closingQuote === -1) return false;
  const scriptToken = rest.slice(1, closingQuote);
  if (!scriptToken.toLowerCase().endsWith('.mjs')) return false;
  return true;
}

/**
 * Validate one command-bearing hook field.
 * @param {string[]} errors
 * @param {string} event
 * @param {number} idx
 * @param {'command'|'windows'} field
 * @param {unknown} value
 */
function validateCommandField(errors, event, idx, field, value) {
  const errorPrefix = `hooks.${event}[${idx}].${field}`;
  if (!isNonEmptyString(value)) {
    errors.push(`${errorPrefix}: must be a non-empty string.`);
    return;
  }

  const allowNodeExe = field === 'windows';
  if (!hasNodeRuntime(value, allowNodeExe)) {
    errors.push(`${errorPrefix}: must invoke node${allowNodeExe ? ' or node.exe' : ''}.`);
  }

  if (!value.includes(PLUGIN_ROOT_PLACEHOLDER)) {
    errors.push(`${errorPrefix}: must include ${PLUGIN_ROOT_PLACEHOLDER}.`);
  }

  if (!hasQuotedScriptPath(value, allowNodeExe)) {
    errors.push(`${errorPrefix}: script path must be double-quoted.`);
  }

  const scriptRef = extractScriptToken(value);
  if (scriptRef === null) {
    errors.push(`${errorPrefix}: must reference a .mjs script.`);
    return;
  }

  if (field === 'command') {
    if (scriptRef.includes('\\')) {
      errors.push(`${errorPrefix}: script path must use forward slashes.`);
    }
  } else {
    if (scriptRef.includes('/')) {
      errors.push(`${errorPrefix}: script path must use backslashes.`);
    }
  }

  const scriptPath = extractScriptPath(value);
  if (scriptPath !== null) {
    // `${PLUGIN_ROOT}` expands to the plugin install dir at runtime, so the
    // existence check anchors there too.
    const absPath = resolve(resolvePluginRoot(), scriptPath);
    if (!pathExists(absPath)) {
      errors.push(`${errorPrefix}: command file not found: ${scriptPath} (resolved to ${absPath}).`);
    }
  }
}

/**
 * Extract the repo-root-relative `.mjs` script path from a hook command string.
 *
 * Handles the documented command forms:
 *   - bare relative:        `scripts/x.mjs`
 *   - runtime prefix:       `node scripts/x.mjs`
 *   - plugin-root (posix):  `node "${PLUGIN_ROOT}/scripts/x.mjs"`
 *   - plugin-root (windows):`node "${PLUGIN_ROOT}\scripts\x.mjs"`
 *
 * Returns the script path relative to the repo root (forward-slashed), or null
 * when the command references no `.mjs` file.
 * @param {string} command
 * @returns {string|null}
 */
export function extractScriptPath(command) {
  // Strip surrounding quotes from each whitespace-separated token, then find
  // the one that points at a .mjs file (after normalising path separators).
  const mjsRef = extractScriptToken(command);
  if (mjsRef === null) return null;

  // Normalise Windows backslashes to forward slashes for a consistent path.
  let scriptPath = mjsRef.replace(/\\/g, '/');

  // Drop the plugin-root token (and a following separator) — at runtime it is
  // the plugin install dir; for the local existence check it is the repo root.
  const tokenPosix = PLUGIN_ROOT_PLACEHOLDER.replace(/\\/g, '/');
  if (scriptPath.startsWith(tokenPosix)) {
    scriptPath = scriptPath.slice(tokenPosix.length).replace(/^\/+/, '');
  }

  return scriptPath;
}

/**
 * Validate a hook manifest object.
 * Pure function — no I/O except optional file-existence check for command paths.
 * @param {unknown} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateHookManifest(manifest) {
  /** @type {string[]} */
  const errors = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['Manifest must be a plain object.'] };
  }

  const m = /** @type {Record<string, unknown>} */ (manifest);

  // schemaVersion check
  if (typeof m['schemaVersion'] !== 'number') {
    errors.push('Missing or invalid `schemaVersion` (must be a number).');
  }

  // hooks object check
  if (m['hooks'] === null || typeof m['hooks'] !== 'object' || Array.isArray(m['hooks'])) {
    errors.push('`hooks` must be a plain object.');
    return { ok: errors.length === 0, errors };
  }

  const hooks = /** @type {Record<string, unknown>} */ (m['hooks']);

  for (const [event, entries] of Object.entries(hooks)) {
    if (!OFFICIAL_HOOK_EVENTS.includes(/** @type {HookEvent} */ (event))) {
      errors.push(
        `Unknown hook event "${event}". Allowed events: ${OFFICIAL_HOOK_EVENTS.join(', ')}.`
      );
      continue;
    }

    if (!Array.isArray(entries)) {
      errors.push(`Hook entries for event "${event}" must be an array.`);
      continue;
    }

    entries.forEach((entry, idx) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`hooks.${event}[${idx}]: entry must be a plain object.`);
        return;
      }
      const e = /** @type {Record<string, unknown>} */ (entry);

      if (e['type'] !== 'command') {
        errors.push(
          `hooks.${event}[${idx}]: \`type\` must be the string literal "command", got ${JSON.stringify(e['type'])}.`
        );
      }

      if (typeof e['command'] !== 'string' || e['command'].trim() === '') {
        errors.push(`hooks.${event}[${idx}]: \`command\` must be a non-empty string.`);
      } else {
        validateCommandField(errors, event, idx, 'command', e['command']);
      }

      validateCommandField(errors, event, idx, 'windows', e['windows']);
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Check whether the gate-guard PreToolUse hook is registered and its script
 * path resolves on disk. Returns pure check — no side effects.
 * Checks the PreToolUse event for an entry whose extracted script path matches
 * 'scripts/gate-guard.mjs'.
 *
 * Both the manifest and the script it references are plugin-shipped, so both
 * resolve against the **plugin root** — passing a consumer's repo root here
 * always fails, because a repo that merely installs devmate has no `hooks/`.
 * @param {string} [pluginRoot]  Plugin install dir; defaults to resolvePluginRoot().
 * @returns {{ ok: boolean, error?: string }}
 */
export function isGateGuardRegistered(pluginRoot) {
  try {
    const manifest = loadHookManifest(pluginRoot);

    // Check PreToolUse event for a gate-guard entry
    const preToolUseEntries = manifest.hooks?.['PreToolUse'];
    if (!Array.isArray(preToolUseEntries) || preToolUseEntries.length === 0) {
      return {
        ok: false,
        error: 'Gate-guard hook not found: PreToolUse event missing or empty in hooks.json',
      };
    }
    
    // Find an entry whose script path matches 'scripts/gate-guard.mjs'
    const gateGuardEntry = preToolUseEntries.find((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const e = /** @type {Record<string, unknown>} */ (entry);
      const command = e['command'];
      if (typeof command !== 'string') return false;
      const scriptPath = extractScriptPath(command);
      return scriptPath && scriptPath.endsWith('scripts/gate-guard.mjs');
    });
    
    if (!gateGuardEntry) {
      return {
        ok: false,
        error: 'Gate-guard hook not found: no PreToolUse entry references scripts/gate-guard.mjs',
      };
    }
    
    // Verify the script path exists on disk (also plugin-relative).
    const baseDir = pluginRoot ?? resolvePluginRoot();
    const entry = /** @type {Record<string, unknown>} */ (gateGuardEntry);
    const command = /** @type {string} */ (entry['command']);
    const scriptPath = extractScriptPath(command);
    if (!scriptPath) {
      return {
        ok: false,
        error: 'Gate-guard hook entry has invalid script path',
      };
    }
    
    const absPath = resolve(baseDir, scriptPath);
    if (!pathExists(absPath)) {
      return {
        ok: false,
        error: `Gate-guard script file not found on disk: ${scriptPath} (resolved to ${absPath})`,
      };
    }
    
    return { ok: true };
  } catch (/** @type {any} */ err) {
    return {
      ok: false,
      error: `Failed to check gate-guard hook: ${err.message}`,
    };
  }
}
