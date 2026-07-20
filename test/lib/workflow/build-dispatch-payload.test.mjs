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
  const dir = mkdtempSync(join(tmpdir(), 'build-dispatch-payload-'));
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  return { dir, planPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * E10-06: the four dispatch-completeness fields are now required on every
 * payload. Spread into each call so these suites keep exercising their
 * original concern with a complete payload. Values deliberately avoid
 * tool-specific command names (see the no-tool-defaults test below);
 * completeness rejection itself is covered in
 * build-dispatch-payload.completeness.test.mjs.
 */
const COMPLETENESS_FIELDS = {
  objective: 'Implement the planned tasks',
  outputFormat: 'Return a typed result object',
  toolGuidance: 'Use repo-configured verification commands only',
  boundaries: 'Touch only files matching the persona editable globs',
};

test('build-dispatch-payload › always includes TDD preamble in output', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-1',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/foo.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  });

  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1', description: 'do thing' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: { unitTest: 'run-unit-tests' },
      },
    });

    assert.match(payload, /TDD_PREAMBLE_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › includes tddApproach testFiles from plan', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-2',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/bar.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  });

  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-2' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: { unitTest: 'run-unit-tests' },
      },
    });

    assert.match(payload, /src\/bar\.spec\.ts/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › verification block uses config.verification.unitTest not hardcoded command', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-3',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/baz.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  });

  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-3' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: { unitTest: 'my-custom-unit-command' },
      },
    });

    assert.match(payload, /my-custom-unit-command/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › renders the dynamic verification.checks list', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-3b',
        tddApproach: { testType: 'unit', testFiles: ['src/baz.spec.ts'], redSummary: 'fails' },
      },
    ],
  });

  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-3b' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: {
          checks: [
            { id: 'unit-test', command: 'run-units', category: 'unit-test' },
            { id: 'lint', command: 'run-lint', category: 'lint', optional: true },
            { id: 'build', command: 'run-build', category: 'build' },
          ],
        },
      },
    });

    assert.match(payload, /## Verification/);
    assert.match(payload, /- unit-test \[unit-test\]: run-units/);
    assert.match(payload, /- lint \[lint\] \(optional\): run-lint/);
    assert.match(payload, /- build \[build\]: run-build/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › throws when plan has task with no tddApproach', () => {
  const fixture = writePlan({
    tasks: [{ id: 'AC-4' }],
  });

  try {
    assert.throws(() =>
      buildDispatchPayload({
        ...COMPLETENESS_FIELDS,
        persona: 'frontend',
        tasks: [{ id: 'AC-4' }],
        planPath: fixture.planPath,
        config: {
          schemaVersion: 1,
          personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
          verification: { unitTest: 'run-unit-tests' },
        },
      }),
    /Task AC-4 is missing tddApproach\.testFiles/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › throws when tddApproach.testFiles is empty array', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-5',
        tddApproach: {
          testType: 'unit',
          testFiles: [],
          redSummary: 'fails before implementation',
        },
      },
    ],
  });

  try {
    assert.throws(() =>
      buildDispatchPayload({
        ...COMPLETENESS_FIELDS,
        persona: 'frontend',
        tasks: [{ id: 'AC-5' }],
        planPath: fixture.planPath,
        config: {
          schemaVersion: 1,
          personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
          verification: { unitTest: 'run-unit-tests' },
        },
      }),
    /Task AC-5 is missing tddApproach\.testFiles/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › payload does not inject tool-specific defaults', () => {
  const fixture = writePlan({
    tasks: [
      {
        id: 'AC-6',
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/qux.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  });

  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-6' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: { unitTest: 'run-unit-tests' },
      },
    });

    assert.doesNotMatch(payload, /\bnpx\b/);
    assert.doesNotMatch(payload, /\bmvn\b/);
    assert.doesNotMatch(payload, /\bpytest\b/);
  } finally {
    fixture.cleanup();
  }
});

/**
 * @param {string} [id]
 * @returns {object}
 */
function tddPlan(id = 'AC-1') {
  return {
    tasks: [
      {
        id,
        tddApproach: {
          testType: 'unit',
          testFiles: ['src/foo.spec.ts'],
          redSummary: 'fails before implementation',
        },
      },
    ],
  };
}

