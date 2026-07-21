// @ts-check
/**
 * RC-1 drift guard: the orchestrator card must enumerate the FULL grill contract.
 *
 * The orchestrator builds the grill prompt by paraphrasing its own card. When that
 * card listed only a subset of the nine `GrillResult` arrays, the return it produced
 * failed `validateGrillResult`, `grill-result.json` was never written, and the gate
 * stalled at `discovery-done` with `approve spec` refused. The card, the validator,
 * the rubber-duck card, and the contract registry must all agree on the same nine
 * fields.
 *
 * This test derives the canonical field set from the `rubber-duck:grill` contract
 * example (the registry — not a hand-copied literal) so it tracks the source of
 * truth automatically, and asserts every field appears in BOTH the feature-lane and
 * bug-lane grill steps of the orchestrator card. It is RED on the pre-fix card
 * (feature listed 6 of 9, bug 5 of 9) and GREEN once both enumerate all nine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { AGENT_CONTRACTS } from '../lib/workflow/agent-contracts.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORCHESTRATOR_PATH = join(REPO_ROOT, 'agents', 'orchestrator.agent.md');

/** The canonical nine grill fields, from the registry's own compliant example. */
const GRILL_FIELDS = Object.keys(
  /** @type {{ report: Record<string, unknown> }} */ (AGENT_CONTRACTS['rubber-duck:grill'].example('t1'))
    .report,
);

/**
 * Extract each grill step's prose from the orchestrator card. Both the feature-lane
 * and bug-lane steps open with the dispatch line "Dispatch `@rubber-duck` with
 * `mode=grill`" and close (lazily) at the next `grill_complete` trace event, so each
 * match is exactly the field enumeration a reader (or the orchestrator) would build
 * the grill from. The `mode=critique` dispatch does not match, and a grill step that
 * never reaches a `grill_complete` simply does not match — the count assertion in the
 * caller catches the shortfall.
 * @param {string} doc
 * @returns {string[]}
 */
function grillSections(doc) {
  const re = /Dispatch `@rubber-duck` with `mode=grill`[\s\S]*?`grill_complete`/g;
  return [...doc.matchAll(re)].map((m) => m[0]);
}

test('docs-sync/grill-contract › the registry example carries exactly the nine known grill fields', () => {
  // Guards the test itself: if the contract example drifts, the canonical set this
  // suite enforces drifts with it — surface that here rather than silently.
  assert.deepEqual(
    [...GRILL_FIELDS].sort(),
    [
      'assumptions',
      'blockingQuestions',
      'cornerCases',
      'edgeCases',
      'missingRequirements',
      'recommendedDecisions',
      'securityRisks',
      'unverifiedItems',
      'uxRisks',
    ],
    'the rubber-duck:grill contract example must enumerate the nine GrillResult arrays',
  );
});

test('docs-sync/grill-contract › both orchestrator grill steps enumerate all nine fields', () => {
  const doc = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const sections = grillSections(doc);

  // Feature lane and bug lane each dispatch a grill — expect both.
  assert.equal(
    sections.length,
    2,
    `expected a grill step in the feature and bug lanes; found ${sections.length}`,
  );

  sections.forEach((section, i) => {
    for (const field of GRILL_FIELDS) {
      assert.ok(
        section.includes(`\`${field}\``),
        `grill step ${i + 1} of the orchestrator card omits \`${field}\` — a grill built ` +
          `from this list fails validateGrillResult and stalls the gate. Section was:\n${section}`,
      );
    }
  });
});

test('docs-sync/grill-contract › the grill steps point to the contract authority, not a restated list', () => {
  const doc = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  for (const section of grillSections(doc)) {
    assert.ok(
      section.includes('rubber-duck.agent.md') && section.includes('agent-contracts.mjs'),
      'each grill step must reference the owning contract (rubber-duck.agent.md + ' +
        'agent-contracts.mjs) so the enumeration cannot silently re-drift',
    );
    assert.ok(
      section.includes('[UNVERIFIED]'),
      'each grill step must state the [UNVERIFIED] prefix rule for unverifiedItems',
    );
  }
});
