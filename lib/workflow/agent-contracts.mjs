// @ts-check
/**
 * The single owner of "what does each agent return, and which artifact does that
 * return become".
 *
 * Before this table, that question had three answers and they disagreed:
 *
 *   1. the agent card (`agents/rubber-duck.agent.md`) told the agent to nest its
 *      body under `report` and never mentioned `schemaVersion` or `returnedAt`;
 *   2. the validator (`validateGrillResult`) demanded a FLAT body carrying both;
 *   3. the projector (`projectWorkerReturn`) handed the validator the envelope.
 *
 * So an agent that obeyed its own card produced a return that failed validation on
 * ~11 fields, `grill-result.json` was never written, and the bug lane — whose only
 * pre-implementation transition is `lane-set --finish-grill--> grill-done` — could
 * never advance. The writer existed and was unreachable. CI stayed green the whole
 * time, because `scripts/check-contracts.mjs` validates that artifact only IF it is
 * already on disk, and nothing wrote it.
 *
 * The fix is not "correct the card". A card can drift again tomorrow. The fix is to
 * make the three answers ONE answer, and to make the tests enumerate THIS table —
 * so a new agent, mode, or artifact that has no working writer fails CI without
 * anyone remembering to write a test for it.
 *
 * Two rules encoded here:
 *
 *   - **The host owns the machine fields.** `taskId`, `schemaVersion` and
 *     `returnedAt` are facts the HOST knows (task state, a constant, its own clock)
 *     and the agent does not. Asking a language model to emit them is asking it to
 *     guess, and a wrong guess silently voided the artifact. They are listed in
 *     {@link MACHINE_FIELDS} and stamped by `lib/workflow/normalize-return.mjs`.
 *   - **`example` is what a COMPLIANT agent actually sends** — the shape its card
 *     documents, machine fields absent, prose stripped. It is not an idealized
 *     artifact. If `example` does not survive the projector, the agent cannot work,
 *     and that is exactly what `test/conformance/agent-contract-roundtrip.test.mjs`
 *     asserts for every entry below.
 */
import { parseRouterResult } from '../routing/router.mjs';
import { validateDiscoveryArtifact } from './agents/discovery.mjs';
import { validatePlannerArtifact } from './agents/planner.mjs';
import {
  validateCritiqueResult,
  validateDiagnosisResult,
  validateGrillResult,
} from './contracts.mjs';

/**
 * The fields the HOST stamps onto a worker's return, never the agent.
 *
 * `taskId` comes from task state, `schemaVersion` is a constant, and `returnedAt`
 * is the hook's injected clock. An agent has no reliable access to any of the
 * three, so requiring them of the agent made every contract a coin-flip.
 * @type {readonly string[]}
 */
export const MACHINE_FIELDS = Object.freeze(['taskId', 'schemaVersion', 'returnedAt']);

/**
 * @typedef {Object} AgentContract
 * @property {string} agentName   The `agentName` the worker reports (and the host resolves).
 * @property {string|null} mode   Discriminator when one agent returns several contracts (`rubber-duck`).
 * @property {string} artifact    Filename the return is projected onto, under `.devmate/state/`.
 * @property {(artifact: unknown) => { ok: boolean, errors: string[] }} validate
 * @property {boolean} stamped    Whether the host stamps {@link MACHINE_FIELDS} onto this contract.
 * @property {(taskId: string) => Record<string, unknown>} example
 *   A return a COMPLIANT agent sends, exactly as its card documents it.
 */

/**
 * Wrap the router's bespoke parser in the common validator shape, so the registry
 * has one signature and the tests do not special-case it.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateRouterResult(artifact) {
  const parsed = parseRouterResult(artifact);
  return parsed.ok ? { ok: true, errors: [] } : { ok: false, errors: [parsed.error] };
}

/**
 * Every agent whose return becomes a gate's evidence, keyed by contract id
 * (`<agent>` or `<agent>:<mode>`).
 *
 * @type {Readonly<Record<string, AgentContract>>}
 */
