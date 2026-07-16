// @ts-check
/**
 * CI guard: no gate may require an artifact that nothing can produce.
 *
 * This is the check that would have caught the defect this script was written for,
 * and it is the check the repo could not previously make.
 *
 * `scripts/check-contracts.mjs` validates `grill-result.json` — **if it finds one on
 * disk**. Nothing could write it, so there was never one to find, so the check passed
 * and CI was green while the bug lane was a dead end: `grill-done` demanded an
 * artifact whose only writer (`projectWorkerReturn`'s rubber-duck branch) could never
 * fire, because the shape it validated was not the shape the agent card told the
 * agent to send. Existence-checking a file cannot detect a file that can never exist.
 *
 * So this guard reasons over the GRAPH instead, from declarations rather than from
 * disk:
 *
 *   gate  --requires-->  artifact  --produced by-->  agent contract  --written by--> projector
 *
 * and fails the build on any broken edge. It needs no session, no fixture, and no
 * artifact to have been written — which is precisely why it can see an unreachable
 * writer, and `check-contracts` cannot.
 *
 * The round-trip conformance suite
 * (`test/conformance/agent-contract-roundtrip.test.mjs`) proves the last edge holds
 * for a payload a real agent sends. Together they close the loop: this proves the
 * edges EXIST, that proves they WORK.
 */
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { gateRequiredArtifacts } from '../lib/gate-preconditions.mjs';
import { AGENT_CONTRACTS } from '../lib/workflow/agent-contracts.mjs';
import { PROJECTED_ARTIFACTS } from '../lib/workflow/gate-advance.mjs';

/**
 * Artifacts written to the task-scoped session dir rather than projected flat into
 * `.devmate/state/`. They have a writer; it just is not in `PROJECTED_ARTIFACTS`.
 * @type {ReadonlySet<string>}
 */
const SESSION_SCOPED = new Set(['plan.json']);

/**
 * @typedef {Object} GraphReport
 * @property {string[]} errors
 * @property {number} gates      Gates whose evidence was checked.
 * @property {number} contracts  Agent contracts checked.
 */

/**
 * Walk the artifact graph and collect every broken edge.
 *
 * The graph is injected rather than imported at the call site so the guard can be
 * shown to FAIL on a broken graph. A CI check nobody has ever seen go red is just
 * another layer asserted to work — which is the exact species of bug this guard
 * exists to catch, and it does not get to be one itself.
 *
 * @param {{
 *   contracts?: Record<string, { artifact: string }>,
 *   gates?: ReadonlyMap<string, string>,
 *   projected?: Record<string, string>,
 * }} [graph]
 * @returns {GraphReport}
 */
export function checkArtifactGraph(graph = {}) {
  /** @type {string[]} */
  // @bounded-alloc — at most one error per gate plus one per contract.
  const errors = [];

  const AGENT_CONTRACTS_IN = graph.contracts ?? AGENT_CONTRACTS;
  const PROJECTED_IN = graph.projected ?? PROJECTED_ARTIFACTS;

  const producible = new Set(Object.values(AGENT_CONTRACTS_IN).map((c) => c.artifact));
  const gates = graph.gates ?? gateRequiredArtifacts();

  // Edge 1: every artifact a gate demands must be one some agent can produce.
  // A gate requiring an artifact no contract declares is a DEAD END — the workflow
  // can never get past it, whatever the agents do.
  for (const [gate, artifact] of gates) {
    if (!producible.has(artifact)) {
      errors.push(
        `gate "${gate}" requires ${artifact}, which no agent contract produces — the gate is a dead end. ` +
          `Declare a contract for it in lib/workflow/agent-contracts.mjs, or stop requiring it.`,
      );
    }
  }

  // Edge 2: every declared contract must have a writer that actually places its
  // artifact. A contract whose artifact no projection writes is a promise to an agent
  // that the workflow does not keep.
  const written = new Set(/** @type {string[]} */ (Object.values(PROJECTED_IN)));
  for (const [id, contract] of Object.entries(AGENT_CONTRACTS_IN)) {
    if (!written.has(contract.artifact) && !SESSION_SCOPED.has(contract.artifact)) {
      errors.push(
        `contract "${id}" declares ${contract.artifact}, but no projection in lib/workflow/gate-advance.mjs writes it — ` +
          `the writer is unreachable and every gate that waits on it will hang.`,
      );
    }
  }

  return { errors, gates: gates.size, contracts: Object.keys(AGENT_CONTRACTS_IN).length };
}

/**
 * CI entrypoint (CONTRIBUTING §6).
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  const report = checkArtifactGraph();

  if (report.errors.length > 0) {
    process.stderr.write('check-artifact-graph: the workflow contains an unreachable artifact.\n\n');
    for (const error of report.errors) process.stderr.write(`  - ${error}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `check-artifact-graph: ok — ${report.gates} gate(s) and ${report.contracts} contract(s), every artifact reachable.\n`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
