// @ts-check
/**
 * The guard must be able to go RED, and it must go red on the ACTUAL defect.
 *
 * A CI check nobody has watched fail is indistinguishable from a CI check that cannot
 * fail — and this repo has shipped eight layers that were "enforced" and never once
 * executed. The guard against that class does not get to join it. So these tests hand
 * it a broken graph and demand it complain.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkArtifactGraph } from '../../scripts/check-artifact-graph.mjs';

describe('check-artifact-graph', () => {
  it('passes on the real graph', () => {
    const report = checkArtifactGraph();
    assert.deepEqual(report.errors, [], 'the shipped workflow has an unreachable artifact');
    assert.ok(report.gates > 0, 'no gates were checked — the guard is inspecting nothing');
    assert.ok(report.contracts > 0, 'no contracts were checked — the guard is inspecting nothing');
  });

  it('fails when a gate requires an artifact no agent can produce', () => {
    // THE SHIPPED BUG, in graph form: `grill-done` demanded grill-result.json while
    // the only contract that could produce it was absent. The lane wedged and CI was
    // green. This is the assertion that turns that into a build failure.
    const report = checkArtifactGraph({
      gates: new Map([['grill-done', 'grill-result.json']]),
      contracts: { router: { artifact: 'router-result.json' } },
      projected: { router: 'router-result.json' },
    });

    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /grill-done/);
    assert.match(report.errors[0], /grill-result\.json/);
    assert.match(report.errors[0], /dead end/i);
  });

  it('fails when a contract declares an artifact no projection writes', () => {
    // The mirror image: an agent is promised that its return becomes an artifact, and
    // no writer ever places it. Every gate waiting on that file hangs forever.
    const report = checkArtifactGraph({
      gates: new Map(),
      contracts: { 'rubber-duck:grill': { artifact: 'grill-result.json' } },
      projected: { router: 'router-result.json' },
    });

    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /rubber-duck:grill/);
    assert.match(report.errors[0], /unreachable/i);
  });

  it('does not flag plan.json, which is written to the task-scoped session dir', () => {
    // A real writer that simply is not in PROJECTED_ARTIFACTS. A guard that cried wolf
    // here would be turned off within a week.
    const report = checkArtifactGraph({
      gates: new Map(),
      contracts: { planner: { artifact: 'plan.json' } },
      projected: {},
    });
    assert.deepEqual(report.errors, []);
  });
});
