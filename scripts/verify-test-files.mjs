// @ts-check
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion } from "../lib/env-guard.mjs";
import { ensureDirSync, pathExists, writeTextFileSync } from "../lib/fs-safe.mjs";
import { readTaskState } from "../lib/task-state.mjs";

/** @typedef {import('../lib/types.mjs').TaskState} TaskState */
/** @typedef {import('../lib/types.mjs').TddScenario} TddScenario */

/**
 * Per-file verification result.
 * @typedef {Object} TestFileResult
 * @property {string} id
 * @property {string} testFile
 * @property {1|2|3}  tier
 * @property {'EXISTS'|'MISSING'|'PATH_VIOLATION'} status
 * @property {string} [detail]
 */

/**
 * Write verifier results to .devmate/state/test-files-result.json.
 * @param {string} repoRoot
 * @param {TestFileResult[]} results
 * @returns {void}
 */
function writeResults(repoRoot, results) {
  const stateDir = join(repoRoot, ".devmate", "state");
  ensureDirSync(stateDir);
  writeTextFileSync(
    join(stateDir, "test-files-result.json"),
    JSON.stringify(results, null, 2),
  );
}

/**
 * Check whether a resolved path is inside the repository root.
 * @param {string} repoRoot
 * @param {string} resolvedPath
 * @returns {boolean}
 */
function isInsideRepoRoot(repoRoot, resolvedPath) {
  const normalizedRoot = resolve(repoRoot).replace(/\\/g, "/");
  const normalizedPath = resolve(resolvedPath).replace(/\\/g, "/");
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot + "/")
  );
}

/**
 * Reads testPlan from task state JSON and verifies every declared testFile
 * exists on disk. Fails closed: exits 1 when testPlan is empty, any file is
 * missing, or state cannot be read. Never executes any test command.
 * @param {string} repoRoot  Absolute path to the repo root.
 * @returns {Promise<void>}  Resolves when all files exist; rejects otherwise.
 */
export async function verifyTestFiles(repoRoot) {
  const statePath = join(repoRoot, ".devmate", "state", "task.json");
  const stateResult = readTaskState(statePath);
  /** @type {TestFileResult[]} */
  const results = [];

  if (!stateResult.ok) {
    writeResults(repoRoot, results);
    throw new Error("state unreadable");
  }

  const state = /** @type {TaskState} */ (stateResult.state);
  const plan = state.testPlan;
  if (!Array.isArray(plan) || plan.length === 0) {
    writeResults(repoRoot, results);
    throw new Error("testPlan is empty");
  }

  for (const scenario of plan) {
    const declared = /** @type {TddScenario} */ (scenario);
    const resolvedPath = resolve(repoRoot, declared.testFile);

    if (!isInsideRepoRoot(repoRoot, resolvedPath)) {
      results.push({
        id: declared.id,
        testFile: declared.testFile,
        tier: declared.tier,
        status: "PATH_VIOLATION",
        detail: "testFile resolves outside repoRoot",
      });
      continue;
    }

    results.push({
      id: declared.id,
      testFile: declared.testFile,
      tier: declared.tier,
      status: pathExists(resolvedPath) ? "EXISTS" : "MISSING",
    });
  }

  writeResults(repoRoot, results);

  const hasFailure = results.some(
    (r) => r.status === "MISSING" || r.status === "PATH_VIOLATION",
  );
  if (hasFailure) {
    throw new Error("missing test files");
  }
}

/**
 * Script entrypoint.
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  const repoRoot = process.cwd();
  try {
    await verifyTestFiles(repoRoot);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`verify-test-files: ${msg}\n`);
    return 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (entryPath === modulePath) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
