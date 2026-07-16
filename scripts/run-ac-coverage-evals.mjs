// @ts-check
/**
 * AC-6 (epic #416) entrypoint: run the deterministic AC-coverage eval suite and
 * write evals/ac-coverage/results-latest.json (a small, git-ignored coverage
 * report artifact) so the acceptance-criterion miss rate is trackable across
 * runs. Thin CLI over evals/ac-coverage/index.mjs, which owns the fixture
 * materialization and the real AC-1 read + AC-2 gate exercise.
 *
 * CONTRIBUTING.md §6: guarded entrypoint; assertNodeVersion(24); output capped
 * to one digest line + the JSON artifact — never the per-scenario transcripts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { evaluateScenarios, loadScenarios } from '../evals/ac-coverage/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Git-ignored coverage report artifact (mirrors evals/issue-quality/results-latest.json). */
const RESULTS_PATH = resolve(__dirname, '../evals/ac-coverage/results-latest.json');

/**
 * Evaluate all fixtures, write the report artifact (unless `--no-write`), print
 * a one-line digest, and exit non-zero when any scenario's observed verdict
 * diverges from its expected verdict.
 * @param {string[]} [args]
 * @returns {Promise<number>}
 */
export async function main(args = []) {
  const report = await evaluateScenarios(loadScenarios());

  if (!args.includes('--no-write')) {
    const artifact = { generatedAt: new Date().toISOString(), ...report };
    mkdirSync(dirname(RESULTS_PATH), { recursive: true });
    writeFileSync(RESULTS_PATH, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  }

  const pct = (report.detectionRate * 100).toFixed(0);
  const parts = [
    `${report.scenarioCount} scenario(s)`,
    `block-mode detection ${report.blockDetected}/${report.missCount} (${pct}%)`,
    `off-mode baseline ${report.offDetected}/${report.missCount}`,
    `${report.knownLimitations.length} known limitation(s)`,
  ];
  if (report.failed.length > 0) parts.push(`failed: ${report.failed.join(', ')}`);
  process.stdout.write(`[ac-coverage] ${report.passed ? 'PASS' : 'FAIL'} — ${parts.join(', ')}\n`);

  return report.passed ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
