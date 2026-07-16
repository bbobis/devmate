// @ts-check

/**
 * E10-06: effort-scaling prompt assertions + fan-out bounding.
 *
 * The orchestrator is a markdown prompt, so the contract surface we validate
 * is the literal prompt body: an "Effort scaling" section must map each
 * budgetClass (tiny/standard/large) to a fan-out shape, state the
 * maximize-a-single-agent-first default, and name the sub-agent budget guard
 * as the hard ceiling. The companion suite asserts the partitioner's
 * parallelism ceiling actually bounds `large`-class decomposition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgent } from '../../lib/agent-validator.mjs';
import {
  MAX_PARALLEL_WORKSTREAMS,
  partitionWorkstreams,
  resolveMaxParallel,
} from '../../lib/workstream-partitioner.mjs';

/** @typedef {import('../../lib/types.mjs').PersonaEntry} PersonaEntry */

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, '../../agents/orchestrator.agent.md');

/**
 * Extract the body of a `## <heading>` section (up to the next `## `).
 * @param {string} body
 * @param {string} heading
 * @returns {string}
 */
function sectionOf(body, heading) {
  const parts = body.split(/\n## /);
  const match = parts.find((part) => part.startsWith(heading));
  return match ?? '';
}

describe('agents/orchestrator.agent.md — effort scaling (E10-06)', () => {
  const body = readFileSync(AGENT_PATH, 'utf8');
  const section = sectionOf(body, 'Effort scaling');

  it('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  it('has an "Effort scaling" section', () => {
    assert.ok(section !== '', 'orchestrator prompt must contain an "## Effort scaling" section');
  });

  it('keys the scaling rules on the budgetClass from the router result', () => {
    assert.match(section, /`budgetClass`/, 'scaling rules must be keyed on budgetClass');
  });

  it('maps tiny to a single persona with no parallel fan-out', () => {
    assert.match(section, /`tiny`[^\n]*single persona/i, 'tiny must map to a single persona');
    assert.match(section, /`tiny`[^\n]*skip parallel fan-out/i, 'tiny must skip parallel fan-out');
  });

  it('maps standard to the current partitioned dispatch', () => {
    assert.match(
      section,
      /`standard`[^\n]*partitioned dispatch/i,
      'standard must map to the current partitioned dispatch',
    );
  });

  it('maps large to a bounded workstream decomposition', () => {
    assert.match(
      section,
      /`large`[^\n]*bounded workstream decomposition/i,
      'large must map to a bounded workstream decomposition',
    );
    assert.match(
      section,
      /MAX_PARALLEL_WORKSTREAMS/,
      'large decomposition must cite the exported parallelism ceiling',
    );
    assert.match(section, /never unbounded/i, 'large decomposition must be explicitly bounded');
  });

  it('sizes only the parallel fan-out and never biases toward inline work', () => {
    assert.match(
      section,
      /minimize concurrent fan-out first/i,
      'effort scaling must minimize concurrent fan-out, not delegation itself',
    );
    assert.match(
      section,
      /never whether to delegate/i,
      'the section must state that scaling never governs whether to delegate',
    );
    assert.doesNotMatch(
      section,
      /maximize a single agent first/i,
      'the inline-biasing "maximize a single agent first" phrasing must be gone',
    );
  });

  it('names the sub-agent budget guard as the hard ceiling that scaling never raises', () => {
    assert.match(
      section,
      /subagent-budget-guard\.mjs/,
      'the budget guard module must be named as the hard ceiling',
    );
    assert.match(
      section,
      /never raises or bypasses/i,
      'scaling must be stated to propose within the ceiling, never raise it',
    );
  });

  it('requires dispatch-payload completeness for every dispatch', () => {
    assert.match(
      section,
      /`buildDispatchPayload`[^\n]*rejects/i,
      'the completeness rejection must be stated',
    );
  });

  it('scales the Step 2 discovery fan-out by budgetClass (FO-5: tiny never, standard 2, large 3)', () => {
    assert.match(
      section,
      /`tiny`\s*\nnever fans out/,
      'tiny must never fan out discovery workers',
    );
    assert.match(
      section,
      /`standard` dispatches K = 2 scoped discovery workers/,
      'standard must map to K = 2',
    );
    assert.match(section, /`large` dispatches K = 3/, 'large must map to K = 3');
    assert.match(
      section,
      /disjoint candidate partitions/,
      'partition disjointness must be stated',
    );
    assert.match(
      section,
      /sharing the `maxConcurrentAgents` ceiling with `@tech-design`/,
      'the shared ceiling must be stated',
    );
  });
});

describe('workstream-partitioner parallelism ceiling (E10-06)', () => {
  /** @type {PersonaEntry[]} */
  const personas = [
    {
      persona: 'backend',
      editableGlobs: ['src/main/**', 'lib/**'],
      offLimitsGlobs: ['src/ui/**'],
    },
    {
      persona: 'frontend',
      editableGlobs: ['src/ui/**'],
      offLimitsGlobs: ['src/main/**'],
    },
  ];
  const parallelInput = ['src/main/Service.java', 'src/ui/Button.tsx'];

  it('exports a finite integer ceiling of at least 1', () => {
    assert.ok(Number.isInteger(MAX_PARALLEL_WORKSTREAMS), 'ceiling must be an integer');
    assert.ok(MAX_PARALLEL_WORKSTREAMS >= 1, 'ceiling must allow at least one workstream');
  });

  it('resolveMaxParallel defaults to the exported ceiling', () => {
    assert.equal(resolveMaxParallel(), MAX_PARALLEL_WORKSTREAMS);
    assert.equal(resolveMaxParallel({}), MAX_PARALLEL_WORKSTREAMS);
  });

  it('default partition keeps parallel mode (no regression to standard-class dispatch)', () => {
    const result = partitionWorkstreams(parallelInput, personas);
    assert.equal(result.mode, 'parallel');
  });

  it('a ceiling below 2 downgrades parallel to sequential-backend-first (buckets unchanged)', () => {
    const bounded = partitionWorkstreams(parallelInput, personas, { maxParallel: 1 });
    assert.equal(bounded.mode, 'sequential-backend-first');
    const unbounded = partitionWorkstreams(parallelInput, personas);
    assert.deepEqual(bounded.backendFiles, unbounded.backendFiles);
    assert.deepEqual(bounded.frontendFiles, unbounded.frontendFiles);
    assert.deepEqual(bounded.sharedFiles, unbounded.sharedFiles);
  });

  it('a ceiling of 2 or more preserves parallel mode', () => {
    const result = partitionWorkstreams(parallelInput, personas, { maxParallel: 2 });
    assert.equal(result.mode, 'parallel');
  });

  it('sequential modes are unaffected by the ceiling', () => {
    const result = partitionWorkstreams(['src/main/Service.java'], personas, { maxParallel: 1 });
    assert.equal(result.mode, 'sequential-backend-first');
    const shared = partitionWorkstreams(['README.md'], personas, { maxParallel: 1 });
    assert.equal(shared.mode, 'sequential-shared-first');
  });

  it('an invalid explicit ceiling throws (contract violation, not silent fallback)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => partitionWorkstreams(parallelInput, personas, { maxParallel: bad }),
        /maxParallel must be an integer >= 1/,
      );
    }
  });
});
