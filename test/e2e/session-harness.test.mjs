// @ts-check
/**
 * #131: unit tests for the session-harness additions themselves.
 *
 * A harness bug that silently green-lights a broken scenario is worse than no
 * harness, so the driver and its helpers are pinned directly here:
 *   - `subagentReturnPayload` structurally matches the CAPTURED fixture, not a
 *     hand-guessed shape, and round-trips through the real `extractAgentResult`.
 *   - `isUserStuck` returns the right verdict at real gates AND — the point of
 *     the whole epic — flags a gate whose only exits are events no runtime
 *     caller fires, proven against an injected allowlist.
 *   - `runSession` drives a trivial script end to end through the real hooks.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { extractAgentResult } from '../../lib/hooks/agent-result.mjs';
import {
  RUNTIME_FIREABLE_EVENTS,
  isUserStuck,
  runSession,
  seedMonorootWorkspace,
  subagentReturnPayload,
} from './session-harness.mjs';

/** @typedef {import('../../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../../lib/types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('../../lib/types.mjs').Lane} Lane */
/** @typedef {import('../../lib/types.mjs').GateEvent} GateEvent */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(
  __dirname,
  '..',
  'fixtures',
  'hook-payloads',
  'captured',
  'posttooluse.run-subagent.json',
);

/**
 * A minimal TaskState carrying only the two fields `isUserStuck` reads.
 * @param {Lane} lane
 * @param {WorkflowGate} gate
 * @returns {TaskState}
 */
function stateAt(lane, gate) {
  return /** @type {TaskState} */ ({ lane, workflowGate: gate });
}

describe('subagentReturnPayload — the captured shape, not a guess', () => {
  it('matches the captured fixture key-for-key (bar the host timestamp)', () => {
    const fixture = JSON.parse(readFileSync(CAPTURED, 'utf8'));
    const payload = subagentReturnPayload('router', { lane: 'feature' });

    // The harness authors its own deterministic timestamps at the turn level, so
    // the one key it omits is the host's wall-clock `timestamp`. Every other key
    // the host delivers must be present — a deep key-set match, not "doesn't
    // throw".
    const expectedKeys = Object.keys(fixture).filter((k) => k !== 'timestamp').sort();
    assert.deepEqual(Object.keys(payload).sort(), expectedKeys);
  });

  it('carries the exact value shapes the gate-advance hook reads', () => {
    const payload = subagentReturnPayload('router', { lane: 'feature' });
    // The tool the host reports and the elided tool_input literal are fixed.
    assert.equal(payload.tool_name, 'runSubagent');
    assert.equal(payload.tool_input, '...');
    // tool_response is chat text: prose (with a decoy `{}`) then the JSON contract.
    assert.equal(typeof payload.tool_response, 'string');
    assert.match(String(payload.tool_response), /\{\}/);
  });

  it('round-trips through the real extractAgentResult, decoy braces and all', () => {
    const payload = subagentReturnPayload('router', { lane: 'feature', budgetClass: 'standard' });
    const extracted = extractAgentResult(payload.tool_response);
    assert.equal(extracted.empty, false);
    assert.equal(extracted.agentName, 'router');
    assert.equal(extracted.result?.lane, 'feature');
    assert.equal(extracted.result?.budgetClass, 'standard');
  });

  it('lets a self-identifying body override the default agent name', () => {
    const payload = subagentReturnPayload('router', { agentName: 'planner', tasks: [] });
    const extracted = extractAgentResult(payload.tool_response);
    assert.equal(extracted.agentName, 'planner');
  });
});

