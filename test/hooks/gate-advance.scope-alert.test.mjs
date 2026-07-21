// @ts-check
/**
 * RC-2: a refused scope.md must be visible to the MODEL, not only to stderr.
 *
 * When @planner/@diagnose returns a valid artifact whose file list is empty,
 * writeScope correctly refuses to write an empty scope.md (an empty contract
 * denies every edit) — but plan.json/diagnosis.json DO land. That "partial
 * projection" was logged to stderr as `gate-advance.partial_projection` and
 * NOTHING else: the model-visible alert was keyed on `artifact === null`, so on a
 * clean exit the model never saw it. The failure surfaced far downstream when
 * @fullstack was denied with a confusing "scope.md is missing".
 *
 * The fix raises a model-visible blocking `scopeRegenerationAlert` for the case B
 * shape (`artifact !== null && reason !== null`) while keeping plan.json on disk
 * and the stderr log intact.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';

import { handlePostToolUse } from '../../hooks/gate-advance.mjs';

/** Collect everything a stream is given. */
function capture() {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** A workspace with a task at grill-done, ready for a planner return. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'devmate-ga-scope-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  writeFileSync(
    join(root, '.devmate', 'state', 'task.json'),
    JSON.stringify({
      taskId: 't1',
      lane: 'feature',
      workflowGate: 'grill-done',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return root;
}

/**
 * @param {string} root
 * @param {unknown} result
 */
const plannerReturn = (root, result) => ({
  repoRoot: root,
  toolName: 'runSubagent',
  toolUseId: 'toolu_1',
  toolResponse: `Here is the plan.\n\n${JSON.stringify(result)}`,
});

/** A valid PlannerArtifact whose tasks name NO files. */
const PLAN_WITH_NO_FILES = {
  agentName: 'planner',
  tasks: [
    {
      description: 'Think about it',
      ac: ['AC1'],
      tddApproach: 'test first',
      persona: 'backend',
      files: [],
      alignment: [
        {
          capability: 'fixture capability',
          decision: 'add',
          target: null,
          usageEvidence: [],
          patternRefs: ['lib/index.mjs:1'],
          reason: 'fixture: nothing suitable to reuse',
        },
      ],
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

test('gate-advance/scope-alert › a refused scope.md raises a model-visible blocking alert, plan.json still lands', async () => {
  const root = workspace();
  const statePath = join(root, '.devmate', 'state', 'task.json');
  const before = readFileSync(statePath, 'utf8');
  const err = capture();
  const out = capture();
  try {
    const res = await handlePostToolUse(plannerReturn(root, PLAN_WITH_NO_FILES), {
      stdout: out.stream,
      stderr: err.stream,
    });

    // The plan itself is valid and IS written — the return is not malformed.
    assert.equal(res.artifact, 'plan.json', 'plan.json must still land');
    assert.ok(
      existsSync(join(root, '.devmate', 'session', 't1', 'plan.json')),
      'plan.json must be on disk',
    );

    // The refusal is now surfaced to the model, blocking, and actionable.
    assert.notEqual(res.alert, null, 'the refused scope.md must be model-visible, not stderr-only');
    assert.match(
      String(res.alert),
      /scope\.md was NOT written|regenerate|re-dispatch/i,
      `alert must explain the refused scope; got: ${res.alert}`,
    );
    assert.match(String(res.alert), /plan\.json/, 'alert must name the artifact that landed');

    // The empty-scope refusal is preserved — scope.md is NOT fabricated.
    assert.ok(
      !existsSync(join(root, '.devmate', 'session', 't1', 'scope.md')),
      'scope.md must remain unwritten (refusal preserved)',
    );

    // The stderr partial log is retained.
    assert.match(err.text(), /gate-advance\.partial_projection/, 'the stderr partial log must remain');

    // The alert does not falsely advance or roll back the gate (no critique yet).
    assert.equal(readFileSync(statePath, 'utf8'), before, 'the gate must not move on a partial projection');
    assert.equal(res.stateWritten, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/scope-alert › a plan WITH files projects cleanly and raises no alert', async () => {
  // The alert is a failure channel, not a log: a full success must stay silent, or
  // the signal is worthless.
  const root = workspace();
  const err = capture();
  const out = capture();
  try {
    const res = await handlePostToolUse(
      plannerReturn(root, {
        ...PLAN_WITH_NO_FILES,
        tasks: [{ ...PLAN_WITH_NO_FILES.tasks[0], files: ['lib/a.mjs'] }],
      }),
      { stdout: out.stream, stderr: err.stream },
    );

    assert.equal(res.artifact, 'plan.json');
    assert.equal(res.alert, null, 'a clean projection must raise no alert');
    assert.ok(
      existsSync(join(root, '.devmate', 'session', 't1', 'scope.md')),
      'scope.md must be written when the plan names files',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
