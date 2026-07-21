// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDispatchPayload } from '../../../lib/workflow/build-dispatch-payload.mjs';

/**
 * @param {object} plan
 * @returns {{ dir: string, planPath: string, cleanup: () => void }}
 */
function writePlan(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'build-dispatch-payload-align-'));
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
function tddPlanFile() {
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

/** @returns {object} one task carrying a reuse + add alignment pair */
function alignedTask() {
  return {
    id: 'T-1',
    description: 'Add the role-claim guard',
    alignment: [
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
    ],
  };
}

test('alignment › renders the alignment section when a task carries it', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [alignedTask()],
      planPath: fixture.planPath,
      config: config(),
    });
    assert.match(payload, /## Codebase alignment evidence/);
    assert.match(payload, /capability: artifact hash persistence \| decision: reuse/);
    assert.match(payload, /target: recordArtifactHash @ lib\/task-state\.mjs/);
    assert.match(payload, /usage: lib\/workflow\/agents\/planner\.mjs:321/);
    assert.match(payload, /capability: role-claim guard \| decision: add/);
    assert.match(payload, /target: \[none\]/);
    assert.match(payload, /pattern: src\/cursor\.mjs:44/);
    // The section renders after the task list and before the verification block.
    assert.ok(payload.indexOf('## Task list') < payload.indexOf('## Codebase alignment evidence'));
  } finally {
    fixture.cleanup();
  }
});

test('alignment › adds no section when a task has no (or an empty) alignment', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    const base = {
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      planPath: fixture.planPath,
      config: config(),
    };
    // No `alignment` field is exactly today's task shape — nothing is added.
    const withoutField = buildDispatchPayload({ ...base, tasks: [{ id: 'T-1', description: 'x' }] });
    // An empty array must not leak a section either.
    const withEmptyArray = buildDispatchPayload({
      ...base,
      tasks: [{ id: 'T-1', description: 'x', alignment: [] }],
    });
    assert.doesNotMatch(withoutField, /Codebase alignment evidence/);
    assert.doesNotMatch(withEmptyArray, /Codebase alignment evidence/);
    // Everything except the verbatim task-list JSON echo is unchanged.
    const stripTaskList = (/** @type {string} */ s) => s.replace(/^\d+\. \{.*\}$/m, '<task>');
    assert.equal(stripTaskList(withEmptyArray), stripTaskList(withoutField));
  } finally {
    fixture.cleanup();
  }
});

test('alignment › feature-lane impl dispatch without alignment throws', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    assert.throws(
      () =>
        buildDispatchPayload({
          ...COMPLETENESS_FIELDS,
          persona: 'backend',
          lane: 'feature',
          targetAcs: [{ id: 1, text: 'AC1: something' }],
          tasks: [{ id: 'T-1', description: 'x' }],
          planPath: fixture.planPath,
          config: config(),
        }),
      /requires codebase-alignment evidence on every task; tasks\[0\] has none/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('alignment › feature-lane impl dispatch WITH alignment does not throw', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      lane: 'feature',
      targetAcs: [{ id: 1, text: 'AC1: something' }],
      tasks: [alignedTask()],
      planPath: fixture.planPath,
      config: config(),
    });
    assert.match(payload, /## Codebase alignment evidence/);
  } finally {
    fixture.cleanup();
  }
});

test('alignment › non-feature dispatch without alignment is allowed', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    // bug lane, and no lane at all — neither arms the fail-closed check.
    for (const lane of [/** @type {const} */ ('bug'), undefined]) {
      const payload = buildDispatchPayload({
        ...COMPLETENESS_FIELDS,
        persona: 'backend',
        ...(lane ? { lane } : {}),
        targetAcs: [{ id: 1, text: 'AC1: something' }],
        tasks: [{ id: 'T-1', description: 'x' }],
        planPath: fixture.planPath,
        config: config(),
      });
      assert.doesNotMatch(payload, /Codebase alignment evidence/);
    }
  } finally {
    fixture.cleanup();
  }
});

test('alignment › long reason/pointer lines are capped', () => {
  const fixture = writePlan(tddPlanFile());
  try {
    const longReason = 'because '.repeat(60).trim();
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [
        {
          id: 'T-1',
          description: 'x',
          alignment: [
            {
              capability: 'c',
              decision: 'add',
              target: null,
              usageEvidence: [],
              patternRefs: ['src/x.mjs:1'],
              reason: longReason,
            },
          ],
        },
      ],
      planPath: fixture.planPath,
      config: config(),
    });
    const reasonLine = payload.split('\n').find((l) => l.trim().startsWith('reason:')) ?? '';
    assert.ok(reasonLine.endsWith('...'), `expected truncation, got: ${reasonLine}`);
    // "  reason: " prefix (10) + cap (120) is the ceiling.
    assert.ok(reasonLine.length <= 10 + 120, `reason line too long: ${reasonLine.length}`);
  } finally {
    fixture.cleanup();
  }
});
