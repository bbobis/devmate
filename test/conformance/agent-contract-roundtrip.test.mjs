// @ts-check
/**
 * CONFORMANCE: every agent's return, as its own card documents it, must survive the
 * projector and land as a VALID artifact.
 *
 * This is the test the repo did not have, and its absence is why the bug lane
 * shipped broken. `scripts/check-contracts.mjs` validates `grill-result.json` only
 * IF that file is already on disk — so when nothing could write it, there was
 * nothing to validate, and CI was green. A guard that can only inspect an artifact
 * that exists cannot notice an artifact that can never exist.
 *
 * So this suite asserts the one thing that actually matters: feed the projector the
 * payload a COMPLIANT agent sends, and demand the artifact appear. It enumerates
 * `AGENT_CONTRACTS` rather than a hand-written list, so a new agent or mode added
 * without a working writer fails here without anyone remembering to extend this
 * file.
 *
 * On the broken code this suite is RED for `rubber-duck:grill` and
 * `rubber-duck:critique` (the card nests the body under `report`, the validator
 * wants it flat) and GREEN for `router` and `diagnose` (their cards are flat) —
 * reproducing exactly which agents worked in the field and which produced silence.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AGENT_CONTRACTS, MACHINE_FIELDS } from '../../lib/workflow/agent-contracts.mjs';
import { PROJECTED_ARTIFACTS, projectWorkerReturn } from '../../lib/workflow/gate-advance.mjs';
import { persistWorkerReturn } from '../../lib/workflow/persist-worker-return.mjs';

const TASK_ID = 'task-roundtrip-1';
const NOW = '2026-07-13T12:00:00.000Z';

/** @type {string[]} */
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace with the state dir the projector writes into, and nothing else.
 * Seeding artifacts here would let a test pass against a writer that never ran.
 * @returns {string}
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'contract-roundtrip-'));
  dirs.push(root);
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  return root;
}

/** Minimal task state: the projector reads only `taskId`, `lane`, `outputContract`. */
function taskState() {
  return /** @type {any} */ ({
    taskId: TASK_ID,
    lane: 'bug',
    workflowGate: 'lane-set',
    currentStep: 0,
  });
}

/**
 * Where an artifact actually lands. `plan.json` is task-scoped under `session/`;
 * every other projection is flat under `state/`.
 * @param {string} root
 * @param {string} artifact
 * @returns {string}
 */
function artifactPath(root, artifact) {
  return artifact === 'plan.json'
    ? join(root, '.devmate', 'session', TASK_ID, artifact)
    : join(root, '.devmate', 'state', artifact);
}

/**
 * Run one agent's return through the real projector.
 * @param {import('../../lib/workflow/agent-contracts.mjs').AgentContract} contract
 * @param {Record<string, unknown>} result
 */
async function project(contract, result) {
  const root = workspace();

  // The discovery projection is a fan-IN: it re-merges every persisted discovery
  // return rather than reading the one in hand. Persisting first is not test
  // scaffolding — it is how the real hook feeds it.
  if (contract.agentName === 'discovery') {
    await persistWorkerReturn(root, {
      agentName: 'discovery',
      toolUseId: 'toolu_discovery_1',
      result,
    });
  }

  const projected = await projectWorkerReturn(
    root,
    contract.agentName,
    result,
    taskState(),
    null,
    NOW,
  );
  return { root, projected };
}

/** @param {string} path */
function readArtifact(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

for (const [id, contract] of Object.entries(AGENT_CONTRACTS)) {
  describe(`conformance — ${id} return -> ${contract.artifact}`, () => {
    it('projects a compliant agent return into a valid artifact', async () => {
      const example = contract.example(TASK_ID);
      const { root, projected } = await project(contract, example);

      // The failure that shipped: `artifact` is null and `reason` explains why — on
      // a stderr channel the model never saw. Surface the reason here, because
      // "grill-result.json is missing" is the symptom, not the cause.
      assert.equal(
        projected.artifact,
        contract.artifact,
        `@${contract.agentName} returned exactly what a compliant agent sends and NOTHING was written.\n` +
          `  reason: ${projected.reason}\n` +
          `  This is an unreachable writer: the gate that requires ${contract.artifact} can never advance.`,
      );

      const path = artifactPath(root, contract.artifact);
      assert.ok(existsSync(path), `${contract.artifact} was reported written but is not on disk`);

      const verdict = contract.validate(readArtifact(path));
      assert.ok(
        verdict.ok,
        `${contract.artifact} landed but does not satisfy its own validator: ${verdict.errors.join('; ')}`,
      );
    });

    if (contract.stamped) {
      it('is stamped by the host, so the agent never has to guess taskId/schemaVersion/returnedAt', async () => {
        // These are facts the HOST holds — task state, a constant, a clock — and the
        // agent does not. Requiring them of the agent made every artifact a
        // coin-flip: one forgotten field and the whole return was silently voided.
        // The compliant example carries NONE of them; the projector must supply all
        // three, and `returnedAt` must come from the injected clock, not a real one.
        const { root } = await project(contract, contract.example(TASK_ID));
        const artifact = readArtifact(artifactPath(root, contract.artifact));

        for (const field of MACHINE_FIELDS) {
          assert.ok(
            Object.hasOwn(artifact, field),
            `the host did not stamp ${field} — the agent would have to know it`,
          );
        }
        assert.equal(artifact.taskId, TASK_ID);
        assert.equal(artifact.schemaVersion, 1);
        assert.equal(
          artifact.returnedAt,
          NOW,
          'returnedAt must come from the injected clock — a wall-clock read here is non-deterministic and unsnapshotable',
        );
      });
    }
  });
}

describe('conformance — the registry is the whole roster', () => {
  it('every projected artifact has a declared contract', () => {
    // A projection branch with no contract entry is a writer nobody tests. That is
    // precisely how the grill branch survived: reachable-looking code, never once
    // exercised with a payload a real agent sends.
    const declared = new Set(Object.values(AGENT_CONTRACTS).map((c) => c.artifact));
    for (const artifact of Object.values(PROJECTED_ARTIFACTS)) {
      assert.ok(
        declared.has(artifact),
        `${artifact} is projected by gate-advance but declared by no agent contract — add it to AGENT_CONTRACTS so it is round-trip tested`,
      );
    }
  });

  it('every declared contract is actually projected', () => {
    // The mirror image: a contract nothing projects is a promise to an agent that
    // the workflow does not keep.
    const projected = new Set(/** @type {string[]} */ (Object.values(PROJECTED_ARTIFACTS)));
    // plan.json is task-scoped under session/ and so is not in PROJECTED_ARTIFACTS.
    projected.add('plan.json');
    for (const [id, contract] of Object.entries(AGENT_CONTRACTS)) {
      assert.ok(
        projected.has(contract.artifact),
        `contract "${id}" declares ${contract.artifact}, which no projection writes`,
      );
    }
  });
});
