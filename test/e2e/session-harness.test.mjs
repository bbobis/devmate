// @ts-check
/**
 * Unit tests for the scripted-turn driver added to the E2E session harness
 * (issue #131). A harness that silently green-lights a broken scenario is worse
 * than no harness, so the harness itself is tested: the stuck-state verdict
 * against hand-built states, the subagent-return payload against the CAPTURED
 * fixture shape (never a hand-guessed one), and a smoke replay of runSession.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { extractAgentResult } from '../../lib/hooks/agent-result.mjs';
import {
  FIREABLE_EVENTS,
  isUserStuck,
  readState,
  runSession,
  seedMonorootWorkspace,
  subagentReturnPayload,
} from './session-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Build a minimal-but-valid TaskState at a given lane/gate. Only the fields
 * isUserStuck reads (lane, workflowGate) matter here.
 * @param {import('../../lib/types.mjs').Lane} lane
 * @param {import('../../lib/types.mjs').WorkflowGate} gate
 * @returns {import('../../lib/types.mjs').TaskState}
 */
function stateAt(lane, gate) {
  return {
    taskId: 'task-131',
    lane,
    workflowGate: gate,
    artifactHashes: {},
    preImplStash: null,
    currentStep: 0,
    budget: 100,
    schemaVersion: 1,
  };
}

describe('subagentReturnPayload — matches the captured runSubagent fixture shape', () => {
  const captured = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'test', 'fixtures', 'hook-payloads', 'captured', 'posttooluse.run-subagent.json'),
      'utf8',
    ),
  );

  it('produces the exact key set of the captured PostToolUse subagent return', () => {
    // Deep-equal on KEYS, not "doesn't throw": the value of this helper is that a
    // scenario author never hand-guesses the wire shape. If the host adds or
    // renames a field, the captured fixture changes and this test fails loudly.
    const payload = subagentReturnPayload('router', {
      lane: 'feature',
      budgetClass: 'standard',
      confidence: 0.94,
    });
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(captured).sort());
  });

  it('carries the wire-critical constants the real hook path reads', () => {
    const payload = subagentReturnPayload('router', { lane: 'feature' });
    assert.equal(payload.tool_name, 'runSubagent');
    assert.equal(payload.hook_event_name, 'PostToolUse');
    // tool_input is elided to the literal "..." for runSubagent (captured fixture),
    // which is WHY identity cannot come from it.
    assert.equal(payload.tool_input, '...');
    assert.equal(typeof payload.tool_response, 'string');
  });

  it('embeds the contract as prose-then-JSON, and extractAgentResult reads it back', () => {
    // The real read path is lib/hooks/agent-result.mjs. Round-tripping through it
    // proves the payload is not just shaped like a fixture but actually parseable
    // the way the gate-advance hook parses it — prose before the JSON included.
    const payload = subagentReturnPayload('router', {
      lane: 'bug',
      budgetClass: 'standard',
      confidence: 0.9,
    });
    const text = /** @type {string} */ (payload.tool_response);
    assert.match(text, /Returning the router contract\./); // prose is present
    const extracted = extractAgentResult(text);
    assert.equal(extracted.agentName, 'router');
    assert.equal(extracted.result?.lane, 'bug');
    assert.equal(extracted.empty, false);
  });

  it('lets returnBody override the agentName argument, and honours a custom toolUseId', () => {
    const payload = subagentReturnPayload('router', { agentName: 'diagnose', bugScope: 'backend' }, {
      toolUseId: 'toolu_custom__vscode-9',
    });
    assert.equal(payload.tool_use_id, 'toolu_custom__vscode-9');
    assert.equal(extractAgentResult(/** @type {string} */ (payload.tool_response)).agentName, 'diagnose');
  });

  it('defaults tool_use_id to the host-appended __vscode suffix shape', () => {
    const payload = subagentReturnPayload('router', { lane: 'feature' });
    // resolveAgentName joins on `${agentId}__` — the default id must carry the suffix.
    assert.match(/** @type {string} */ (payload.tool_use_id), /__vscode-/);
  });
});

