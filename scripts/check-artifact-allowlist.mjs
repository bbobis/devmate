// @ts-check
import { findUnlistedFiles, loadAllowlist } from "../lib/allowlist.mjs";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";

/**
 * Default watched directories (repo-relative).
 * @type {string[]}
 */
const DEFAULT_DIRS = [".devmate", "docs", "hooks"];

/**
 * Print a compact violation table to stdout.
 * @param {string[]} unlisted
 * @returns {void}
 */
function printViolationTable(unlisted) {
  process.stdout.write(
    "\nArtifact allowlist violations — unlisted files found:\n",
  );
  process.stdout.write("  " + "-".repeat(60) + "\n");
  for (const f of unlisted) {
    process.stdout.write(`  ${f}\n`);
  }
  process.stdout.write("  " + "-".repeat(60) + "\n");
  process.stdout.write(`  Total: ${unlisted.length} unlisted file(s)\n`);
  process.stdout.write(
    "\nAdd each file to docs/artifact-allowlist.json to resolve.\n",
  );
}

/**
 * Main entrypoint for the artifact-allowlist CI check.
 * @param {string[]} args  CLI args (without node/script).
 * @param {string} [allowlistPath]  Override allowlist path (for tests).
 * @param {string} [repoRoot]       Override repo root (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(args, allowlistPath, repoRoot) {
  // Parse --dirs flag
  let watchedDirs = DEFAULT_DIRS;
  const dirsIdx = args.indexOf("--dirs");
  const dirsVal = args.at(dirsIdx + 1);
  if (dirsIdx !== -1 && dirsVal) {
    watchedDirs = dirsVal
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
  }

  /** @type {import('../lib/types.mjs').AllowlistResult} */
  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (err) {
    process.stderr.write(
      `check-artifact-allowlist: ${/** @type {Error} */ (err).message}\n`,
    );
    return 1;
  }

  const unlisted = await findUnlistedFiles(
    watchedDirs,
    allowlist.entries,
    repoRoot,
  );

  if (unlisted.length === 0) {
    process.stdout.write(
      "Artifact allowlist check passed. All files in watched dirs are listed.\n",
    );
    return 0;
  }

  printViolationTable(unlisted);
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
