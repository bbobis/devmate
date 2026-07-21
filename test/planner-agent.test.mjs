// @ts-check

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPlannerArtifact,
  validatePlannerArtifact,
} from '../lib/workflow/agents/planner.mjs';
import { assertDispatchResult } from '../lib/workflow/orchestrator.mjs';
import {
  parseAgentFrontmatter,
  extractBodyClaims,
  validateAgent,
} from '../lib/agent-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, '../agents/planner.agent.md');

// ============================================================================
// Unit tests: artifact creation and validation
// ============================================================================

test('createPlannerArtifact / returns typed sections and normalized unverified markers', () => {
  const artifact = createPlannerArtifact({
    tasks: [
      {
        description: 'Create API endpoint',
        ac: ['Endpoint responds to POST /api/orders', 'Response includes order ID'],
        tddApproach: 'Unit test via jest; integration test via supertest',
        persona: 'backend',
        files: ['src/api/orders.ts', 'src/api/orders.test.ts'],
      },
    ],
    assumptions: ['legacy auth token remains compatible'],
    openRisks: ['[UNVERIFIED] cache invalidation strategy not finalized'],
  });

  assert.equal(Array.isArray(artifact.tasks), true);
  assert.equal(Array.isArray(artifact.assumptions), true);
  assert.equal(Array.isArray(artifact.openRisks), true);
  assert.equal(Array.isArray(artifact.unverified), true);

  assert.equal(artifact.tasks[0]?.description, 'Create API endpoint');
  assert.equal(artifact.tasks[0]?.ac.length, 2);
  assert.equal(artifact.tasks[0]?.tddApproach, 'Unit test via jest; integration test via supertest');
  assert.equal(artifact.tasks[0]?.persona, 'backend');
  assert.equal(artifact.tasks[0]?.files.length, 2);

  assert.equal(artifact.assumptions[0]?.startsWith('[UNVERIFIED]'), true);
  assert.equal(artifact.openRisks[0]?.startsWith('[UNVERIFIED]'), true);
  assert.equal(artifact.unverified.length, 2);
});

test('createPlannerArtifact / provides default sections when omitted', () => {
  const artifact = createPlannerArtifact({});

  assert.equal(Array.isArray(artifact.tasks), true);
  assert.equal(Array.isArray(artifact.assumptions), true);
  assert.equal(Array.isArray(artifact.openRisks), true);
  assert.equal(Array.isArray(artifact.unverified), true);

  assert.equal(artifact.tasks.length, 0);
  assert.equal(artifact.assumptions.length, 0);
  assert.equal(artifact.openRisks.length, 0);
  assert.equal(artifact.unverified.length, 0);
});

test('createPlannerArtifact / normalizes unverified markers and drops empty strings', () => {
  const artifact = createPlannerArtifact({
    tasks: [
      {
        description: 'Task 1',
        ac: ['AC1', '', 'AC2'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: ['file1.ts', '', 'file2.ts'],
      },
    ],
    assumptions: ['assumption without tag', '  ', 'another assumption'],
    openRisks: ['[UNVERIFIED] already tagged', 'risk without tag'],
  });

  assert.equal(artifact.tasks[0]?.ac.length, 2);
  assert.equal(artifact.tasks[0]?.files.length, 2);
  assert.equal(artifact.assumptions.length, 2);
  assert.equal(artifact.assumptions.every((a) => a.startsWith('[UNVERIFIED]')), true);
  assert.equal(artifact.openRisks.length, 2);
  assert.equal(artifact.openRisks.every((r) => r.startsWith('[UNVERIFIED]')), true);
  assert.equal(artifact.unverified.length, 4);
});

test('validatePlannerArtifact / accepts valid artifact', () => {
  const artifact = createPlannerArtifact({
    tasks: [
      {
        description: 'Implement feature',
        ac: ['AC1', 'AC2'],
        tddApproach: 'Jest unit tests',
        persona: 'backend',
        files: ['src/feature.ts'],
        alignment: [
          {
            capability: 'feature guard',
            decision: 'add',
            target: null,
            usageEvidence: [],
            patternRefs: ['src/feature.ts:1'],
            reason: 'no existing capability to reuse',
          },
        ],
      },
    ],
    assumptions: ['auth remains stable'],
    openRisks: ['performance impact unclear'],
  });

  const verdict = validatePlannerArtifact(artifact);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test('validatePlannerArtifact / rejects non-object artifact', () => {
  const verdict = validatePlannerArtifact(null);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length > 0, true);
  assert.equal(verdict.errors[0], 'artifact must be an object');
});

test('validatePlannerArtifact / rejects missing or empty tasks array', () => {
  let verdict = validatePlannerArtifact({
    tasks: [],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks must be a non-empty array')), true);

  verdict = validatePlannerArtifact({
    tasks: 'not an array',
    assumptions: [],
    openRisks: [],
    unverified: [],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks must be an array')), true);
});

test('validatePlannerArtifact / rejects task with missing description', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: '',
        ac: ['AC1'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].description')), true);
});

test('validatePlannerArtifact / rejects task with empty ac array', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: [],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].ac must be a non-empty array')), true);
});

test('validatePlannerArtifact / rejects task with missing tddApproach', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: '',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].tddApproach')), true);
});

test('validatePlannerArtifact / rejects task with missing persona', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: 'Approach',
        persona: '',
        files: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].persona')), true);
});

