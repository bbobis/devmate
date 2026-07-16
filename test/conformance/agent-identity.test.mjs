// @ts-check
/**
 * What identity the wire actually carries — asserted against CAPTURED payloads,
 * because this is the question every persona/agent-attribution design in this
 * repo has answered wrong (#77, #93, #99).
 *
 * The findings, in one place:
 *
 *   1. A `SubagentStart` names its agent (`agent_type`) and its instance
 *      (`agent_id`) — and `agent_id` IS a parent link: it is the `tool_use_id` of
 *      the `runSubagent` call that spawned it. A child can be tied to the dispatch
 *      that made it.
 *   2. A `PreToolUse` carries NO agent identity. Not `agent_id`, not `agent_type`,
 *      not `agentName` — nothing. So the link in (1) has nothing to join against
 *      on an edit: when two workers run concurrently, the edit that arrives cannot
 *      be attributed to either.
 *
 * (2) is why gate-guard Rule 5 was deleted rather than repaired (#99): no roster,
 * no persona pin, and no parent link the host might add to SubagentStart can make
 * an edit attributable, because the attribution has to happen on the EDIT event and
 * that event says nothing about who sent it. The per-worker boundary therefore lives
 * at completion, where the persona and the changed files arrive together on the
 * worker's own returned contract.
 *
 * If a future VS Code release adds an agent field to PreToolUse, THIS test is what
 * fails — and per-edit attribution becomes possible again. That is the point of
 * pinning it to a capture rather than to prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'hook-payloads');

/** @param {string} rel @returns {Record<string, unknown>} */
function load(rel) {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
}

/** Every key that could name the agent behind a call. */
const IDENTITY_KEYS = ['agent_id', 'agent_type', 'agentName', 'agent', 'persona'];

test('a captured SubagentStart identifies its agent by agent_type + agent_id, and nothing else', () => {
  const ev = load('captured/subagentstart.router.json');
  assert.equal(ev['hook_event_name'], 'SubagentStart');
  assert.equal(ev['agent_type'], 'router');
  assert.equal(typeof ev['agent_id'], 'string');
  // The keys devmate invented and read for its whole life. None are on the wire.
  assert.equal(ev['agentName'], undefined);
  assert.equal(ev['persona'], undefined);
  assert.equal(ev['taskId'], undefined);
  assert.equal(ev['repoRoot'], undefined);
});

test("a subagent's agent_id IS the tool_use_id of the runSubagent call that spawned it", () => {
  // Both events come from ONE captured session, so this is a real join, not a
  // coincidence of two fixtures written by the same hand.
  const session = /** @type {{ events: Record<string, unknown>[] }} */ (
    /** @type {unknown} */ (load('sessions/feature-lane-router.session.json'))
  );
  const dispatch = session.events.find(
    (e) => e['hook_event_name'] === 'PreToolUse' && e['tool_name'] === 'runSubagent',
  );
  const start = session.events.find((e) => e['hook_event_name'] === 'SubagentStart');
  assert.ok(dispatch && start, 'the captured session must contain both events');

  const toolUseId = String(dispatch['tool_use_id']);
  const agentId = String(start['agent_id']);
  // The host appends a `__vscode-<n>` suffix to the tool_use_id it reports on the
  // tool event; the agent_id is the bare id.
  assert.ok(
    toolUseId.startsWith(agentId),
    `agent_id (${agentId}) must be the prefix of the spawning tool_use_id (${toolUseId})`,
  );

  // …and the id is NOT a parent pointer. It ties the child to its own dispatch
  // CALL, not to whichever agent made that call — so a nested dispatch
  // (wrapper → fullstack) would still not say which wrapper the fullstack belongs
  // to unless the host also told us who ran the tool. It does not; see below.
  assert.equal(start['parent_agent_id'], undefined);
  assert.equal(start['parent_id'], undefined);
});

test('a captured PreToolUse carries NO agent identity — an edit cannot be attributed to a worker', () => {
  // The load-bearing fact. Every per-edit persona/agent rule this repo has tried
  // to build died here, and each one died silently.
  const ev = load('captured/pretooluse.read-file.json');
  assert.equal(ev['hook_event_name'], 'PreToolUse');
  for (const key of IDENTITY_KEYS) {
    assert.equal(
      ev[key],
      undefined,
      `PreToolUse must not be assumed to carry '${key}' — no captured payload has one`,
    );
  }
  // What it DOES carry, in full. If this list ever grows an identity field, the
  // assertion above is the one that will catch it.
  assert.deepEqual(Object.keys(ev).sort(), [
    'cwd',
    'hook_event_name',
    'session_id',
    'timestamp',
    'tool_input',
    'tool_name',
    'tool_use_id',
    'transcript_path',
  ]);
});

test('no PreToolUse in the captured session stream carries an agent identity either', () => {
  const session = /** @type {{ events: Record<string, unknown>[] }} */ (
    /** @type {unknown} */ (load('sessions/feature-lane-router.session.json'))
  );
  const preToolUse = session.events.filter((e) => e['hook_event_name'] === 'PreToolUse');
  assert.ok(preToolUse.length > 0, 'the captured session must contain PreToolUse events');
  for (const ev of preToolUse) {
    for (const key of IDENTITY_KEYS) {
      assert.equal(ev[key], undefined, `PreToolUse carried '${key}' — the design must be revisited`);
    }
  }
});
