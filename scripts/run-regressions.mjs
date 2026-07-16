// @ts-check
/**
 * E9-24: regression-index runner. Consumes `REGRESSION_SUITES` +
 * `runRegressionSuite` from `evals/regression-index.mjs` (previously dead
 * code), runs every suite, and emits `evals/regression-summary.json` so CI
 * uploads an inspectable historical record of the regression floor.
 *
 * Fail-closed: a suite counts as passing only when it reported zero failures
 * AND at least one passing test — a suite whose TAP output cannot be parsed
 * (0 passed / 0 failed) marks the summary failed rather than silently green.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { ensureDir, writeTextFile } from '../lib/fs-safe.mjs';
import { REGRESSION_SUITES, runRegressionSuite } from '../evals/regression-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default summary location (uploaded by CI; gitignored locally). */
const DEFAULT_SUMMARY_PATH = resolve(__dirname, '../evals/regression-summary.json');

/**
 * Shape of `evals/regression-summary.json` (E9-24).
 * @typedef {Object} RegressionSummary
 * @property {number} schemaVersion
 * @property {string} generatedAt   ISO-8601 run timestamp.
 * @property {boolean} passed       True iff every suite ran clean.
 * @property {Array<import('../lib/types.mjs').RegressionResult & { ok: boolean }>} suites
 */

/**
 * Run every regression suite and write the summary artifact.
 * @param {string[]} args  Optional: [0] overrides the summary output path.
 * @param {{ suites?: string[], runSuite?: typeof runRegressionSuite }} [opts]
 *        Injection seams for tests (suite list + runner).
 * @returns {Promise<number>} exit code — 0 all suites clean, 1 otherwise.
 */
export async function main(args, opts = {}) {
  const summaryPath = args[0] ? resolve(args[0]) : DEFAULT_SUMMARY_PATH;
  const suites = opts.suites ?? REGRESSION_SUITES;
  const runSuite = opts.runSuite ?? runRegressionSuite;

  /** @type {RegressionSummary['suites']} */
  const results = [];
  for (const suitePath of suites) {
    const result = await runSuite(suitePath);
    const ok = result.failed === 0 && result.passed > 0;
    results.push({ ...result, ok });
    process.stdout.write(
      `[run-regressions] ${result.suite}: ${ok ? 'PASS' : 'FAIL'} ` +
        `(${result.passed} passed, ${result.failed} failed)\n`
    );
  }

  /** @type {RegressionSummary} */
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: results.every((r) => r.ok),
    suites: results,
  };
  await ensureDir(dirname(summaryPath));
  await writeTextFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');

  process.stdout.write(
    `[run-regressions] ${summary.passed ? 'PASS' : 'FAIL'} — ` +
      `${results.length} suite(s); summary at ${summaryPath}\n`
  );
  return summary.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
