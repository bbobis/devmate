// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { loadBudgets, checkFileBudget } from '../lib/budgets.mjs';
import { matchGlob } from '../lib/gate-guard-core.mjs';
import { listDir } from '../lib/fs-safe.mjs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('../lib/types.mjs').FileBudget} FileBudget */
/** @typedef {import('../lib/types.mjs').BudgetCheckResult} BudgetCheckResult */

/**
 * Expand a glob pattern against actual files in the repo.
 * Only handles simple single-dir globs (e.g. `agents/*.agent.md`).
 * Falls back to treating the pattern as a literal path if no glob chars.
 * @param {string} pattern  Repo-relative glob or literal path.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}  Matched repo-relative paths.
 */
async function expandGlob(pattern, repoRoot) {
  if (!pattern.includes('*')) {
    return [pattern];
  }
  const patternDir = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/')) : '.';
  const absDir = join(repoRoot, patternDir);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await listDir(absDir);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const matched = [];
  for (const entry of entries) {
    const relPath = patternDir === '.' ? entry : `${patternDir}/${entry}`;
    if (matchGlob(pattern, relPath)) {
      matched.push(relPath);
    }
  }
  return matched;
}

/**
 * Print a compact pass/fail table for all budget results.
 * @param {BudgetCheckResult[]} results
 * @returns {void}
 */
function printTable(results) {
  const colW = 55;
  process.stdout.write('\nFile budget check results:\n');
  process.stdout.write('  ' + '-'.repeat(colW + 22) + '\n');
  process.stdout.write(`  ${'File'.padEnd(colW)} ${'Status'.padEnd(6)} Lines  Tokens\n`);
  process.stdout.write('  ' + '-'.repeat(colW + 22) + '\n');
  for (const r of results) {
    const status = r.passed ? 'PASS  ' : 'FAIL  ';
    const { actualTokensEstimate: estimate } = r;
    const tokens = estimate !== undefined ? String(estimate) : '?';
    process.stdout.write(`  ${r.path.slice(0, colW).padEnd(colW)} ${status} ${String(r.actualLines).padStart(5)}  ${tokens.padStart(6)}\n`);
    for (const v of r.violations) {
      process.stdout.write(`    ↳ ${v}\n`);
    }
  }
  process.stdout.write('  ' + '-'.repeat(colW + 22) + '\n');
}

/**
 * Main entrypoint for the file-budget CI check.
 * @param {string[]} _args       CLI args (without node/script).
 * @param {string} [budgetsPath] Override budgets JSON path (for tests).
 * @param {string} [repoRoot]    Override repo root (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(_args, budgetsPath, repoRoot) {
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

  /** @type {FileBudget[]} */
  let budgets;
  try {
    budgets = loadBudgets(budgetsPath);
  } catch (err) {
    process.stderr.write(`check-file-budgets: ${/** @type {Error} */ (err).message}\n`);
    return 1;
  }

  /** @type {BudgetCheckResult[]} */
  const results = [];

  for (const budget of budgets) {
    const paths = await expandGlob(budget.path, root);
    if (paths.length === 0) {
      process.stdout.write(`check-file-budgets: no files matched pattern "${budget.path}" (skipping)\n`);
      continue;
    }
    for (const relPath of paths) {
      const absPath = join(root, relPath);
      /** @type {BudgetCheckResult} */
      let result;
      try {
        result = await checkFileBudget(absPath, { ...budget, path: relPath });
      } catch (err) {
        process.stderr.write(`check-file-budgets: ${/** @type {Error} */ (err).message}\n`);
        results.push({
          path: relPath,
          passed: false,
          actualLines: 0,
          actualTokensEstimate: 0,
          violations: [/** @type {Error} */ (err).message],
        });
        continue;
      }
      results.push(result);
    }
  }

  if (results.length === 0) {
    process.stdout.write('check-file-budgets: no files to check.\n');
    return 0;
  }

  printTable(results);

  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    process.stdout.write(`\nAll ${results.length} file(s) within budget. ✓\n`);
    return 0;
  }

  process.stdout.write(`\n${failed.length} file(s) exceed their budget. Fix violations above.\n`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
