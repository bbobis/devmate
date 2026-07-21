// @ts-check
/**
 * RC-4: an agent that produces NO canonical artifact by design must not be
 * treated as a failure.
 *
 * `fullstack`, `tech-design`, `ui-ux`, `security` and `spec-writer` have no
 * projection branch in `projectWorkerReturn` — their work is validated by the
 * orchestrator's dispatch-result path, not by the gate-advance projector. So each
 * falls through to `{ artifact: null, ... }`. The hook keyed its blocking
 * evidence-failure alert on `artifact === null`, so after a SUCCESSFUL
 * implementation/design/spec dispatch it told the orchestrator the agent "did not
 * satisfy its artifact" and to re-dispatch — a pervasive false signal that pushes
 * the orchestrator toward re-dispatch loops or doing the work inline.
 *
 * The fix marks the fallthrough `noProjector: true` and guards the alert on it.
 * This suite proves the five non-projecting agents now pass silently, and that a
 * genuine evidence failure from a projecting agent still blocks (the guard did not
 * go too far).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';

import { handlePostToolUse } from '../../hooks/gate-advance.mjs';

/** Collect everything a stream is given. */
function capture() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * A workspace with a task at a given gate.
 * @param {string} gate
 */
function workspace(gate) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-ga-noproj-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't1',
      lane: 'feature',
      workflowGate: gate,
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return root;
}

/**
 * A runSubagent PostToolUse event carrying an agent's return, in the shape the
 * host sends: prose with the contract JSON embedded in it.
 * @param {string} root
 * @param {unknown} result
 */
const subagentReturn = (root, result) => ({
  repoRoot: root,
  toolName: 'runSubagent',
  toolUseId: 'toolu_1',
  toolResponse: `Done.\n\n${JSON.stringify(result)}`,
});

/**
 * The five agents that project nothing, each with a minimal compliant return and
 * a representative gate they would legitimately return at.
 * @type {{ agentName: string, gate: string, result: Record<string, unknown> }[]}
 */
const NON_PROJECTING = [
  {
    agentName: 'fullstack',
    gate: 'impl-started',
    result: {
      agentName: 'fullstack',
      persona: 'backend',
      status: 'ok',
      payload: {
        verification: 'npm test — all green',
        changedFiles: ['lib/a.mjs', 'test/a.test.mjs'],
        summary: 'implemented AC1',
        completedAcIds: [1],
      },
    },
  },
  {
    agentName: 'tech-design',
    gate: 'discovery-done',
    result: { agentName: 'tech-design', status: 'ok', payload: { summary: 'design notes' } },
  },
  {
    agentName: 'ui-ux',
    gate: 'discovery-done',
    result: { agentName: 'ui-ux', status: 'ok', payload: { summary: 'ux notes' } },
  },
  {
    agentName: 'security',
    gate: 'impl-started',
    result: { agentName: 'security', status: 'ok', payload: { summary: 'no findings' } },
  },
  {
    agentName: 'spec-writer',
    gate: 'plan-done',
    result: {
      agentName: 'spec-writer',
      specPath: '.devmate/session/spec.md',
      metadata: {
        storedAt: '.devmate/session/spec.md',
        assumptions: ['[UNVERIFIED] the claim shape'],
        risks: ['[UNVERIFIED] rollback path'],
        specDigest: 'sha256-deadbeef',
      },
    },
  },
];

for (const { agentName, gate, result } of NON_PROJECTING) {
  test(`gate-advance/no-projector › @${agentName} returns benignly — no artifact, no alert`, async () => {
    const root = workspace(gate);
    const statePath = join(root, '.devmate', 'state', 'task.json');
    // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- bounded by this test's own fixture file, not runtime/user input.
    const before = readFileSync(statePath, 'utf8');
    const err = capture();
    const out = capture();
    try {
      const res = await handlePostToolUse(subagentReturn(root, result), {
        stdout: out.stream,
        stderr: err.stream,
      });

      // It projects no artifact...
      assert.equal(res.artifact, null, `@${agentName} should project no artifact`);
      // ...and that is NOT a failure: no blocking evidence-failure alert.
      assert.equal(
        res.alert,
        null,
        `@${agentName} produced a spurious blocking alert: ${res.alert}`,
      );

      // The stderr channel must not carry the evidence-FAILURE event for a
      // legitimate no-op (a benign `no_projector` info line is fine).
      assert.doesNotMatch(
        err.text(),
        /gate-advance\.no_projection\b/,
        `@${agentName} logged a no_projection failure: ${err.text()}`,
      );

      // The gate did not move and no state was clobbered.
      assert.equal(res.stateWritten, false, `@${agentName} should not write task state`);
      assert.equal(
        // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- bounded by this test's own fixture file, not runtime/user input.
        readFileSync(statePath, 'utf8'),
        before,
        `@${agentName} must leave task.json unchanged`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('gate-advance/no-projector › a projecting agent whose evidence is invalid STILL blocks', async () => {
  // The guard must not silence real failures. A rubber-duck grill missing a
  // required array is a genuine evidence failure (case D): artifact null, but
  // `noProjector` is falsy, so the blocking alert must still fire.
  const root = workspace('grill-done');
  const err = capture();
  const out = capture();
  try {
    const grillMissingUxRisks = {
      agentName: 'rubber-duck',
      mode: 'grill',
      assumptions: [],
      missingRequirements: [],
      edgeCases: [],
      cornerCases: [],
      securityRisks: [],
      // uxRisks omitted — invalid
      blockingQuestions: [],
      recommendedDecisions: [],
      unverifiedItems: [],
    };
    const res = await handlePostToolUse(subagentReturn(root, grillMissingUxRisks), {
      stdout: out.stream,
      stderr: err.stream,
    });

    assert.equal(res.artifact, null, 'an invalid grill writes no artifact');
    assert.notEqual(res.alert, null, 'a genuine evidence failure must still block the model');
    assert.match(String(res.alert), /uxRisks|does not satisfy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
