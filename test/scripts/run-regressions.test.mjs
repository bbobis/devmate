// @ts-check
/**
 * E9-24: run-regressions runner + regression-index drift self-check. The
 * index must enumerate exactly the suites under test/regression/, and the
 * summary artifact must mark failing (or unparseable) suites — a broken
 * suite can never produce a green summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGRESSION_SUITES } from '../../evals/regression-index.mjs';
import { main } from '../../scripts/run-regressions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REG_DIR = join(__dirname, '..', 'regression');

/** Silence stdout while driving the runner. */
const realOut = process.stdout.write.bind(process.stdout);

/**
 * @param {string[]} args
 * @param {Parameters<typeof main>[1]} opts
 * @returns {Promise<number>}
 */
async function run(args, opts) {
  process.stdout.write = /** @type {typeof process.stdout.write} */ (() => true);
  try {
    return await main(args, opts);
  } finally {
    process.stdout.write = realOut;
  }
}

test('index enumerates every test/regression suite', async () => {
  const entries = await fsp.readdir(REG_DIR);
  const onDisk = entries.filter((f) => f.endsWith('.test.mjs')).sort();
  const inIndex = REGRESSION_SUITES.map((p) => basename(p)).sort();
  assert.deepEqual(inIndex, onDisk, 'REGRESSION_SUITES and test/regression/ must not diverge');
});

test('memory-pipeline present in index', () => {
  assert.ok(
    REGRESSION_SUITES.some((p) => basename(p) === 'memory-pipeline.test.mjs'),
    REGRESSION_SUITES.join(', ')
  );
});

test('run-regressions emits summary', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'run-regressions-'));
  const summaryPath = join(root, 'regression-summary.json');
  const code = await run([summaryPath], {
    suites: ['/fake/alpha.test.mjs', '/fake/beta.test.mjs'],
    runSuite: async (suitePath) => ({
      suite: basename(suitePath).replace(/\.test\.mjs$/, ''),
      passed: 3,
      failed: 0,
      failures: [],
    }),
  });
  assert.equal(code, 0);
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.passed, true);
  assert.equal(typeof summary.generatedAt, 'string');
  assert.equal(summary.suites.length, 2);
  assert.deepEqual(
    summary.suites.map((/** @type {{ suite: string, ok: boolean }} */ s) => [s.suite, s.ok]),
    [['alpha', true], ['beta', true]]
  );
});

test('summary marks a failing suite', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'run-regressions-fail-'));
  const summaryPath = join(root, 'regression-summary.json');
  const code = await run([summaryPath], {
    suites: ['/fake/good.test.mjs', '/fake/bad.test.mjs'],
    runSuite: async (suitePath) =>
      basename(suitePath) === 'bad.test.mjs'
        ? { suite: 'bad', passed: 1, failed: 2, failures: ['case a', 'case b'] }
        : { suite: 'good', passed: 4, failed: 0, failures: [] },
  });
  assert.equal(code, 1);
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(summary.passed, false);
  const bad = summary.suites.find((/** @type {{ suite: string }} */ s) => s.suite === 'bad');
  assert.ok(bad);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures, ['case a', 'case b']);
  const good = summary.suites.find((/** @type {{ suite: string }} */ s) => s.suite === 'good');
  assert.ok(good);
  assert.equal(good.ok, true);
});

test('a suite reporting zero tests is marked failing (fail-closed)', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'run-regressions-zero-'));
  const summaryPath = join(root, 'regression-summary.json');
  const code = await run([summaryPath], {
    suites: ['/fake/silent.test.mjs'],
    runSuite: async () => ({ suite: 'silent', passed: 0, failed: 0, failures: [] }),
  });
  assert.equal(code, 1);
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(summary.passed, false);
  assert.equal(summary.suites[0].ok, false);
});
