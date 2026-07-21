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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';

import { handlePostToolUse } from '../../hooks/gate-advance.mjs';
import { mutateTaskStateUnderLock } from '../../lib/task-state.mjs';

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

// ── #198: the gate advance is a version-checked write (CAS loop) ──────────────

test('#198 gate-advance › a concurrent field write is NOT clobbered by the gate advance', async () => {
  // A router return at `no-lane` sets the lane and advances no-lane → lane-set —
  // a real gate-advance write. Race it against a write to an unrelated field.
  // Pre-fix, the blind writeTaskState of the advanced state (from a stale read)
  // would drop the field; the CAS loop re-reads fresh (or retries on conflict),
  // so both the advance AND the concurrent field survive.
  const root = mkdtempSync(join(tmpdir(), 'devmate-ga-cas-'));
  mkdirSync(join(root, '.devmate', 'state'), { recursive: true });
  const statePath = join(root, '.devmate', 'state', 'task.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      taskId: 't1', lane: 'feature', workflowGate: 'no-lane', currentStep: 0,
      artifactHashes: {}, preImplStash: null, budget: 10, schemaVersion: 1,
    }),
    'utf8',
  );
  const out = capture();
  const err = capture();
  const routerReturn = {
    repoRoot: root,
    toolName: 'runSubagent',
    toolUseId: 'toolu_r',
    toolResponse: `Routing.\n\n${JSON.stringify({ agentName: 'router', lane: 'bug', budgetClass: 'standard', confidence: 0.9 })}`,
  };
  try {
    // Deterministic interleaving: calling the hook runs its synchronous prefix
    // (the top-of-function readTaskState) before returning the promise — so a
    // pre-fix stale-read+blind-write would compute `advanced.state` from a snapshot
    // that predates the field write below. Land the competing write NOW, then let
    // the hook's async projection finish and commit. Pre-fix, the blind write drops
    // activeSubagents; the CAS loop re-reads fresh (or retries on conflict) and both
    // survive — so this reliably fails on pre-fix code, not just by luck.
    const hookPromise = handlePostToolUse(routerReturn, { stdout: out.stream, stderr: err.stream });
    await mutateTaskStateUnderLock((s) => ({ ...s, activeSubagents: 2 }), statePath);
    await hookPromise;

    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(after.workflowGate, 'lane-set', 'the gate advanced no-lane → lane-set');
    assert.equal(after.lane, 'bug', 'the router lane was persisted');
    assert.equal(after.activeSubagents, 2, 'the concurrent field write survived the CAS advance');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
