// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDispatchPayload } from '../../../lib/workflow/build-dispatch-payload.mjs';
import { deriveTaskAcAssignments } from '../../../lib/workflow/agents/spec-writer.mjs';
import { writeSpec } from '../../../lib/spec-writer.mjs';
import { parseAcceptanceCriteria } from '../../../lib/spec-progress.mjs';

/**
 * @param {object} plan
 * @returns {{ dir: string, planPath: string, cleanup: () => void }}
 */
function writePlan(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'build-dispatch-payload-ac-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  return { dir, planPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** E10-06: the four required dispatch-completeness fields (see the base suite). */
const COMPLETENESS_FIELDS = {
  objective: 'Implement the planned tasks',
  outputFormat: 'Return a typed result object',
  toolGuidance: 'Use repo-configured verification commands only',
  boundaries: 'Touch only files matching the persona editable globs',
};

/** @returns {object} a TDD-valid plan file body for the payload builder */
function tddPlan() {
  return {
    tasks: [
      {
        id: 'T-1',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/foo.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  };
}

/** @returns {import('../../../lib/types.mjs').DevmateConfig} a minimal single-root config */
function config() {
  return {
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    verification: { unitTest: 'run-unit-tests' },
  };
}

/**
 * The issue's canonical two-task planner artifact: task A owns two ACs, task
 * B one — so task B's local `AC1` label must resolve to GLOBAL id 3.
 * @returns {import('../../../lib/workflow/agents/planner.mjs').PlannerArtifact}
 */
function twoTaskPlan() {
  return /** @type {import('../../../lib/workflow/agents/planner.mjs').PlannerArtifact} */ ({
    tasks: [
      {
        description: 'Task A',
        ac: ['AC1: endpoint returns 200', 'AC2: endpoint rejects bad input'],
        tddApproach: 'unit tests',
        persona: 'backend',
        files: ['src/a.mjs'],
        alignment: [],
      },
      {
        description: 'Task B',
        ac: ['AC1: panel renders the result'],
        tddApproach: 'unit tests',
        persona: 'frontend',
        files: ['src/b.mjs'],
        alignment: [],
      },
    ],
    assumptions: [],
    openRisks: [],
    unverified: [],
  });
}

test('ac-ids › mapping: second task local AC1 resolves to global 3', () => {
  const assignments = deriveTaskAcAssignments(twoTaskPlan());

  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments[0], {
    taskIndex: 0,
    acs: [
      { id: 1, text: 'AC1: endpoint returns 200' },
      { id: 2, text: 'AC2: endpoint rejects bad input' },
    ],
  });
  // The namespace fix: task B's local AC1 is GLOBAL AC3, never AC1.
  assert.deepEqual(assignments[1], {
    taskIndex: 1,
    acs: [{ id: 3, text: 'AC1: panel renders the result' }],
  });
});

test('ac-ids › mapping: empty task list yields empty assignments', () => {
  const assignments = deriveTaskAcAssignments(
    /** @type {import('../../../lib/workflow/agents/planner.mjs').PlannerArtifact} */ ({
      tasks: [],
      assumptions: [],
      openRisks: [],
      unverified: [],
    }),
  );
  assert.deepEqual(assignments, []);
});

test('ac-ids › payload for task B carries global targetAcIds [3], not [1]', () => {
  const fixture = writePlan(tddPlan());
  try {
    const taskB = deriveTaskAcAssignments(twoTaskPlan())[1];
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-B' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: taskB.acs,
    });

    assert.match(payload, /## Target acceptance criteria/);
    assert.match(payload, /- targetAcIds: \[3\]/);
    assert.match(payload, /- AC3: AC1: panel renders the result/);
    assert.doesNotMatch(payload, /- targetAcIds: \[1\]/);
    // The subset-reporting instruction rides along with the ids.
    assert.match(payload, /subset of targetAcIds, verbatim/);
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › multi-AC dispatch lists every id in order', () => {
  const fixture = writePlan(tddPlan());
  try {
    const taskA = deriveTaskAcAssignments(twoTaskPlan())[0];
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-A' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: taskA.acs,
    });

    assert.match(payload, /- targetAcIds: \[1, 2\]/);
    assert.match(payload, /- AC1: AC1: endpoint returns 200/);
    assert.match(payload, /- AC2: AC2: endpoint rejects bad input/);
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › entries render in ascending id order regardless of caller order', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-1' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: [
        { id: 3, text: 'third criterion' },
        { id: 1, text: 'first criterion' },
      ],
    });

    assert.match(payload, /- targetAcIds: \[1, 3\]/);
    assert.ok(
      payload.indexOf('- AC1: first criterion') < payload.indexOf('- AC3: third criterion'),
      'per-AC lines must render in ascending id order',
    );
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › omitted targetAcs: section absent, no crash, no spurious ids', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-1' }],
      planPath: fixture.planPath,
      config: config(),
    });

    assert.doesNotMatch(payload, /Target acceptance criteria/);
    assert.doesNotMatch(payload, /targetAcIds/);
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › empty targetAcs array omits the section cleanly', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-1' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: [],
    });

    assert.doesNotMatch(payload, /Target acceptance criteria/);
    assert.doesNotMatch(payload, /targetAcIds/);
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › AC text is capped: ids + short text, never full spec content', () => {
  const fixture = writePlan(tddPlan());
  const longText = `starts here ${'x'.repeat(300)} ends here`;
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-1' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: [{ id: 1, text: longText }],
    });

    assert.doesNotMatch(payload, /ends here/);
    const acLine = payload.split('\n').find((line) => line.startsWith('- AC1: '));
    assert.ok(acLine, 'payload is missing the AC1 line');
    const renderedText = acLine.slice('- AC1: '.length);
    assert.ok(
      renderedText.length <= 120,
      `AC text must be capped at 120 chars, got ${renderedText.length}`,
    );
    assert.match(renderedText, /\.\.\.$/);
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › malformed assignments fail closed', () => {
  const fixture = writePlan(tddPlan());
  const base = {
    ...COMPLETENESS_FIELDS,
    persona: 'backend',
    tasks: [{ id: 'T-1' }],
    planPath: fixture.planPath,
    config: config(),
  };
  try {
    assert.throws(
      () => buildDispatchPayload({ ...base, targetAcs: [{ id: 0, text: 'zero id' }] }),
      /unique positive integers/,
    );
    assert.throws(
      () => buildDispatchPayload({ ...base, targetAcs: [{ id: 1.5, text: 'fraction' }] }),
      /unique positive integers/,
    );
    assert.throws(
      () =>
        buildDispatchPayload({
          ...base,
          targetAcs: [{ id: 2, text: 'dup' }, { id: 2, text: 'dup again' }],
        }),
      /unique positive integers/,
    );
    assert.throws(
      () => buildDispatchPayload({ ...base, targetAcs: [{ id: 4, text: '  ' }] }),
      /AC4 is missing its text/,
    );
    assert.throws(
      () =>
        buildDispatchPayload({
          ...base,
          targetAcs: /** @type {any} */ ('not-an-array'),
        }),
      /targetAcs must be an array/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('ac-ids › parity: payload ids match the AC{n} numbering rendered into spec.md', async () => {
  const plan = twoTaskPlan();
  const assignments = deriveTaskAcAssignments(plan);
  const flattened = assignments.flatMap((entry) => entry.acs);

  const repoRoot = mkdtempSync(join(tmpdir(), 'ac-ids-parity-'));
  const fixture = writePlan(tddPlan());
  try {
    // Render a spec whose acceptance criteria come from the same derivation
    // (deriveAcAndTestPlan consumes deriveTaskAcAssignments), then parse the
    // ids back with the global-id convention from lib/spec-progress.mjs.
    await writeSpec(repoRoot, {
      title: 'Parity fixture',
      summary: 'Verifies targetAcIds match spec.md numbering.',
      currentBehavior: 'n/a',
      gap: 'n/a',
      edgeCases: ['none'],
      assumptions: ['none'],
      files: [{ path: 'src/a.mjs', reason: 'task A' }],
      acceptanceCriteria: flattened.map((entry) => entry.text),
      testPlan: flattened.map((entry, index) => ({
        id: `TC-${String(index + 1).padStart(3, '0')}`,
        description: 'unit tests',
        tier: /** @type {1} */ (1),
        testFile: 'test/parity.test.mjs',
        runCommand: 'run-unit-tests',
      })),
      risks: ['none'],
      outOfScope: ['none'],
    });

    const specMarkdown = readFileSync(
      join(repoRoot, '.devmate', 'session', 'spec.md'),
      'utf8',
    );
    const parsed = parseAcceptanceCriteria(specMarkdown);

    // spec.md's AC{n} ids are exactly the derived global ids, in order.
    assert.deepEqual(
      parsed.map((criterion) => criterion.id),
      flattened.map((entry) => entry.id),
    );
    assert.deepEqual(
      parsed.map((criterion) => criterion.text),
      flattened.map((entry) => entry.text),
    );

    // And the dispatch payload for task B names the same global id spec.md
    // renders for it (AC3) — the local/global namespace fix end to end.
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'T-B' }],
      planPath: fixture.planPath,
      config: config(),
      targetAcs: assignments[1].acs,
    });
    const taskBParsed = parsed.find((criterion) => criterion.id === 3);
    assert.ok(taskBParsed, 'spec.md is missing AC3');
    assert.match(payload, /- targetAcIds: \[3\]/);
    assert.ok(payload.includes(`- AC3: ${taskBParsed.text}`));
  } finally {
    fixture.cleanup();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
