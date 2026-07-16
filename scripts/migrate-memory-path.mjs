// @ts-check
import { resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { migrateMemoryPaths, MEMORY_PATH } from '../lib/memory/paths.mjs';

/**
 * Print a compact migration summary.
 * @param {import('../lib/memory/paths.mjs').MigrationResult} result
 * @param {boolean} dryRun
 * @returns {void}
 */
function printResult(result, dryRun) {
  const verb = dryRun ? 'would move' : 'moved';
  process.stdout.write(`\nMemory path migration (canonical: ${MEMORY_PATH})${dryRun ? ' — DRY RUN' : ''}\n`);
  process.stdout.write(`  ${verb}:  ${result.moved.length} (${result.moved.join(', ') || 'none'})\n`);
  process.stdout.write(`  skipped: ${result.skipped.length} (${result.skipped.join(', ') || 'none'})\n`);
  process.stdout.write(`  errors:  ${result.errors.length} (${result.errors.join('; ') || 'none'})\n`);
}

/**
 * Main entrypoint for the memory-path migration.
 * @param {string[]} args  CLI args (without node/script).
 * @param {string} [repoRoot]  Override repo root (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(args, repoRoot) {
  const dryRun = args.includes('--dry-run');
  const root = repoRoot ?? process.cwd();

  const result = await migrateMemoryPaths(resolve(root), { dryRun });
  printResult(result, dryRun);

  return result.errors.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
