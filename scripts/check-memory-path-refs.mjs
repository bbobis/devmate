// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { findNonCanonicalRefs, MEMORY_PATH } from '../lib/memory/paths.mjs';

/**
 * Print a compact table of non-canonical path reference violations.
 * @param {import('../lib/memory/paths.mjs').PathRefViolation[]} violations
 * @returns {void}
 */
function printViolations(violations) {
  process.stdout.write('\nNon-canonical memory path references found:\n');
  process.stdout.write('  ' + '-'.repeat(60) + '\n');
  for (const v of violations) {
    process.stdout.write(`  ${v.file}:${v.line}  ${v.match}\n`);
  }
  process.stdout.write('  ' + '-'.repeat(60) + '\n');
  process.stdout.write(`  Total: ${violations.length} violation(s)\n`);
  process.stdout.write(`\nReplace each with the canonical path (${MEMORY_PATH}) imported from lib/memory/paths.mjs.\n`);
}

/**
 * Main entrypoint for the non-canonical memory path CI check.
 * @param {string[]} _args  CLI args (without node/script); unused.
 * @param {string} [repoRoot]  Override repo root (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(_args, repoRoot) {
  const root = repoRoot ?? process.cwd();
  const violations = await findNonCanonicalRefs(root);

  if (violations.length === 0) {
    process.stdout.write(`Memory path check passed. All references use the canonical path (${MEMORY_PATH}).\n`);
    return 0;
  }

  printViolations(violations);
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
