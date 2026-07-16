// @ts-check
import { resolve } from 'node:path';
import { isGateGuardRegistered } from './hooks/registry.mjs';
import { CONFIG_PATH, loadDevmateConfig } from './config/devmate-config.mjs';

/**
 * Check whether the gate-guard hook is registered and its script exists on disk.
 * Pure check — no side effects.
 *
 * Takes the **plugin root**, not the repo root: `hooks/hooks.json` and
 * `scripts/gate-guard.mjs` are both plugin-shipped and never exist in a
 * consumer's workspace.
 * @param {string} [pluginRoot]  Plugin install dir; defaults to resolvePluginRoot().
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkGateGuardActive(pluginRoot) {
  return isGateGuardRegistered(pluginRoot);
}

/**
 * Assert all devmate startup invariants. Checks:
 *   1. hooks.json is valid and the PreToolUse gate-guard script exists on disk.
 *   2. .devmate/devmate.config.json is present and passes validateDevmateConfig.
 *
 * The two checks are anchored to two DIFFERENT roots, and conflating them is a
 * bug (it broke SessionStart for every plugin consumer — see #72):
 *   - the gate-guard manifest + script are plugin-shipped → `pluginRoot`
 *   - `.devmate/devmate.config.json` is the user's own → `repoRoot`
 *
 * Returns a combined result — does NOT throw.
 * Callers should surface errors to the user and abort the session.
 * @param {string} [repoRoot]    The user's workspace root. Defaults to process.cwd().
 * @param {string} [pluginRoot]  Plugin install dir. Defaults to resolvePluginRoot().
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function assertDevmateReady(repoRoot, pluginRoot) {
  const root = repoRoot ?? process.cwd();
  /** @type {string[]} */
  const errors = [];

  // Check 1: gate-guard hook is registered and its script exists — plugin-relative.
  const gateGuardCheck = checkGateGuardActive(pluginRoot);
  if (!gateGuardCheck.ok && gateGuardCheck.error) {
    errors.push(gateGuardCheck.error);
  }

  // Check 2: devmate config is present and valid — repo-relative.
  const configPath = resolve(root, CONFIG_PATH);
  const configCheck = loadDevmateConfig(configPath);
  if (!configCheck.ok && configCheck.error) {
    errors.push(configCheck.error);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