export const AGENT_CONTRACTS = Object.freeze({
  router: Object.freeze({
    agentName: 'router',
    mode: null,
    artifact: 'router-result.json',
    validate: validateRouterResult,
    // The router's contract carries no machine fields at all — it is the one
    // return the wire has actually confirmed (captured fixture), and it is flat.
    stamped: false,
    example: () => ({
      agentName: 'router',
      lane: 'bug',
      budgetClass: 'standard',
      confidence: 0.94,
    }),
  }),

  // The defect, in table form. This example is the shape `agents/rubber-duck.agent.md`
  // documents — `report`-nested, no `schemaVersion`, no `returnedAt` — and it is the
  // payload that produced NOTHING in the field, twice, on a real bug lane.
  'rubber-duck:grill': Object.freeze({
    agentName: 'rubber-duck',
    mode: 'grill',
    artifact: 'grill-result.json',
    validate: validateGrillResult,
    stamped: true,
    example: () => ({
      agentName: 'rubber-duck',
      status: 'ok',
      mode: 'grill',
      report: {
        assumptions: ['The internal-user check is the only gate on this view.'],
        missingRequirements: [],
        edgeCases: ['A user with no role claim at all.'],
        cornerCases: [],
        securityRisks: ['A non-internal user could read the protected content.'],
        uxRisks: [],
        blockingQuestions: [],
        recommendedDecisions: ['Fail closed when the role claim is absent.'],
        unverifiedItems: ['[UNVERIFIED] the claim shape in the auth token'],
      },
    }),
  }),

  'rubber-duck:critique': Object.freeze({
    agentName: 'rubber-duck',
    mode: 'critique',
    artifact: 'critique-result.json',
    validate: validateCritiqueResult,
    stamped: true,
    example: () => ({
      agentName: 'rubber-duck',
      status: 'ok',
      mode: 'critique',
      report: {
        missingAcceptanceCriteria: [],
        missingTests: ['No test covers the absent-claim path.'],
        riskySequencing: [],
        unlistedFiles: [],
        backwardsCompatRisks: [],
        rollbackRisk: 'low — a single guarded return',
        verdict: 'APPROVE_PLAN',
      },
    }),
  }),

  diagnose: Object.freeze({
    agentName: 'diagnose',
    mode: null,
    artifact: 'diagnosis.json',
    validate: validateDiagnosisResult,
    stamped: true,
    example: () => ({
      agentName: 'diagnose',
      bugScope: 'backend',
      suspectedLayer: 'repo-a/lib/cursor.mjs',
      reproCommand: 'npm test -- cursor',
      fixerRecommendation: 'clamp the batch cursor at the final page boundary',
      allowedPaths: ['repo-a/lib/cursor.mjs'],
      allowedGlobs: [],
    }),
  }),

  planner: Object.freeze({
    agentName: 'planner',
    mode: null,
    artifact: 'plan.json',
    validate: validatePlannerArtifact,
    stamped: true,
    example: () => ({
      agentName: 'planner',
      tasks: [
        {
          description: 'Fail closed when the role claim is absent',
          ac: ['A user with no role claim is denied'],
          tddApproach: 'Red: assert denial for a claimless user, then guard.',
          persona: 'backend',
          files: ['repo-a/lib/cursor.mjs'],
        },
      ],
      assumptions: [],
      openRisks: [],
      unverified: [],
    }),
  }),

  discovery: Object.freeze({
    agentName: 'discovery',
    mode: null,
    artifact: 'discovery-merged.json',
    validate: validateDiscoveryArtifact,
    stamped: true,
    example: () => ({
      agentName: 'discovery',
      claims: [
        { fact: 'The cursor is clamped in one place.', path: 'repo-a/lib/cursor.mjs', confidence: 'high' },
      ],
      unverified: ['[UNVERIFIED] whether any caller depends on the old overflow'],
    }),
  }),
});

/**
 * Every artifact an agent is capable of producing.
 *
 * Used to say WHICH file did not get written when a return fails to become
 * evidence. "Something went wrong" is what the old stderr line said; naming the
 * file is the difference between a message a model can act on and one it ignores.
 *
 * @param {string} agentName
 * @returns {string[]}
 */
export function artifactsFor(agentName) {
  return Object.values(AGENT_CONTRACTS)
    .filter((c) => c.agentName === agentName)
    .map((c) => c.artifact);
}

// A `contractFor(agentName, mode)` lookup lived here and had no callers: the
// projector discriminates grill-from-critique with the validators themselves. It also
// had the bug an unused function always has — it returned a `mode: null` contract
// before ever testing the mode, so an agent with both a default and a mode-specific
// contract would have been mis-routed. Dead code that is also wrong is exactly the
// shape of the defect this PR exists to kill, so it is gone rather than fixed. If a
// caller ever needs it, write it then, and test it then.
