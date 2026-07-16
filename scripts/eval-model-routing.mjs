// @ts-check
/**
 * E9-22: model-routing baseline harness — "measure before flipping the
 * default model".
 *
 * Modes:
 *   - Record (env-gated, `DEVMATE_EVAL_RECORD=1`): runs the fixed task set per
 *     budget class and writes `evals/model-routing/baseline-<class>.json`
 *     with cost/quality metrics. While `config/model-policy.json` ships
 *     placeholder model IDs (see E9-11), the recorded metrics are schema-only
 *     placeholders — the harness records the structure the real comparison
 *     will fill in.
 *   - Validate (default): checks every committed baseline exists, is
 *     schema-valid, and matches the current fixed task set hash; also
 *     confirms `assertEvalBaselineExists` is satisfied for each class.
 *
 * Usage:
 *   node scripts/eval-model-routing.mjs                  # validate
 *   DEVMATE_EVAL_RECORD=1 node scripts/eval-model-routing.mjs   # record
 *
 * Exit: 0 valid/recorded; 1 missing/malformed baseline or unreadable fixtures.
 */

import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { readTextFile } from '../lib/fs-safe.mjs';
import { writeJsonFileAtomic } from '../lib/json-io.mjs';
import { digestsEqual } from '../lib/digest-compare.mjs';
import { assertEvalBaselineExists } from '../lib/routing/policy-guard.mjs';

/** @typedef {import('../lib/types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../lib/types.mjs').RoutingBaseline} RoutingBaseline */

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo-root evals directory (the layout assertEvalBaselineExists expects). */
const DEFAULT_EVALS_DIR = resolve(__dirname, '..', 'evals');

/** @type {readonly BudgetClass[]} */
const BUDGET_CLASSES = Object.freeze(['tiny', 'standard', 'large']);

/**
 * Compute the stable hash of the fixed task set file.
 * @param {string} evalsDir
 * @returns {Promise<string>} sha256 hex of the fixtures file bytes
 */
export async function computeTaskSetHash(evalsDir) {
  const fixturesPath = join(evalsDir, 'model-routing', 'fixtures', 'tasks.json');
  // Normalize CRLF so the hash is stable across checkout line-ending configs
  // (Windows autocrlf would otherwise drift every committed baseline).
  const raw = (await readTextFile(fixturesPath)).replace(/\r\n/g, '\n');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Validate one parsed baseline object. Returns error strings (empty = valid).
 * The `_comment` annotation field is allowed.
 * @param {unknown} raw
 * @param {BudgetClass} budgetClass
 * @param {string} expectedHash
 * @returns {string[]}
 */
export function validateBaseline(raw, budgetClass, expectedHash) {
  /** @type {string[]} */
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`baseline-${budgetClass}.json must be a JSON object`];
  }
  const b = /** @type {Record<string, unknown>} */ (raw);
  if (b['budgetClass'] !== budgetClass) {
    errors.push(`budgetClass must equal "${budgetClass}" (got ${JSON.stringify(b['budgetClass'])})`);
  }
  if (typeof b['recordedAt'] !== 'string' || Number.isNaN(Date.parse(b['recordedAt']))) {
    errors.push('recordedAt must be a valid ISO-8601 string');
  }
  const recordedTaskSet = b['taskSetHash'];
  if (typeof recordedTaskSet !== 'string' || recordedTaskSet === '') {
    errors.push('taskSetHash must be a non-empty string');
  } else if (!digestsEqual(recordedTaskSet, expectedHash)) {
    errors.push(
      `taskSetHash does not match the current fixed task set — re-record with DEVMATE_EVAL_RECORD=1 (baseline: ${b['taskSetHash']}, current: ${expectedHash})`
    );
  }
  if (typeof b['taskCount'] !== 'number' || !Number.isInteger(b['taskCount']) || b['taskCount'] < 1) {
    errors.push('taskCount must be a positive integer');
  }
  const metrics = b['metrics'];
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) {
    errors.push('metrics must be an object');
  } else {
    const m = /** @type {Record<string, unknown>} */ (metrics);
    if (typeof m['costUsd'] !== 'number' || !Number.isFinite(m['costUsd'])) {
      errors.push('metrics.costUsd must be a finite number');
    }
    if (typeof m['qualityScore'] !== 'number' || !Number.isFinite(m['qualityScore'])) {
      errors.push('metrics.qualityScore must be a finite number');
    }
  }
  return errors;
}