describe('isUserStuck — lane-specific legal events intersected with real callers', () => {
  it('is not stuck at no-lane: set-lane is fireable on every lane', () => {
    for (const lane of /** @type {Lane[]} */ (['feature', 'bug', 'chore'])) {
      assert.equal(isUserStuck(stateAt(lane, 'no-lane')), false, lane);
    }
  });

  it('is not stuck at feature impl-started: steering (#127) and the hook (#132) both fire', () => {
    // pass-verification (gate-advance hook via LANE_CHAINS, #132) and
    // revise-scope/re-plan (approval-listener -> steerFeature, #127) are all
    // fireable, so the gate has a path forward.
    assert.equal(isUserStuck(stateAt('feature', 'impl-started')), false);
  });

  it('is not stuck at bug impl-started: #132 wired the forward pass-verification', () => {
    // Before #132 this was the dead-end this helper was built to catch: the bug
    // lane fired neither pass-verification (its only firer, runChoreLane, is
    // reached from tests only) nor the feature-only steering. #132 put
    // pass-verification in every LANE_CHAIN, so the gate-advance hook now advances
    // bug impl-started forward.
    assert.equal(isUserStuck(stateAt('bug', 'impl-started')), false);
  });

  it('is not stuck at chore impl-started: the gate-advance hook fires pass-verification', () => {
    assert.equal(isUserStuck(stateAt('chore', 'impl-started')), false);
  });

  it('WOULD flag feature impl-started in a world where no forward or steering caller existed', () => {
    // The epic's whole reason to exist. Before #127 (steering) and #132
    // (pass-verification in the hook), feature impl-started had no runtime-fireable
    // exit. Injecting that pre-fix allowlist — the spine plus start-impl, with
    // neither steering nor pass-verification — flags the dead-end, proving the
    // mechanism catches the class without any gate-specific hardcode.
    const preFixFeature = /** @type {GateEvent[]} */ ([
      'set-lane', 'finish-discovery', 'finish-grill', 'finish-plan',
      'draft-spec', 'start-impl',
    ]);
    assert.equal(
      isUserStuck(stateAt('feature', 'impl-started'), { fireableEvents: preFixFeature }),
      true,
    );
  });

  it('credits a single fireable steering event (the mechanism, not a hardcode)', () => {
    assert.equal(
      isUserStuck(stateAt('feature', 'impl-started'), { fireableEvents: ['revise-scope'] }),
      false,
    );
  });

  it('an injected allowlist overrides the per-lane default (replace, not union)', () => {
    // An empty injected set makes an otherwise-live gate stuck — proving injection
    // REPLACES the per-lane default rather than unioning with it.
    assert.equal(
      isUserStuck(stateAt('feature', 'impl-started'), { fireableEvents: [] }),
      true,
    );
    // And a Set injection is accepted as readily as an array.
    assert.equal(
      isUserStuck(stateAt('bug', 'impl-started'), { fireableEvents: new Set(['re-plan']) }),
      false,
    );
  });

  it('reports stuck when nothing at all is fireable', () => {
    assert.equal(isUserStuck(stateAt('feature', 'no-lane'), { fireableEvents: [] }), true);
  });

  for (const gate of /** @type {WorkflowGate[]} */ ([
    'done', 'abandoned', 'parked', 'spec-draft', 'verification-passed', 'pr-ready',
  ])) {
    it(`is not stuck at the resting gate ${gate}`, () => {
      // Terminal, deliberately-paused, phrase-advanced human gates, and the
      // PR-ready / verified near-terminals are legitimate rests — never wedges —
      // even with an empty event allowlist.
      assert.equal(isUserStuck(stateAt('feature', gate), { fireableEvents: [] }), false);
    });
  }

  it('pass-verification is fired on every lane; steering stays feature-only', () => {
    for (const lane of /** @type {Lane[]} */ (['feature', 'bug', 'chore'])) {
      assert.equal(RUNTIME_FIREABLE_EVENTS[lane].has('pass-verification'), true, lane);
    }
    for (const lane of /** @type {Lane[]} */ (['bug', 'chore'])) {
      assert.equal(RUNTIME_FIREABLE_EVENTS[lane].has('revise-scope'), false, lane);
      assert.equal(RUNTIME_FIREABLE_EVENTS[lane].has('re-plan'), false, lane);
    }
    assert.equal(RUNTIME_FIREABLE_EVENTS.feature.has('revise-scope'), true);
  });

  it('no lane fires the CLI-only or vestigial events', () => {
    for (const lane of /** @type {Lane[]} */ (['feature', 'bug', 'chore'])) {
      for (const absent of /** @type {GateEvent[]} */ ([
        'mark-pr-ready', 'complete', 'approve-plan', 'new-requirements', 'park', 'resume', 'abandon',
      ])) {
        assert.equal(RUNTIME_FIREABLE_EVENTS[lane].has(absent), false, `${lane}:${absent}`);
      }
    }
  });
});

describe('runSession — a trivial script through the real hooks', () => {
  it('bootstraps state and returns one TurnResult per turn', async () => {
    const ws = seedMonorootWorkspace();
    try {
      const turns = [
        { prompt: 'kick things off', tools: [{ toolName: 'read_file', toolInput: { path: 'README.md' } }] },
        { prompt: 'what is the status?' },
      ];
      const results = await runSession(turns, {
        hostCwd: ws.hostCwd,
        root: ws.root,
        now: () => '2030-01-01T00:00:00.000Z',
      });

      assert.equal(results.length, 2);
      for (const [i, r] of results.entries()) {
        assert.equal(r.prompt, turns[i].prompt);
        assert.ok(r.ran.length > 0, `turn ${i} ran no hooks`);
        assert.ok(r.stateAfter, `turn ${i} left no state`);
        // A plain prompt never leaves the pre-router gate, and no-lane is not a
        // dead end (set-lane is fireable), so the user is never stuck here.
        assert.equal(r.gate, 'no-lane');
        assert.equal(r.stuck, false);
      }
      // The tool-bearing turn ran strictly more hooks than the prompt-only turn.
      assert.ok(results[0].ran.length > results[1].ran.length);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });
});
