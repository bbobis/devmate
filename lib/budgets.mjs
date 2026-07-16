// @ts-check
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextFile, readTextFileSync } from './fs-safe.mjs';
import { estimateTokens as sharedEstimateTokens } from './context/estimate-tokens.mjs';

/** @typedef {import('./types.mjs').FileBudget} FileBudget */
/** @typedef {import('./types.mjs').BudgetCheckResult} BudgetCheckResult */

/**
 * Resolve the default path to docs/file-budgets.json.
 * @param {string} [budgetsPath]
 * @returns {string}
 */
function resolveBudgetsPath(budgetsPath) {
  if (budgetsPath) return budgetsPath;
  const libDir = resolve(fileURLToPath(import.meta.url), '..');
  return resolve(libDir, '..', 'docs', 'file-budgets.json');
}

/**
 * Load `docs/file-budgets.json`.
 * @param {string} [budgetsPath]  Override for tests.
 * @returns {FileBudget[]}
 */
export function loadBudgets(budgetsPath) {
  const filePath = resolveBudgetsPath(budgetsPath);
  /** @type {string} */
  let raw;
  try {
    raw = readTextFileSync(filePath);
  } catch (err) {
    throw new Error(`budgets: cannot read file at ${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`budgets: malformed JSON in ${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`budgets: ${filePath} must be a JSON array of FileBudget objects`);
  }
  return /** @type {FileBudget[]} */ (parsed);
}

/**
 * Rough token estimate via the shared canonical estimator (UTF-8 bytes / 4).
 * Re-exported here so existing callers keep the public name (E9-09).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return sharedEstimateTokens(text);
}

/**
 * Measure a file and compare to its budget.
 * @param {string} filePath   Absolute path to the file.
 * @param {FileBudget} budget
 * @returns {Promise<BudgetCheckResult>}
 */
export async function checkFileBudget(filePath, budget) {
  /** @type {string} */
  let content;
  try {
    content = await readTextFile(filePath);
  } catch (err) {
    throw new Error(`budgets: cannot read file at ${filePath}: ${/** @type {Error} */ (err).message}`);
  }

  const lines = content.split('\n');
  const actualLines = lines.length;
  const actualTokensEstimate = estimateTokens(content);

  /** @type {string[]} */
  const violations = [];

  if (actualLines > budget.maxLines) {
    violations.push(
      `line count ${actualLines} exceeds maxLines ${budget.maxLines}`
    );
  }

  const { maxTokensEstimate: maxEstimate } = budget;
  if (maxEstimate !== undefined && actualTokensEstimate > maxEstimate) {
    violations.push(
      `estimated tokens ${actualTokensEstimate} exceeds maxTokensEstimate ${budget.maxTokensEstimate}`
    );
  }

  /** @type {BudgetCheckResult} */
  const result = {
    path: budget.path,
    passed: violations.length === 0,
    actualLines,
    actualTokensEstimate,
    violations,
  };

  return result;
}
