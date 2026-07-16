// @ts-check
import { join } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { listDirEntries, readTextFile } from '../lib/fs-safe.mjs';
import { validateWorkerReturn } from '../lib/context/worker-contract.mjs';

/** Directories never worth descending into for artifact discovery. */
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** Suffix that marks a worker-return artifact. */
const ARTIFACT_SUFFIX = '.worker-return.json';

/**
 * Recursively collect every `*.worker-return.json` file under a root.
 * Uses node:fs/promises only — no third-party glob.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function findArtifacts(root) {
  /** @type {string[]} */
  const found = [];

  /** @param {string} dir */
  async function walk(dir) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await listDirEntries(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(ARTIFACT_SUFFIX)) {
        found.push(full);
      }
    }
  }

  await walk(root);
  found.sort();
  return found;
}

/**
 * E4-8: `worker-contract-check` — CI linter for worker-return artifacts (TCM-10).
 *
 * Validates every `*.worker-return.json` file under the root against the
 * WorkerReturn contract, printing a per-file pass/fail summary.
 *
 * Usage:
 *   node scripts/worker-contract-check.mjs [root]
 *
 * Exit: 0 if all artifacts pass or none are found; 1 if any artifact is invalid.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const root = args[0] || process.cwd();
  const files = await findArtifacts(root);

  if (files.length === 0) {
    process.stdout.write('No worker-return artifacts found\n');
    return 0;
  }

  let failures = 0;
  for (const file of files) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(await readTextFile(file));
    } catch (/** @type {any} */ err) {
      failures++;
      process.stdout.write(`FAIL ${file}\n  - unreadable or invalid JSON: ${err?.message ?? String(err)}\n`);
      continue;
    }
    const { ok, errors } = validateWorkerReturn(parsed);
    if (ok) {
      process.stdout.write(`PASS ${file}\n`);
    } else {
      failures++;
      process.stdout.write(`FAIL ${file}\n`);
      for (const e of errors) process.stdout.write(`  - ${e}\n`);
    }
  }

  process.stdout.write(`\n${files.length - failures}/${files.length} worker-return artifact(s) valid.\n`);
  return failures > 0 ? 1 : 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
