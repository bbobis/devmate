// @ts-check
/**
 * E9-22: model-routing baseline harness — record + validate modes,
 * taskSetHash stability, and assertEvalBaselineExists satisfaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, computeTaskSetHash } from '../../scripts/eval-model-routing.mjs';
import { assertEvalBaselineExists } from '../../lib/routing/policy-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_EVALS_DIR = join(__dirname, '..', '..', 'evals');

/** Silence stdio during a run. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/**
 * @param {Parameters<typeof main>[1]} opts
 * @returns {Promise<{ code: number, out: string }>}
 */
async function run(opts) {
  /** @type {string[]} */
  const chunks = [];
  const capture = /** @type {typeof process.stdout.write} */ ((c) => {
    chunks.push(String(c));
    return true;
  });
  process.stdout.write = capture;
  process.stderr.write = capture;
  let code;
  try {
    code = await main([], opts);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join('') };
}

/**
 * Build a temp evals dir seeded with the repo's fixed task set.
 * @returns {Promise<string>}
 */
async function makeEvalsDir() {
  const evalsDir = await fsp.mkdtemp(join(tmpdir(), 'emr-'));
  await fsp.mkdir(join(evalsDir, 'model-routing', 'fixtures'), { recursive: true });
  await fsp.copyFile(
    join(REPO_EVALS_DIR, 'model-routing', 'fixtures', 'tasks.json'),
    join(evalsDir, 'model-routing', 'fixtures', 'tasks.json')
  );
  return evalsDir;
}

test('record mode writes baseline files', async () => {
  const evalsDir = await makeEvalsDir();
  const { code } = await run({ evalsDir, record: true });
  assert.equal(code, 0);
  // @bounded-alloc — reads three recorded baselines.
  for (const cls of ['tiny', 'standard', 'large']) {
    const baseline = JSON.parse(
      await fsp.readFile(join(evalsDir, 'model-routing', `baseline-${cls}.json`), 'utf8')
    );
    assert.equal(baseline.budgetClass, cls);
    assert.equal(typeof baseline.recordedAt, 'string');
    assert.equal(typeof baseline.taskSetHash, 'string');
    assert.equal(typeof baseline.metrics.costUsd, 'number');
    assert.equal(typeof baseline.metrics.qualityScore, 'number');
    assert.match(baseline._comment, /schema-only placeholder/);
  }
});

test('validate mode passes with committed baselines', async () => {
  const { code, out } = await run({ evalsDir: REPO_EVALS_DIR, record: false });
  assert.equal(code, 0, out);
  assert.match(out, /PASS — 3 baseline\(s\) valid/);
});

test('validate mode fails on missing baseline', async () => {
  const evalsDir = await makeEvalsDir();
  await run({ evalsDir, record: true });
  await fsp.rm(join(evalsDir, 'model-routing', 'baseline-standard.json'));
  const { code, out } = await run({ evalsDir, record: false });
  assert.equal(code, 1);
  assert.match(out, /No eval baseline for standard/);
});

test('validate mode fails on malformed baseline and stale task set hash', async () => {
  const evalsDir = await makeEvalsDir();
  await run({ evalsDir, record: true });
  // Malformed metrics.
  const p = join(evalsDir, 'model-routing', 'baseline-tiny.json');
  const baseline = JSON.parse(await fsp.readFile(p, 'utf8'));
  baseline.metrics = 'not-an-object';
  await fsp.writeFile(p, JSON.stringify(baseline), 'utf8');
  let result = await run({ evalsDir, record: false });
  assert.equal(result.code, 1);
  assert.match(result.out, /metrics must be an object/);

  // Stale hash after the task set changes.
  await run({ evalsDir, record: true });
  const fixtures = join(evalsDir, 'model-routing', 'fixtures', 'tasks.json');
  await fsp.appendFile(fixtures, '\n', 'utf8');
  result = await run({ evalsDir, record: false });
  assert.equal(result.code, 1);
  assert.match(result.out, /taskSetHash does not match/);
});

test('taskSetHash is stable', async () => {
  const a = await computeTaskSetHash(REPO_EVALS_DIR);
  const b = await computeTaskSetHash(REPO_EVALS_DIR);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('assertEvalBaselineExists satisfied', async () => {
  for (const cls of /** @type {const} */ (['tiny', 'standard', 'large'])) {
    await assertEvalBaselineExists(cls, REPO_EVALS_DIR);
  }
});
