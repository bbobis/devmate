// @ts-check
/**
 * E9-10: orch-assert-router enforces the router confidence threshold in code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/orch-assert-router.mjs';
import { parseRouterResult, MIN_ROUTER_CONFIDENCE } from '../../lib/routing/router.mjs';
import { checkGatePrecondition } from '../../lib/gate-preconditions.mjs';

/** Capture stdout during a main() run. */
const realOut = process.stdout.write.bind(process.stdout);

/**
 * @param {string[]} args
 * @returns {{ code: number, out: string }}
 */
function run(args) {
  /** @type {string[]} */
  const chunks = [];
  process.stdout.write = /** @type {typeof process.stdout.write} */ ((c) => {
    chunks.push(String(c));
    return true;
  });
  let code;
  try {
    code = main(args);
  } finally {
    process.stdout.write = realOut;
  }
  return { code, out: chunks.join('') };
}

/**
 * @param {unknown} obj
 * @returns {Promise<string>} file path
 */
async function writeRouterResult(obj) {
  const dir = await mkdtemp(join(tmpdir(), 'oar-'));
  const p = join(dir, 'router-result.json');
  await writeFile(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return p;
}

test('exits 1 when confidence below threshold', async () => {
  const p = await writeRouterResult({ lane: 'feature', budgetClass: 'standard', confidence: 0.6 });
  const { code, out } = run(['--file', p]);
  assert.equal(code, 1);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.escalate, true);
  assert.match(parsed.error, /escalate to human/i);
});

test('exits 0 at/above threshold', async () => {
  const atThreshold = await writeRouterResult({ lane: 'bug', budgetClass: 'standard', confidence: MIN_ROUTER_CONFIDENCE });
  assert.equal(run(['--file', atThreshold]).code, 0);
  const above = await writeRouterResult({ lane: 'chore', budgetClass: 'tiny', confidence: 0.99 });
  const { code, out } = run(['--file', above]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.trim()).ok, true);
});

test('exits 2 on missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-missing-'));
  const { code, out } = run(['--file', join(dir, 'nope.json')]);
  assert.equal(code, 2);
  assert.equal(JSON.parse(out.trim()).ok, false);
});

test('exits 2 on malformed JSON', async () => {
  const p = await writeRouterResult('{ not json');
  const { code } = run(['--file', p]);
  assert.equal(code, 2);
});

test('rejects out-of-range confidence via parseRouterResult', async () => {
  const verdict = parseRouterResult({ lane: 'feature', budgetClass: 'standard', confidence: 1.5 });
  assert.equal(verdict.ok, false);
  const p = await writeRouterResult({ lane: 'feature', budgetClass: 'standard', confidence: 1.5 });
  assert.equal(run(['--file', p]).code, 2, 'script surfaces parse rejection as exit 2');
});

test('lane-set precondition blocks low confidence and passes at threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oar-pre-'));
  const stateDir = join(root, '.devmate', 'state');
  await mkdir(stateDir, { recursive: true });

  // No artifact → refused.
  let result = await checkGatePrecondition('lane-set', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);

  // Low confidence → refused with escalation guidance.
  await writeFile(
    join(stateDir, 'router-result.json'),
    JSON.stringify({ lane: 'feature', budgetClass: 'standard', confidence: 0.5 }),
    'utf8'
  );
  result = await checkGatePrecondition('lane-set', { stateDir, lane: 'feature' });
  assert.equal(result.ok, false);
  assert.match(result.missing.join(' '), /below the 0\.75 threshold/);

  // At threshold → allowed.
  await writeFile(
    join(stateDir, 'router-result.json'),
    JSON.stringify({ lane: 'feature', budgetClass: 'standard', confidence: 0.75 }),
    'utf8'
  );
  result = await checkGatePrecondition('lane-set', { stateDir, lane: 'feature' });
  assert.deepEqual(result, { ok: true, missing: [] });
});