/**
 * B4: a validated multi-root config with two personas targeting two repos.
 * @returns {import('../../../lib/types.mjs').DevmateConfig}
 */
function multiRootConfig() {
  return {
    schemaVersion: 1,
    mode: 'multi-root',
    primary: 'portals-api',
    repos: ['portals-api', 'portals-ui'],
    personas: [
      {
        persona: 'backend',
        editableGlobs: ['**/*.java'],
        repo: 'portals-api',
        repoPath: '/work/worktrees/feature-123/portals-api',
      },
      {
        persona: 'frontend',
        editableGlobs: ['**/*.ts'],
        repo: 'portals-ui',
        repoPath: '/work/worktrees/feature-123/portals-ui',
      },
    ],
    verification: { unitTest: 'run-unit-tests' },
  };
}

test('build-dispatch-payload › multi-root: injects persona repoPath and scoped repoMemory', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: multiRootConfig(),
      sessionContext: {
        repoMemories: {
          'portals-api': 'API repo memory contents',
          'portals-ui': 'UI repo memory contents',
        },
      },
    });

    assert.match(payload, /## Repo context/);
    assert.match(payload, /- Repo path: \/work\/worktrees\/feature-123\/portals-api/);
    assert.match(payload, /API repo memory contents/);
    // No cross-contamination from the other repo's memory.
    assert.doesNotMatch(payload, /UI repo memory contents/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › multi-root: persona whose repo has no memory entry defaults to empty (no throw)', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: multiRootConfig(),
      // portals-ui deliberately absent from the map -> defaults to ''.
      sessionContext: { repoMemories: { 'portals-api': 'API repo memory contents' } },
    });

    assert.match(payload, /- Repo path: \/work\/worktrees\/feature-123\/portals-ui/);
    // Empty memory is represented explicitly; no other repo's memory leaks in.
    assert.match(payload, /### Repo memory\n\n\[none\]/);
    assert.doesNotMatch(payload, /API repo memory contents/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › multi-root: missing sessionContext defaults repoMemory to empty (no throw)', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: multiRootConfig(),
    });

    assert.match(payload, /- Repo path: \/work\/worktrees\/feature-123\/portals-api/);
    assert.match(payload, /### Repo memory\n\n\[none\]/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › multi-root: unknown persona throws identifying the persona', () => {
  const fixture = writePlan(tddPlan());
  try {
    assert.throws(
      () =>
        buildDispatchPayload({
          ...COMPLETENESS_FIELDS,
          persona: 'nonexistent',
          tasks: [{ id: 'AC-1' }],
          planPath: fixture.planPath,
          config: multiRootConfig(),
          sessionContext: { repoMemories: {} },
        }),
      /persona 'nonexistent' not found in multi-root config/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › multi-root: two personas each get their own scoped memory', () => {
  const fixture = writePlan(tddPlan());
  const config = multiRootConfig();
  const sessionContext = {
    repoMemories: {
      'portals-api': 'API repo memory contents',
      'portals-ui': 'UI repo memory contents',
    },
  };
  try {
    const backend = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config,
      sessionContext,
    });
    const frontend = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config,
      sessionContext,
    });

    assert.match(backend, /portals-api/);
    assert.match(backend, /API repo memory contents/);
    assert.doesNotMatch(backend, /UI repo memory contents/);

    assert.match(frontend, /portals-ui/);
    assert.match(frontend, /UI repo memory contents/);
    assert.doesNotMatch(frontend, /API repo memory contents/);
  } finally {
    fixture.cleanup();
  }
});

test('build-dispatch-payload › single-root: payload has no repo-context section (unchanged)', () => {
  const fixture = writePlan(tddPlan());
  try {
    const payload = buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'frontend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: {
        schemaVersion: 1,
        personas: [{ persona: 'frontend', editableGlobs: ['src/**'] }],
        verification: { unitTest: 'run-unit-tests' },
      },
      // A sessionContext must be ignored entirely in single-root mode.
      sessionContext: { repoMemories: { 'portals-api': 'should never appear' } },
    });

    assert.doesNotMatch(payload, /## Repo context/);
    assert.doesNotMatch(payload, /Repo path:/);
    assert.doesNotMatch(payload, /should never appear/);
  } finally {
    fixture.cleanup();
  }
});

