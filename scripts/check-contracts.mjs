// @ts-check

import path from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { listDirEntries, readTextFile } from '../lib/fs-safe.mjs';
import {
  validateCritiqueResult,
  validateDiagnosisResult,
  validateGrillResult,
  validatePrReviewResult,
  validateWorkerReturn,
} from '../lib/workflow/contracts.mjs';

/**
 * @typedef {Object} CheckTarget
 * @property {string} contractName
 * @property {string} relPath
 * @property {(artifact: unknown) => { ok: boolean, errors: string[] }} validator
 */

/** @type {CheckTarget[]} */
const FILE_TARGETS = [
  {
    contractName: 'DiagnosisResult',
    relPath: '.devmate/state/diagnosis.json',
    validator: validateDiagnosisResult,
  },
  {
    contractName: 'GrillResult',
    relPath: '.devmate/state/grill-result.json',
    validator: validateGrillResult,
  },
  {
    contractName: 'CritiqueResult',
    relPath: '.devmate/state/critique-result.json',
    validator: validateCritiqueResult,
  },
  {
    contractName: 'PrReviewResult',
    relPath: '.devmate/state/pr-review-result.json',
    validator: validatePrReviewResult,
  },
];

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listWorkerReturns(root) {
  const dir = path.join(root, '.devmate/state/worker-returns');
  try {
    const entries = await listDirEntries(dir);
    const base = path.resolve(dir);
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      // eslint-disable-next-line node-security/no-zip-slip -- resolved path is constrained by the base-path filter below.
      .map((e) => path.resolve(dir, e.name))
      .filter((p) => p === base || p.startsWith(`${base}${path.sep}`))
      .sort();
  } catch {
    return [];
  }
}

/**
 * @param {string} filePath
 * @param {(artifact: unknown) => { ok: boolean, errors: string[] }} validator
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
async function validateFile(filePath, validator) {
  try {
    const parsed = JSON.parse(await readTextFile(filePath));
    return validator(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`artifact could not be read/parsed: ${message}`] };
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await readTextFile(filePath);
    return true;
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  const root = process.cwd();

  /** @type {Array<{ contractName: string, absPath: string, errors: string[] }>} */
  const violations = [];
  let checkedCount = 0;

  for (const target of FILE_TARGETS) {
    const absPath = path.join(root, target.relPath);
    if (!(await fileExists(absPath).catch(() => false))) continue;
    checkedCount++;
    const result = await validateFile(absPath, target.validator);
    if (!result.ok) {
      violations.push({ contractName: target.contractName, absPath, errors: result.errors });
    }
  }

  const workerReturnFiles = await listWorkerReturns(root);
  for (const file of workerReturnFiles) {
    checkedCount++;
    const result = await validateFile(file, validateWorkerReturn);
    if (!result.ok) {
      violations.push({
        contractName: 'WorkerReturn',
        absPath: file,
        errors: result.errors,
      });
    }
  }

  const totalChecked = checkedCount;

  if (violations.length === 0) {
    process.stdout.write(
      `[check-contracts] PASS - ${totalChecked} artifact contract(s) checked, 0 violation(s).\n`,
    );
    return 0;
  }

  process.stdout.write(
    `[check-contracts] FAIL - ${totalChecked} artifact contract(s) checked, ${violations.length} violation(s).\n`,
  );
  for (const violation of violations) {
    process.stdout.write(`- ${violation.contractName}: ${violation.absPath}\n`);
    for (const error of violation.errors) {
      process.stdout.write(`  - ${error}\n`);
    }
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
