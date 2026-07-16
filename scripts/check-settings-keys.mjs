// @ts-check
import { resolve } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { listDirSync, pathExists } from "../lib/fs-safe.mjs";
import {
  extractSettingKeys,
  loadKnownSettings,
  validateSettingKeys,
} from "../lib/settings-validator.mjs";

/**
 * Default set of watched files (repo-relative paths or simple globs).
 * @type {string[]}
 */
const DEFAULT_FILES = [".vscode/settings.json"];

/**
 * Print a compact violation table to stdout.
 * @param {Array<{file: string, unknownKeys: string[]}>} violations
 * @returns {void}
 */
function printViolationTable(violations) {
  process.stdout.write(
    "\nSettings key violations \u2014 unknown keys found:\n",
  );
  process.stdout.write("  " + "-".repeat(64) + "\n");
  for (const v of violations) {
    for (const k of v.unknownKeys) {
      process.stdout.write(`  ${v.file}: ${k}\n`);
    }
  }
  process.stdout.write("  " + "-".repeat(64) + "\n");
  const total = violations.reduce((n, v) => n + v.unknownKeys.length, 0);
  process.stdout.write(`  Total: ${total} unknown key(s)\n`);
  process.stdout.write(
    "\nAdd each key to docs/verified-settings.json to resolve.\n",
  );
  process.stdout.write("See docs/unverified-settings.md for guidance.\n");
}

/**
 * Expand a list of file patterns to absolute paths that exist.
 * Supports exact paths and simple *.json globs (e.g. `.devmate/*.json`).
 * @param {string[]} patterns  Repo-relative paths or simple globs.
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
function expandFiles(patterns, repoRoot) {
  const root = repoRoot ?? process.cwd();
  /** @type {string[]} */
  const result = [];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const lastSlash = pattern.lastIndexOf("/");
      const dir = pattern.slice(0, lastSlash);
      const ext = pattern.slice(pattern.lastIndexOf("."));
      const absDir = resolve(root, dir);
      if (!pathExists(absDir)) continue;
      for (const f of listDirSync(absDir)) {
        if (f.endsWith(ext)) result.push(resolve(absDir, f));
      }
    } else {
      const abs = resolve(root, pattern);
      if (pathExists(abs)) result.push(abs);
    }
  }
  return result;
}

/**
 * Main entrypoint for the settings-keys CI check.
 * @param {string[]} args  CLI args (without node/script).
 * @param {string} [allowlistPath]  Override allowlist path (for tests).
 * @param {string} [repoRoot]       Override repo root (for tests).
 * @returns {Promise<number>} exit code
 */
export async function main(args, allowlistPath, repoRoot) {
  // Parse --files flag
  let watchedPatterns = DEFAULT_FILES;
  const filesIdx = args.indexOf("--files");
  const filesVal = args.at(filesIdx + 1);
  if (filesIdx !== -1 && filesVal) {
    watchedPatterns = filesVal
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  /** @type {import('../lib/settings-validator.mjs').VerifiedSetting[]} */
  let knownSettings;
  try {
    knownSettings = loadKnownSettings(allowlistPath);
  } catch (err) {
    process.stderr.write(
      `check-settings-keys: ${/** @type {Error} */ (err).message}\n`,
    );
    return 1;
  }

  const files = expandFiles(watchedPatterns, repoRoot);

  if (files.length === 0) {
    process.stdout.write(
      "Settings key check passed. No watched files found to scan.\n",
    );
    return 0;
  }

  /** @type {Array<{file: string, unknownKeys: string[]}>} */
  const violations = [];

  for (const filePath of files) {
    let keys;
    try {
      keys = await extractSettingKeys(filePath);
    } catch (err) {
      process.stderr.write(
        `check-settings-keys: cannot parse ${filePath}: ${/** @type {Error} */ (err).message}\n`,
      );
      return 1;
    }
    const result = validateSettingKeys(keys, knownSettings);
    if (!result.ok) {
      const abs = resolve(repoRoot ?? process.cwd());
      const rel = filePath.startsWith(abs + "/")
        ? filePath.slice(abs.length + 1)
        : filePath;
      violations.push({ file: rel, unknownKeys: result.unknownKeys });
    }
  }

  if (violations.length === 0) {
    process.stdout.write(
      "Settings key check passed. All keys in watched files are verified.\n",
    );
    return 0;
  }

  printViolationTable(violations);
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