/**
 * Record mode: run the fixed task set per class and write baselines.
 * While the model policy ships placeholder IDs, metrics are schema-only
 * placeholders (cost 0 / quality 0) — the structure is real, the numbers wait
 * on E9-11's verified IDs.
 * @param {string} evalsDir
 * @returns {Promise<number>}
 */
async function recordBaselines(evalsDir) {
  /** @type {string} */
  let taskSetHash;
  /** @type {Array<{ id: string, budgetClass: string, description: string }>} */
  let tasks;
  try {
    taskSetHash = await computeTaskSetHash(evalsDir);
    const fixtures = JSON.parse(
      await readTextFile(join(evalsDir, 'model-routing', 'fixtures', 'tasks.json'))
    );
    tasks = Array.isArray(fixtures?.tasks) ? fixtures.tasks : [];
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[eval-model-routing] FAIL — cannot read fixtures: ${msg}\n`);
    return 1;
  }

  for (const budgetClass of BUDGET_CLASSES) {
    const classTasks = tasks.filter((t) => t && t.budgetClass === budgetClass);
    if (classTasks.length === 0) {
      process.stderr.write(
        `[eval-model-routing] FAIL — fixed task set has no tasks for class "${budgetClass}"; refusing to record a degenerate baseline.\n`
      );
      return 1;
    }
    /** @type {RoutingBaseline & { _comment: string }} */
    const baseline = {
      _comment:
        'TODO: populate metrics once verified model IDs land (E9-11) — schema-only placeholder',
      budgetClass,
      recordedAt: new Date().toISOString(),
      taskSetHash,
      taskCount: classTasks.length,
      metrics: { costUsd: 0, qualityScore: 0 },
    };
    const outPath = join(evalsDir, 'model-routing', `baseline-${budgetClass}.json`);
    await writeJsonFileAtomic(outPath, baseline);
    process.stdout.write(
      `[eval-model-routing] recorded baseline-${budgetClass}.json (${classTasks.length} task(s), hash ${taskSetHash.slice(0, 12)}…)\n`
    );
  }
  return 0;
}

/**
 * Validate mode: every committed baseline must exist, be schema-valid, and
 * match the current task set; assertEvalBaselineExists must be satisfied.
 * @param {string} evalsDir
 * @returns {Promise<number>}
 */
async function validateBaselines(evalsDir) {
  /** @type {string} */
  let taskSetHash;
  try {
    taskSetHash = await computeTaskSetHash(evalsDir);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[eval-model-routing] FAIL — cannot read fixtures: ${msg}\n`);
    return 1;
  }

  /** @type {string[]} */
  const problems = [];
  for (const budgetClass of BUDGET_CLASSES) {
    try {
      await assertEvalBaselineExists(budgetClass, evalsDir);
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${budgetClass}: ${msg}`);
      continue;
    }
    const baselinePath = join(evalsDir, 'model-routing', `baseline-${budgetClass}.json`);
    try {
      const raw = JSON.parse(await readTextFile(baselinePath));
      for (const error of validateBaseline(raw, budgetClass, taskSetHash)) {
        problems.push(`${budgetClass}: ${error}`);
      }
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${budgetClass}: baseline unreadable/malformed: ${msg}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write('[eval-model-routing] FAIL — baseline problems:\n');
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(
      '\nRe-record with: DEVMATE_EVAL_RECORD=1 node scripts/eval-model-routing.mjs\n'
    );
    return 1;
  }

  process.stdout.write(
    `[eval-model-routing] PASS — ${BUDGET_CLASSES.length} baseline(s) valid (task set ${taskSetHash.slice(0, 12)}…).\n`
  );
  return 0;
}

/**
 * Main entrypoint.
 * @param {string[]} _args  CLI args (without node/script).
 * @param {{ evalsDir?: string, record?: boolean }} [opts]  Overrides for tests.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const evalsDir = opts.evalsDir ?? DEFAULT_EVALS_DIR;
  const record = opts.record ?? process.env.DEVMATE_EVAL_RECORD === '1';
  return record ? recordBaselines(evalsDir) : validateBaselines(evalsDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