describe('isUserStuck — the stuck verdict against hand-built states', () => {
  it('is TRUE at impl-started when the forward events are treated as uncalled', () => {
    // The load-bearing case. At impl-started the only table moves are
    // pass-verification (forward) and the feature steering events (revise-scope,
    // re-plan, park, abandon). Feed a hand-built allowlist in which NONE of those
    // is fireable — the exact "steering/verification is dead code" world — and the
    // helper must report the user stuck. This is the check that would have caught
    // this epic's dead-code defect.
    assert.equal(isUserStuck(stateAt('feature', 'impl-started'), { fireableEvents: [] }), true);
  });

  it('flips to NOT stuck the instant one forward event becomes fireable', () => {
    // Proves the verdict is the intersection, not a constant: add pass-verification
    // to the allowlist and impl-started is no longer a dead end. Without this, a
    // helper that simply always returned true would pass the test above.
    assert.equal(
      isUserStuck(stateAt('feature', 'impl-started'), { fireableEvents: ['pass-verification'] }),
      false,
    );
  });

  it('is TRUE at impl-started under the real maintained allowlist', () => {
    // With the honest FIREABLE_EVENTS (which does NOT include pass-verification or
    // the steering events, because no hook-reachable caller fires them), the
    // feature lane really is wedged at impl-started on the current tree — exactly
    // what this detector exists to surface.
    assert.equal(isUserStuck(stateAt('feature', 'impl-started')), true);
    assert.ok(!FIREABLE_EVENTS.has(/** @type {any} */ ('pass-verification')));
    assert.ok(!FIREABLE_EVENTS.has(/** @type {any} */ ('revise-scope')));
  });

  it('is FALSE at the auto-advance gates a PostToolUse catch-up drives', () => {
    // no-lane → lane-set (set-lane), lane-set → discovery-done (finish-discovery),
    // etc. are all fired by advanceAlongLane once an agent returns evidence.
    for (const gate of /** @type {const} */ (['no-lane', 'lane-set', 'discovery-done', 'grill-done', 'plan-done'])) {
      assert.equal(isUserStuck(stateAt('feature', gate)), false, `feature ${gate} should not be stuck`);
    }
  });

  it('is FALSE at the human-approval gates a phrase advances', () => {
    // spec-draft ("approve spec") and verification-passed ("approve pr") move via a
    // gate-EDGE that carries no event; plan-approved ("approve plan"/draft-spec)
    // moves via an event. None is stuck.
    assert.equal(isUserStuck(stateAt('feature', 'spec-draft')), false);
    assert.equal(isUserStuck(stateAt('feature', 'verification-passed')), false);
    assert.equal(isUserStuck(stateAt('bug', 'plan-approved')), false);
    assert.equal(isUserStuck(stateAt('feature', 'plan-approved')), false);
    assert.equal(isUserStuck(stateAt('feature', 'spec-approved')), false);
  });

  it('is FALSE at a terminal gate — a legitimate END, not a dead end', () => {
    assert.equal(isUserStuck(stateAt('feature', 'done')), false);
    assert.equal(isUserStuck(stateAt('feature', 'abandoned')), false);
  });

  it('always honours human-approval gates even when the event allowlist is emptied', () => {
    // Narrowing the injected event allowlist must not make a human phrase vanish —
    // the human can still type "approve spec" at spec-draft.
    assert.equal(isUserStuck(stateAt('feature', 'spec-draft'), { fireableEvents: [] }), false);
  });
});

describe('runSession — a trivial two-turn scripted session through the real hooks', () => {
  it('bootstraps, advances on a router return, and holds a stable gate across turns', async () => {
    const ws = seedMonorootWorkspace();
    try {
      const results = await runSession(
        [
          {
            prompt: 'add pagination to the API',
            tools: [
              { toolName: 'router', subagentReturn: { lane: 'feature', budgetClass: 'standard', confidence: 0.94 } },
            ],
            expect: { gate: 'lane-set', notStuck: true },
          },
          {
            prompt: 'looks good so far',
            expect: { gate: 'lane-set', notStuck: true },
          },
        ],
        { hostCwd: ws.hostCwd, root: ws.root },
      );

      // The expectations above already asserted gate + notStuck per turn; here we
      // pin the TurnResult shape the driver returns for downstream scenarios.
      assert.equal(results.length, 2);

      const turn0 = results[0];
      assert.equal(turn0.prompt, 'add pagination to the API');
      assert.ok(turn0.hookOutputs.length > 0, 'a turn must record the hooks it ran');
      assert.ok(turn0.stateAfter, 'the session bootstrapped its own task state');
      assert.equal(turn0.gate, 'lane-set');
      assert.equal(turn0.stateAfter?.lane, 'feature');

      // The lane was set from the artifact the router return produced, not seeded.
      const routerResult = join(ws.root, '.devmate', 'state', 'router-result.json');
      assert.ok(readState(ws.root), 'task.json exists');
      assert.doesNotThrow(() => JSON.parse(readFileSync(routerResult, 'utf8')), 'router-result.json was written');

      assert.equal(results[1].gate, 'lane-set', 'a prompt with no evidence does not move the gate');
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });
});
