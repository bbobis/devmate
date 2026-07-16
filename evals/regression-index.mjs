// @ts-check
/**
 * E7-1: Barrel of regression-suite paths for the eval runner.
 *
 * Individual suites use node:test directly (run via `node --test`). This barrel
 * exposes the absolute paths so later E7 eval-harness issues can enumerate and
 * summarize them programmatically.
 */

/** @typedef {import('../lib/types.mjs').RegressionResult} RegressionResult */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REG_DIR = resolve(__dirname, '../test/regression');

/**
 * Absolute paths to every regression suite, in dependency-audit order.
 * @type {string[]}
 */
export const REGRESSION_SUITES = [
  'concurrency',
  'hook-registration',
  'malformed-jsonl',
  'duplicate-step-labels',
  'tier5-gate',
  'flaky-rerun',
  'quoting',
  'timeout',
  'memory-pipeline',
  'gate-guard-large-payload',
  'scope-contract-unenforced',
  'persona-boundary-inert',
].map((name) => join(REG_DIR, `${name}.test.mjs`));

/**
 * Run a single regression suite and return a summary.
 * Used by the eval runner barrel; individual suites use node:test directly.
 * Spawns `node --test <suitePath>` and parses the TAP plan tail.
 * @param {string} suitePath  Absolute path to the *.test.mjs file.
 * @returns {Promise<RegressionResult>}
 */
export async function runRegressionSuite(suitePath) {
  const { runCommand } = await import('../lib/loop/run-command.mjs');
  const result = await runCommand(
    ['node', '--test', '--test-reporter=tap', suitePath],
    { timeoutMs: 120_000 }
  );
  const out = result.stdout + result.stderr;

  const passMatch = out.match(/^# pass (\d+)/m);
  const failMatch = out.match(/^# fail (\d+)/m);
  const passed = passMatch ? Number(passMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : 0;

  /** @type {string[]} */
  const failures = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^not ok \d+ - (.+)$/);
    if (m) failures.push(m[1].trim());
  }

  const suite = suitePath.replace(/.*[/\\]/, '').replace(/\.test\.mjs$/, '');
  return { suite, passed, failed, failures };
}
