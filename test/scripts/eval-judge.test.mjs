// @ts-check
/**
 * E9-25: opt-in LLM-judge tier — no-op path, artifact shape with a stubbed
 * judge, honest null ("Unknown") verdicts, and the no-hardcoded-model-ID
 * guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../scripts/eval-judge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Silence stdout while driving the CLI. */
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

const CASES = [
  { id: 'case-a', body: '## Do the thing\n\n- AC one\n- AC two' },
  { id: 'case-b', body: '## Do the other thing\n\n- AC one' },
];

test('no-ops and exits 0 when DEVMATE_JUDGE unset', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'eval-judge-noop-'));
  const resultsPath = join(root, 'judge-latest.json');
  const code = await run([resultsPath], { env: {}, cases: CASES });
  assert.equal(code, 0);
  await assert.rejects(fsp.access(resultsPath), 'no artifact is written on the no-op path');
});

test('emits judge-latest.json with stubbed judge', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'eval-judge-stub-'));
  const resultsPath = join(root, 'judge-latest.json');
  const code = await run([resultsPath], {
    env: { DEVMATE_JUDGE: '1' },
    cases: CASES,
    judge: async (issueCase) => ({
      issueId: issueCase.id,
      claimsTrue: true,
      acTestable: true,
      rationale: 'stub: claims verified against sources; ACs each name an observable check',
    }),
  });
  assert.equal(code, 0);
  const summary = JSON.parse(await fsp.readFile(resultsPath, 'utf8'));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.judged, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(
    summary.verdicts.map((/** @type {{ issueId: string }} */ v) => v.issueId),
    ['case-a', 'case-b']
  );
  for (const v of summary.verdicts) {
    assert.equal(v.claimsTrue, true);
    assert.equal(v.acTestable, true);
    assert.equal(typeof v.rationale, 'string');
  }
});

test('allows null (Unknown) verdicts', async () => {
  // No stub: the default judge runs against the repo policy, whose entries
  // are unverified placeholders — every dimension must be an honest null,
  // never an invented boolean, and the run still succeeds.
  const root = await fsp.mkdtemp(join(tmpdir(), 'eval-judge-null-'));
  const resultsPath = join(root, 'judge-latest.json');
  const code = await run([resultsPath], {
    env: { DEVMATE_JUDGE: '1' },
    cases: CASES.slice(0, 1),
  });
  assert.equal(code, 0);
  const summary = JSON.parse(await fsp.readFile(resultsPath, 'utf8'));
  assert.equal(summary.judgeModel, null);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.failed, 0);
  const verdict = summary.verdicts[0];
  assert.equal(verdict.claimsTrue, null);
  assert.equal(verdict.acTestable, null);
  assert.match(verdict.rationale, /Unknown/);
});

test('does not hardcode a model ID', async () => {
  const source = await fsp.readFile(
    join(__dirname, '..', '..', 'scripts', 'eval-judge.mjs'),
    'utf8'
  );
  // The judge model must come from config/model-policy.json — never a
  // literal vendor model identifier in the script.
  assert.doesNotMatch(source, /claude-|gpt-|gemini|-sonnet|-opus|-haiku|o[13]-mini/i);
  assert.match(source, /judge model from verified policy \(E9-11\); do not hardcode an ID/);
  assert.match(source, /loadModelPolicy/);
});

test('explicitly false verdicts exit non-zero (nightly-only signal)', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'eval-judge-fail-'));
  const resultsPath = join(root, 'judge-latest.json');
  const code = await run([resultsPath], {
    env: { DEVMATE_JUDGE: '1' },
    cases: CASES,
    judge: async (issueCase) => ({
      issueId: issueCase.id,
      claimsTrue: issueCase.id === 'case-a' ? false : true,
      acTestable: true,
      rationale: 'stub: case-a cites a source that does not exist',
    }),
  });
  assert.equal(code, 1);
  const summary = JSON.parse(await fsp.readFile(resultsPath, 'utf8'));
  assert.equal(summary.failed, 1);
});
