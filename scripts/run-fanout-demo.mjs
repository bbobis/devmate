// @ts-check
/**
 * E8-1: manual smoke test for the orchestrator-workers fanout. Runs three
 * trivial workers under a 'large' budget and prints the aggregate result.
 *
 * Usage: node scripts/run-fanout-demo.mjs
 */

import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { fanout } from '../lib/orchestrator/fanout.mjs';

/** @typedef {import('../lib/types.mjs').WorkerReturn} WorkerReturn */

/**
 * Build a valid WorkerReturn fixture.
 * @param {string} id
 * @param {string} finding
 * @returns {WorkerReturn}
 */
function makeReturn(id, finding) {
  return {
    workerId: id,
    finding,
    sourcePointer: {
      path: 'README.md',
      lineRange: null,
      reason: 'demo evidence',
      confidence: 0.9,
      freshness: new Date().toISOString(),
      kind: 'file',
    },
    confidence: 0.9,
    artifactWritten: null,
    nextRecommendedStep: 'Merge the findings.',
    tokenNotes: 'Loaded 1 slice, ~200 tokens',
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: new Date().toISOString(),
  };
}

/**
 * @param {string[]} [_args]
 * @returns {Promise<number>}
 */
export async function main(_args = []) {
  const workers = [
    () => Promise.resolve(makeReturn('alpha', 'Found config in package.json')),
    () => Promise.resolve(makeReturn('beta', 'Found tests in test/')),
    () => Promise.resolve(makeReturn('gamma', 'Found docs in docs/')),
  ];

  const result = await fanout(workers, { budgetClass: 'large', timeoutMs: 5000 });
  process.stdout.write(
    `[fanout-demo] ${result.results.length} valid, ${result.violations.length} violation(s)\n`
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
