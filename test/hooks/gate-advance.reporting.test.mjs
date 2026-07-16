// @ts-check
/**
 * #92 (review): a projection that HALF succeeds must say so.
 *
 * `projectWorkerReturn` can write one artifact and refuse the other: the
 * planner's plan.json lands, but its scope.md is declined because the plan's
 * file list is empty (an empty contract serializes to one that denies every
 * edit, so the writer refuses it rather than brick the lane).
 *
 * The hook keyed its stderr report on `artifact === null`, so that case was
 * swallowed — and the run then died much later, at the dispatch gate, with
 * "scope.md is missing" and no record anywhere of why it had never been written.
 * A silent partial failure is the exact bug class this hook was built to end.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'devmate-ga-report-'));
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
 * A runSubagent PostToolUse event carrying an agent's return, in the shape the
 * host actually sends: prose with the contract JSON embedded in it.
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
    },
  ],
  assumptions: [],
  openRisks: [],
  unverified: [],
};

test('gate-advance/reporting › a refused scope.md is REPORTED, even though plan.json landed', async () => {
  const root = workspace();
  const err = capture();
  const out = capture();
  try {
    const res = await handlePostToolUse(plannerReturn(root, PLAN_WITH_NO_FILES), {
      stdout: out.stream,
      stderr: err.stream,
    });

    // The plan itself is valid and IS written — the return is not malformed.
    assert.equal(res.artifact, 'plan.json');

    // But the scope was refused, and that must not be silent.
    const reported = err
      .text()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));

    const partial = reported.find((e) => e.event === 'gate-advance.partial_projection');
    assert.ok(
      partial,
      `the refused scope.md was never reported; stderr was: ${err.text() || '(empty)'}`,
    );
    assert.equal(partial.artifact, 'plan.json');
    assert.match(String(partial.reason), /empty scope/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate-advance/reporting › a fully successful projection reports nothing', async () => {
  // The report is a failure channel, not a log: a clean projection must stay
  // quiet, or the signal is worthless.
  const root = workspace();
  const err = capture();
  const out = capture();
  try {
    await handlePostToolUse(
      plannerReturn(root, {
        ...PLAN_WITH_NO_FILES,
        tasks: [{ ...PLAN_WITH_NO_FILES.tasks[0], files: ['lib/a.mjs'] }],
      }),
      { stdout: out.stream, stderr: err.stream },
    );

    assert.doesNotMatch(
      err.text(),
      /gate-advance\.(no_projection|partial_projection)/,
      `a clean projection must be silent; got: ${err.text()}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
