// @ts-check
/**
 * Regression guard: .vscode/settings.json must ship
 * chat.subagents.allowInvocationsFromSubagents: true so contributors get
 * correct subagent behaviour without manual configuration (P3 fail-closed).
 *
 * It must also ship chat.customAgentInSubagent.enabled: true — without it,
 * custom .agent.md agents (e.g. @discovery, @tech-design) cannot be invoked
 * as subagents even with allowInvocationsFromSubagents enabled.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETTINGS_PATH = join(REPO_ROOT, '.vscode', 'settings.json');

test('vscode settings / chat.subagents.allowInvocationsFromSubagents is true', () => {
  const raw = readFileSync(SETTINGS_PATH, 'utf8');

  // Strip single-line // comments before parsing (settings.json is JSONC).
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  /** @type {Record<string, unknown>} */
  const settings = JSON.parse(stripped);

  assert.equal(
    settings['chat.subagents.allowInvocationsFromSubagents'],
    true,
    'chat.subagents.allowInvocationsFromSubagents must be true in .vscode/settings.json — ' +
    'removing it causes silent subagent dispatch failures.',
  );
});

test('vscode settings / chat.customAgentInSubagent.enabled is true', () => {
  const raw = readFileSync(SETTINGS_PATH, 'utf8');

  // Strip single-line // comments before parsing (settings.json is JSONC).
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  /** @type {Record<string, unknown>} */
  const settings = JSON.parse(stripped);

  assert.equal(
    settings['chat.customAgentInSubagent.enabled'],
    true,
    'chat.customAgentInSubagent.enabled must be true in .vscode/settings.json — ' +
    'removing it silently blocks custom .agent.md agents from being invoked as subagents.',
  );
});