test('validatePlannerArtifact / rejects assumptions missing [UNVERIFIED] tag', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: ['untagged assumption'],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('assumptions[0] must start with [UNVERIFIED]')), true);
});

test('validatePlannerArtifact / rejects openRisks missing [UNVERIFIED] tag', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: ['[UNVERIFIED] assumption'],
    openRisks: ['risk without tag'],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('openRisks[0] must start with [UNVERIFIED]')), true);
});

test('validatePlannerArtifact / rejects unverified missing [UNVERIFIED] tag', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: ['[UNVERIFIED] assumption'],
    openRisks: ['[UNVERIFIED] risk'],
    unverified: ['untagged'],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('unverified[0] must start with [UNVERIFIED]')), true);
});

test('validatePlannerArtifact / rejects task with invalid ac entries', () => {
  const verdict = validatePlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1', '', 'AC3'],
        tddApproach: 'Approach',
        persona: 'backend',
        files: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].ac[1]')), true);
});

// ============================================================================
// Unit tests: codebase-alignment contract (#238)
// ============================================================================

/**
 * Build a validator-valid single-task artifact, overriding the task's
 * `alignment` with the caller-supplied value.
 * @param {unknown} alignment
 * @returns {Record<string, unknown>}
 */
function planWithAlignment(alignment) {
  return {
    tasks: [
      {
        description: 'Implement feature',
        ac: ['AC1'],
        tddApproach: 'Red first',
        persona: 'backend',
        files: ['src/feature.mjs'],
        alignment,
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  };
}

test('validatePlannerArtifact / rejects task with missing alignment', () => {
  const artifact = planWithAlignment(undefined);
  const verdict = validatePlannerArtifact(artifact);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('tasks[0].alignment must be an array')), true);
});

test('validatePlannerArtifact / rejects task with empty alignment array', () => {
  const verdict = validatePlannerArtifact(planWithAlignment([]));
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.errors.some((e) => e.includes('tasks[0].alignment must be a non-empty array')),
    true,
  );
});

test('validatePlannerArtifact / rejects reuse decision without a target', () => {
  const verdict = validatePlannerArtifact(
    planWithAlignment([
      {
        capability: 'hash persistence',
        decision: 'reuse',
        target: null,
        usageEvidence: ['lib/task-state.mjs:1'],
        patternRefs: [],
        reason: 'reuse the existing writer',
      },
    ]),
  );
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.errors.some((e) => e.includes('reuse requires target.symbol and target.path')),
    true,
  );
});

test('validatePlannerArtifact / rejects reuse decision without usageEvidence', () => {
  const verdict = validatePlannerArtifact(
    planWithAlignment([
      {
        capability: 'hash persistence',
        decision: 'reuse',
        target: { symbol: 'recordArtifactHash', path: 'lib/task-state.mjs' },
        usageEvidence: [],
        patternRefs: [],
        reason: 'reuse the existing writer',
      },
    ]),
  );
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.errors.some((e) => e.includes('reuse requires at least one usageEvidence pointer')),
    true,
  );
});

test('validatePlannerArtifact / rejects add decision without patternRefs', () => {
  const verdict = validatePlannerArtifact(
    planWithAlignment([
      {
        capability: 'role-claim guard',
        decision: 'add',
        target: null,
        usageEvidence: [],
        patternRefs: [],
        reason: 'no existing guard',
      },
    ]),
  );
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.errors.some((e) => e.includes('add requires at least one patternRefs pointer')),
    true,
  );
});

