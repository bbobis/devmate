// @ts-check
/**
 * E7-6 / E8 (#81) entrypoint: run the issue-quality evals, write
 * results-latest.json, and exit non-zero when any positive case scores below
 * 7/7 or any negative case's intended defect is not caught.
 *
 * CONTRIBUTING.md §6: guarded entrypoint; assertNodeVersion(24); cap output.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { scoreIssueQuality } from '../evals/issue-quality/scorer.mjs';
import { POSITIVE_CASES } from '../evals/issue-quality/cases.mjs';
import { NEGATIVE_CASES } from '../evals/issue-quality/negative-cases.mjs';

/** @typedef {import('../lib/types.mjs').IssueQualityScore} IssueQualityScore */
/** @typedef {{ id: string, body: string }} IssueCase */
/** @typedef {{ id: string, defect: keyof IssueQualityScore, body: string }} NegativeCase */

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = resolve(__dirname, '../evals/issue-quality/results-latest.json');

/**
 * Evaluate positive + negative cases purely (no I/O). Returns a structured
 * summary plus a pass flag for the CI threshold.
 * @param {IssueCase[]} positives
 * @param {NegativeCase[]} negatives
 * @returns {{ passed: boolean, positiveAccuracy: number, positives: IssueQualityScore[], negativesMissed: string[] }}
 */
export function evaluateCases(positives, negatives) {
  const positiveScores = positives.map((c) => scoreIssueQuality(c.id, c.body));
  const perfect = positiveScores.filter((s) => s.score === 7).length;
  const positiveAccuracy = positives.length === 0 ? 1 : perfect / positives.length;

  /** @type {string[]} */
  const negativesMissed = [];
  for (const n of negatives) {
    const s = scoreIssueQuality(n.id, n.body);
    // The defect dimension must be false (caught). If it's true, the eval missed it.
    const defectEntry = Object.entries(s).find(([k]) => k === n.defect);
    if (defectEntry?.[1] !== false) negativesMissed.push(n.id);
  }

  const passed = positiveAccuracy >= 1.0 && negativesMissed.length === 0;
  return { passed, positiveAccuracy, positives: positiveScores, negativesMissed };
}

/**
 * @param {string[]} [args]
 * @returns {Promise<number>}
 */
export async function main(args = []) {
  const summary = evaluateCases(POSITIVE_CASES, NEGATIVE_CASES);

  const report = {
    generatedAt: new Date().toISOString(),
    positiveAccuracy: summary.positiveAccuracy,
    positiveCount: POSITIVE_CASES.length,
    negativeCount: NEGATIVE_CASES.length,
    negativesMissed: summary.negativesMissed,
    passed: summary.passed,
    scores: summary.positives,
  };

  if (!args.includes('--no-write')) {
    mkdirSync(dirname(RESULTS_PATH), { recursive: true });
    writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  const status = summary.passed ? 'PASS' : 'FAIL';
  process.stdout.write(
    `[issue-quality] ${status} — positive accuracy ${(summary.positiveAccuracy * 100).toFixed(0)}%, ` +
    `${summary.negativesMissed.length} defect(s) missed\n`
  );

  return summary.passed ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