// ── #151: the dispatch-time repo-memory section is token-budgeted ─────────────

/** A repo memory string large enough to exceed MEMORY_CONTEXT_MAX_TOKENS (1500 ≈ 6000 bytes). */
function oversizedMemory() {
  const lines = ['# Repo memory', ''];
  for (let i = 0; i < 900; i += 1) lines.push(`- durable fact ${i} about this repository`);
  return lines.join('\n');
}

/**
 * Dispatch with a given repo memory + optional budget override for portals-api.
 * @param {string} memory
 * @param {number} [budget]  optional memoryMaxTokens override
 * @returns {string}
 */
function dispatchWithMemory(memory, budget) {
  const fixture = writePlan(tddPlan());
  try {
    return buildDispatchPayload({
      ...COMPLETENESS_FIELDS,
      persona: 'backend',
      tasks: [{ id: 'AC-1' }],
      planPath: fixture.planPath,
      config: multiRootConfig(),
      sessionContext: {
        repoMemories: { 'portals-api': memory },
        ...(budget === undefined ? {} : { memoryMaxTokens: budget }),
      },
    });
  } finally {
    fixture.cleanup();
  }
}

test('build-dispatch-payload › #151 under budget: memory is rendered verbatim (no digest marker)', () => {
  const payload = dispatchWithMemory('a small, durable repository fact');
  assert.match(payload, /a small, durable repository fact/, 'small memory is injected in full');
  assert.doesNotMatch(payload, /over budget/, 'no degradation when under budget');
});

test('build-dispatch-payload › #151 over budget: degrades LOUDLY to a digest + pointer, never a silent paste', () => {
  const payload = dispatchWithMemory(oversizedMemory());
  assert.match(payload, /\[repo memory over budget — digest below; read \.devmate\/MEMORY\.md for the rest\]/);
  assert.match(payload, /durable fact 0 about this repository/, 'the digest head is present');
  assert.doesNotMatch(payload, /durable fact 800 about this repository/, 'the tail is NOT pasted verbatim');
});

test('build-dispatch-payload › #151 a small memoryMaxTokens override forces even a small memory to digest', () => {
  const payload = dispatchWithMemory('a small durable repository fact that is a few tokens long', 3);
  assert.match(payload, /over budget — digest below/, 'the override tightens the budget');
});

test('build-dispatch-payload › #151 a generous memoryMaxTokens override keeps a large memory in full', () => {
  const payload = dispatchWithMemory(oversizedMemory(), 100000);
  assert.match(payload, /durable fact 800 about this repository/, 'a generous override keeps the full memory');
  assert.doesNotMatch(payload, /over budget/);
});

test('build-dispatch-payload › #151 a non-positive or non-finite memoryMaxTokens is rejected', () => {
  for (const bad of [0, -1, Infinity, NaN]) {
    assert.throws(
      () => dispatchWithMemory('some memory', bad),
      /memoryMaxTokens must be a positive finite number/,
      `expected throw for override ${bad}`,
    );
  }
});

test('build-dispatch-payload › #151 the over-budget DIGEST is itself clamped (pathological all-headings memory)', () => {
  // A memory that is almost entirely headings: buildMemoryDigest would otherwise
  // reproduce nearly the whole file in one "Headings: …" line, defeating the cap.
  const headings = [];
  for (let i = 0; i < 1500; i += 1) headings.push(`## section heading number ${i} with some words`);
  const memory = headings.join('\n');
  // A tiny override forces even the headings-only fallback over budget → marker only.
  const payload = dispatchWithMemory(memory, 20);
  assert.match(payload, /repo memory over budget/, 'the loud marker always fires');
  // The whole heading list must NOT be pasted under a 20-token budget.
  assert.doesNotMatch(payload, /section heading number 1400/, 'the digest is clamped, not the whole file');
});
