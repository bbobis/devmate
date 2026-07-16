// @ts-check
/**
 * #93: the SubagentStart/Stop hook is the PRODUCER of the agent identity the
 * gate-guard gates session-artifact writes on.
 *
 * `agent_type` and `agent_id` are host-supplied on a captured payload
 * (test/fixtures/hook-payloads/derived/subagentstart.fullstack.json) — that is
 * why the identity can be trusted at all: it is evidence the host recorded, not
 * a claim the model made. PreToolUse carries neither, so if this hook does not
 * write the roster, nothing downstream has one to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addActiveAgent,
  handleSubagentStart,
  handleSubagentStop,
  removeActiveAgent,
} from '../../hooks/subagent-budget-guard.mjs';

/** @typedef {import('../../lib/types.mjs').ActiveAgentEntry} ActiveAgentEntry */

/**
 * A temp workspace with a valid config and a task at impl-started.
 * @returns {string}  repoRoot
 */
function seedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sbg-agents-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['lib/**'] }],
      maxConcurrentAgents: 5,
    }),
    'utf8',
  );
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't-93',
      lane: 'feature',
      workflowGate: 'spec-draft',
      artifactHashes: {},
      preImplStash: null,
      currentStep: 0,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return root;
}

/**
 * @param {string} root
 * @returns {Record<string, any>}
 */
function readState(root) {
  return JSON.parse(readFileSync(join(root, '.devmate', 'state', 'task.json'), 'utf8'));
}

test('SubagentStart stamps the host-supplied agent_type onto task state', async () => {
  const root = seedRepo();
  try {
    await handleSubagentStart({ agentName: 'spec-writer', agentId: 'a1', repoRoot: root });
    assert.deepEqual(readState(root).activeAgents, [
      { agentName: 'spec-writer', agentId: 'a1' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SubagentStop removes exactly the instance that stopped', async () => {
  const root = seedRepo();
  try {
    // Two instances of one analysis agent — @fullstack cannot start at spec-draft
    // (the lane-gated dispatch check denies it, see below), and the roster's
    // one-entry-per-instance behaviour is what matters here, not the agent name.
    await handleSubagentStart({ agentName: 'discovery', agentId: 'a1', repoRoot: root });
    await handleSubagentStart({ agentName: 'discovery', agentId: 'a2', repoRoot: root });
    assert.equal(readState(root).activeAgents.length, 2);

    await handleSubagentStop({ agentName: 'discovery', agentId: 'a1', repoRoot: root });
    assert.deepEqual(readState(root).activeAgents, [{ agentName: 'discovery', agentId: 'a2' }]);
    // The count and the roster stay in step — they are one lifecycle.
    assert.equal(readState(root).activeSubagents, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a denied start stamps nothing — a sub-agent that never ran has no identity', async () => {
  const root = seedRepo();
  try {
    // An implementation dispatch at spec-draft is denied by the lane-gated
    // dispatch check (HITL-1). It must not leave an identity behind.
    const result = await handleSubagentStart({
      agentName: 'fullstack',
      agentId: 'a1',
      repoRoot: root,
    });
    assert.equal(result.decision, 'denied');
    assert.equal(readState(root).activeAgents, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a payload with no agent identity stamps nothing and still counts the start', async () => {
  const root = seedRepo();
  try {
    // agentName is '' when the payload carried neither agent_type nor agent_id.
    // Stamping it would write an entry task-state validation rejects — throwing
    // inside the hook and losing the increment too.
    const result = await handleSubagentStart({ agentName: '', agentId: '', repoRoot: root });
    assert.equal(result.decision, 'allowed');
    assert.deepEqual(readState(root).activeAgents, []);
    assert.equal(readState(root).activeSubagents, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- The pure roster helpers ----

test('addActiveAgent — a repeated agent_id replaces its entry instead of duplicating it', () => {
  /** @type {ActiveAgentEntry[]} */
  const roster = [{ agentName: 'fullstack', agentId: 'a1' }];
  const next = addActiveAgent(roster, { agentName: 'fullstack', agentId: 'a1' });
  assert.deepEqual(next, [{ agentName: 'fullstack', agentId: 'a1' }]);
});

test('addActiveAgent — two instances of one agent are two entries', () => {
  const next = addActiveAgent([{ agentName: 'fullstack', agentId: 'a1' }], {
    agentName: 'fullstack',
    agentId: 'a2',
  });
  assert.equal(next.length, 2);
});

test('removeActiveAgent — with no agent_id, drops ONE entry of that name, not all', () => {
  // A stop payload without an id must leak at most one stale entry rather than
  // clearing the identity of every instance still running.
  const roster = [
    { agentName: 'fullstack', agentId: 'a1' },
    { agentName: 'fullstack', agentId: 'a2' },
  ];
  const next = removeActiveAgent(roster, { agentName: 'fullstack', agentId: '' });
  assert.deepEqual(next, [{ agentName: 'fullstack', agentId: 'a2' }]);
});

test('removeActiveAgent — an unknown id removes nothing', () => {
  const roster = [{ agentName: 'fullstack', agentId: 'a1' }];
  assert.deepEqual(removeActiveAgent(roster, { agentName: 'fullstack', agentId: 'zz' }), roster);
});
