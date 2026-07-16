// @ts-check
/**
 * E2-6 regression: a flaky command (fails first, passes on rerun) must produce
 * a trace with two linked attempt entries and a result carrying a flake summary
 * plus artifact paths.
 *
 * Spec reconciliation: real FlakeResult has no `flakeSummary`/`artifactPaths`
 * fields. The flake summary is the `verdict`, and the artifact paths are
 * `fullOutputPath` (first run) + `rerunFullOutputPath` (rerun). The trace links
 * the two attempts via the `rerunOf` field on the second loop_attempt entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runWithFlakeDetection } from '../../lib/loop/flake-rerun.mjs';
import { readTraceFile } from '../../lib/loop/trace-schema.mjs';
import { makeTmpDir, cleanup, failThenPassScript } from './_helpers.mjs';

/** @param {string} dir @returns {{ traceFile: string, script: string }} */
function setup(dir) {
  const counter = join(dir, 'counter.txt');
  const script = join(dir, 'flaky.mjs');
  writeFileSync(script, failThenPassScript(counter), 'utf8');
  return { traceFile: join(dir, 'trace.jsonl'), script };
}

test('flaky-rerun › trace contains two attempt entries with linked IDs', async () => {
  const dir = makeTmpDir('reg-flaky-');
  try {
    const { traceFile, script } = setup(dir);
    await runWithFlakeDetection({
      argv: ['node', script],
      traceFile,
      taskId: 'task-flaky-001',
      firstAttemptId: 'attempt-first',
      outputDir: dir,
      tier: 1,
    });

    const { events } = readTraceFile(traceFile);
    const attempts = events.filter((e) => e.type === 'loop_attempt');
    assert.equal(attempts.length, 2, 'first run + rerun both traced');
    // The rerun entry links back to the first via rerunOf.
    const rerun = attempts.find((e) => /** @type {any} */ (e).rerunOf !== undefined);
    assert.ok(rerun, 'rerun attempt carries a linked rerunOf id');
    assert.equal(/** @type {any} */ (rerun).rerunOf, 'attempt-first');
  } finally {
    cleanup(dir);
  }
});

test('flaky-rerun › result includes flakeSummary and artifactPaths', async () => {
  const dir = makeTmpDir('reg-flaky-');
  try {
    const { traceFile, script } = setup(dir);
    const result = await runWithFlakeDetection({
      argv: ['node', script],
      traceFile,
      taskId: 'task-flaky-002',
      firstAttemptId: 'attempt-first',
      outputDir: dir,
      tier: 1,
    });

    // Flake summary = verdict (reconciled name).
    assert.equal(result.verdict, 'flaky', 'fail-then-pass yields a flaky verdict');
    // Artifact paths = first-run + rerun output paths (reconciled names).
    const artifactPaths = [result.fullOutputPath, result.rerunFullOutputPath];
    assert.ok(artifactPaths[0] && artifactPaths[0].endsWith('.txt'), 'first-run artifact present');
    assert.ok(artifactPaths[1] && artifactPaths[1].endsWith('.txt'), 'rerun artifact present');
  } finally {
    cleanup(dir);
  }
});