test('validatePlannerArtifact / rejects an unknown decision value', () => {
  const verdict = validatePlannerArtifact(
    planWithAlignment([
      {
        capability: 'x',
        decision: 'refactor',
        target: null,
        usageEvidence: [],
        patternRefs: ['lib/x.mjs:1'],
        reason: 'y',
      },
    ]),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some((e) => e.includes('decision must be one of')), true);
});

test('validatePlannerArtifact / accepts a well-formed mixed reuse+add alignment', () => {
  const verdict = validatePlannerArtifact(
    planWithAlignment([
      {
        capability: 'artifact hash persistence',
        decision: 'reuse',
        target: { symbol: 'recordArtifactHash', path: 'lib/task-state.mjs' },
        usageEvidence: ['lib/workflow/agents/planner.mjs:321'],
        patternRefs: [],
        reason: 'existing helper already writes artifactHashes[name]',
      },
      {
        capability: 'role-claim guard',
        decision: 'add',
        target: null,
        usageEvidence: [],
        patternRefs: ['src/cursor.mjs:44'],
        reason: 'no existing guard for the absent-claim path',
      },
    ]),
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test('createPlannerArtifact / round-trips alignment and drops malformed entries', () => {
  const artifact = createPlannerArtifact({
    tasks: [
      {
        description: 'Task',
        ac: ['AC1'],
        tddApproach: 'Red first',
        persona: 'backend',
        files: ['src/feature.mjs'],
        alignment: [
          {
            capability: 'guard',
            decision: 'add',
            target: null,
            usageEvidence: [],
            patternRefs: ['src/feature.mjs:1'],
            reason: 'no existing capability',
          },
          // malformed (non-object) — dropped by normalizeAlignment
          'not an object',
        ],
      },
    ],
  });

  assert.equal(artifact.tasks[0]?.alignment.length, 1);
  assert.equal(artifact.tasks[0]?.alignment[0]?.decision, 'add');
  assert.equal(validatePlannerArtifact(artifact).ok, true);
});

// ============================================================================
// Integration tests: dispatch guard
// ============================================================================

test('integration / planner artifact satisfies orchestrator dispatch guard', () => {
  const payload = createPlannerArtifact({
    tasks: [
      {
        description: 'Implement login',
        ac: ['User can log in', 'Session persists'],
        tddApproach: 'Jest + supertest',
        persona: 'fullstack',
        files: ['src/login.ts'],
        alignment: [
          {
            capability: 'login handler',
            decision: 'add',
            target: null,
            usageEvidence: [],
            patternRefs: ['src/login.ts:1'],
            reason: 'no existing capability to reuse',
          },
        ],
      },
    ],
    assumptions: ['LDAP integration exists'],
    openRisks: ['password reset flow undefined'],
  });

  const dispatchVerdict = assertDispatchResult('planner', {
    status: 'ok',
    payload,
  });

  assert.equal(dispatchVerdict.ok, true);
});

test('integration / malformed planner payload fails orchestrator guard', () => {
  const dispatchVerdict = assertDispatchResult('planner', {
    status: 'ok',
    payload: { implementation: ['step 1', 'step 2'] },
  });

  assert.equal(dispatchVerdict.ok, false);
  const message = dispatchVerdict.error ?? '';
  assert.equal(message.includes('planner'), true);
  assert.equal(message.includes('tasks'), true);
});

// ============================================================================
// Integration tests: revision loop (rubber-duck cycle simulation)
// ============================================================================

test('integration / planner artifact remains valid across revision cycle', () => {
  const planV1 = createPlannerArtifact({
    tasks: [
      {
        description: 'Create API',
        ac: ['Endpoint exists'],
        tddApproach: 'Jest',
        persona: 'backend',
        files: ['src/api.ts'],
        alignment: [
          {
            capability: 'api endpoint',
            decision: 'add',
            target: null,
            usageEvidence: [],
            patternRefs: ['src/api.ts:1'],
            reason: 'no existing capability to reuse',
          },
        ],
      },
    ],
    assumptions: ['Node 24+ available'],
    openRisks: ['database migration timing'],
  });

  const v1Verdict = validatePlannerArtifact(planV1);
  assert.equal(v1Verdict.ok, true);

  // Simulate rubber-duck critique feedback: add more detail to TDD approach
  const planV2 = createPlannerArtifact({
    tasks: [
      {
        description: 'Create API',
        ac: ['Endpoint exists', 'Response format correct', 'Error handling works'],
        tddApproach: 'Unit test: jest; Integration test: supertest with mock DB; E2E: playwright',
        persona: 'backend',
        files: ['src/api.ts', 'src/api.test.ts', 'e2e/api.spec.ts'],
        alignment: [
          {
            capability: 'api endpoint',
            decision: 'add',
            target: null,
            usageEvidence: [],
            patternRefs: ['src/api.ts:1'],
            reason: 'no existing capability to reuse',
          },
        ],
      },
    ],
    assumptions: ['Node 24+ available', 'PostgreSQL 14+ available'],
    openRisks: ['database migration timing', '[UNVERIFIED] backup strategy for cutover'],
  });

  const v2Verdict = validatePlannerArtifact(planV2);
  assert.equal(v2Verdict.ok, true);
  assert.equal(planV2.tasks[0]?.ac.length, 3);
  assert.equal(planV2.assumptions.length, 2);
});

// ============================================================================
// Agent file validation tests
// ============================================================================

describe('agents/planner.agent.md', () => {
  test('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  test('frontmatter has no write- or execute-class tools (read-only contract)', () => {
    const fm = parseAgentFrontmatter(readFileSync(AGENT_PATH, 'utf8'));
    const forbidden = ['edit', 'edit/file', 'create/file', 'execute', 'run/terminal'];
    for (const t of forbidden) {
      assert.ok(
        !fm.tools.includes(t),
        `planner must not declare '${t}'; declared tools: ${JSON.stringify(fm.tools)}`,
      );
    }
  });

  test('frontmatter declares only read-only tools (subset of allowed list)', () => {
    const fm = parseAgentFrontmatter(readFileSync(AGENT_PATH, 'utf8'));
    const allowed = new Set(['search/codebase', 'search/usages', 'read', 'read/problems']);
    for (const t of fm.tools) {
      assert.ok(
        allowed.has(t),
        `unexpected tool '${t}' in planner frontmatter; allowed: ${JSON.stringify(Array.from(allowed))}`,
      );
    }
    assert.ok(fm.tools.length > 0, 'planner must declare at least one read-only tool');
  });

  test('body contains no writes-files or runs-checks claims', () => {
    const claims = extractBodyClaims(readFileSync(AGENT_PATH, 'utf8'));
    const offending = claims.filter((c) => c.type === 'writes-files' || c.type === 'runs-checks');
    assert.deepEqual(
      offending,
      [],
      `planner body must stay read-only; found claims: ${JSON.stringify(offending)}`,
    );
  });

  test('body documents tddApproach and per-AC test mapping', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.match(body, /tddApproach/i, 'body must document tddApproach');
    assert.match(body, /acceptance criteria/i, 'body must document acceptance criteria');
    assert.match(body, /test/i, 'body must discuss testing strategy');
  });

  test('body documents the unresolved-item discipline (assumptions + openRisks)', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.match(body, /\[UNVERIFIED\]/i, 'body must reference [UNVERIFIED] tagging');
    assert.match(body, /assumptions|openRisks/i, 'body must reference assumptions or openRisks');
    assert.match(body, /hand-wav|unresolved/i, 'body must forbid hand-waving on unresolved items');
  });

  test('body documents rubber-duck critique as the downstream gate', () => {
    const body = readFileSync(AGENT_PATH, 'utf8');
    assert.match(body, /rubber-duck|critique/i, 'body must reference rubber-duck critique');
    assert.match(
      body,
      /REQUEST_REVISION|iteration/i,
      'body must document the critique feedback cycle',
    );
  });

  test('frontmatter sets user-invocable to false (or equivalent)', () => {
    const fm = parseAgentFrontmatter(readFileSync(AGENT_PATH, 'utf8'));
    // The frontmatter contains user-invocable: false; check the raw file as backup if parsing varies
    const rawContent = readFileSync(AGENT_PATH, 'utf8');
    const hasFalseMarker = rawContent.includes('user-invocable: false');
    // Cast to any to access hyphenated property that exists at runtime
    assert.ok(
      /** @type {any} */ (fm)['user-invocable'] === false || hasFalseMarker,
      `planner must have user-invocable: false in frontmatter; raw content match: ${hasFalseMarker}`,
    );
  });
});
