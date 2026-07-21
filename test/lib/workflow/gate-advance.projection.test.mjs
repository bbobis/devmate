// @ts-check
/**
 * RC-4 (unit): `projectWorkerReturn` classifies its returns so the hook can tell a
 * benign no-op apart from a real evidence failure.
 *
 * - An agent with no projection branch (case C) returns `noProjector: true` — this
 *   is what lets the hook stay silent instead of raising a blocking alert.
 * - A projecting agent whose evidence fails validation (case D) returns
 *   `artifact: null` with `noProjector` FALSY — the hook must still block on it.
 *
 * If these two collapsed into one shape, the RC-4 guard would either re-block the
 * benign agents or silence the real failures. This suite pins them apart.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { projectWorkerReturn } from '../../../lib/workflow/gate-advance.mjs';

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'devmate-projection-'));
  dirs.push(root);
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  return root;
}

/** Minimal task state the projector reads. */
function taskState() {
  return /** @type {any} */ ({
    taskId: 't1',
    lane: 'feature',
    workflowGate: 'grill-done',
    currentStep: 0,
  });
}

test('projectWorkerReturn › a non-projecting agent returns noProjector: true (case C)', async () => {
  const root = workspace();
  const projected = await projectWorkerReturn(
    root,
    'fullstack',
    { agentName: 'fullstack', status: 'ok', payload: { summary: 'done' } },
    taskState(),
    null,
    '2026-07-20T00:00:00.000Z',
  );

  assert.equal(projected.artifact, null, 'a non-projecting agent writes no artifact');
  assert.equal(projected.noProjector, true, 'the fallthrough must flag itself as a no-projector');
  assert.match(String(projected.reason), /no projection for agent "fullstack"/);
});

test('projectWorkerReturn › a projecting agent\'s invalid evidence has noProjector falsy (case D)', async () => {
  const root = workspace();
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
  const projected = await projectWorkerReturn(
    root,
    'rubber-duck',
    grillMissingUxRisks,
    taskState(),
    null,
    '2026-07-20T00:00:00.000Z',
  );

  assert.equal(projected.artifact, null, 'invalid grill evidence writes no artifact');
  assert.ok(
    !projected.noProjector,
    'a genuine evidence failure must NOT be flagged as a no-projector, or the hook would silence it',
  );
  assert.match(String(projected.reason), /uxRisks/i);
});
