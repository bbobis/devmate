// @ts-check
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNonEmptyString } from './object-utils.mjs';

/**
 * The plugin install directory derived from this module's own location. Because
 * `lib/` ships inside the plugin, the directory above it IS the plugin root —
 * in the devmate repo that happens to be the repo root, and in a consumer's
 * editor it is wherever the plugin was installed.
 * @type {string}
 */
const MODULE_PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Resolve the devmate plugin's install directory — the root that
 * plugin-shipped artifacts (`hooks/hooks.json`, `scripts/`, `agents/`,
 * `skills/`, `config/`) are relative to.
 *
 * This is NEVER the consumer's repo root. A repo that installs devmate has a
 * `.devmate/` directory of its own but no `hooks/` or `scripts/`, so resolving
 * a plugin artifact against the repo root can only ENOENT. The two roots are
 * distinct and must stay that way:
 *
 *   - plugin root — what the plugin ships (this function)
 *   - repo root   — the user's workspace, where `.devmate/` lives (`resolveRepoRoot`)
 *
 * Prefers `PLUGIN_ROOT` (the value the editor expands in hook commands, when it
 * is also exported into the hook process) and falls back to the module-derived
 * path, which needs no cooperation from the host.
 * @returns {string}
 */
export function resolvePluginRoot() {
  const fromEnv = process.env['PLUGIN_ROOT'];
  return isNonEmptyString(fromEnv) ? resolve(fromEnv) : MODULE_PLUGIN_ROOT;
}
