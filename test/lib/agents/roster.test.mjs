// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEVMATE_AGENT_NAMES, isDevmateAgentType } from '../../../lib/agents/roster.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(HERE, '../../../agents');

test('isDevmateAgentType accepts every rostered agent', () => {
  for (const name of DEVMATE_AGENT_NAMES) {
    assert.equal(isDevmateAgentType(name), true, `${name} should be a devmate agent`);
  }
});

test('isDevmateAgentType rejects non-devmate / malformed types', () => {
  for (const bad of ['', 'not-an-agent', 'copilot', 'ORCHESTRATOR', null, undefined, 42, {}]) {
    assert.equal(isDevmateAgentType(/** @type {any} */ (bad)), false, `${String(bad)} must not count as devmate`);
  }
});

test('DEVMATE_AGENT_NAMES is frozen', () => {
  assert.equal(Object.isFrozen(DEVMATE_AGENT_NAMES), true);
});

test('drift: roster exactly matches agents/*.agent.md filenames', () => {
  const onDisk = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.agent.md'))
    .map((f) => f.slice(0, -'.agent.md'.length))
    .sort();
  const rostered = [...DEVMATE_AGENT_NAMES].sort();
  assert.deepEqual(
    rostered,
    onDisk,
    'lib/agents/roster.mjs drifted from agents/ — update DEVMATE_AGENT_NAMES to match the shipped agents',
  );
});
