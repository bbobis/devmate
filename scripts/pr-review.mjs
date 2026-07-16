// @ts-check
import { join } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveRepoRoot } from '../lib/init/repo-root.mjs';
import { readTaskState } from '../lib/task-state.mjs';
import { runCommand } from '../lib/loop/run-command.mjs';
import { gatherReviewContext } from '../lib/workflow/pr-review.mjs';

/**
 * `/devmate-pr-review` backing entrypoint. Deterministically gathers the review
 * context for the active task — the branch diff (capped at the boundary,
 * TCM-9), the lane's planning artifacts as pointers, and cheap alignment
 * signals — writes it to `.devmate/state/pr-review-context.json`, and prints the
 * (bounded) context JSON to stdout. Never prints the raw diff; the reviewing
 * agent reads the full diff from `git.diffFullPath` on demand.
 *
 * Flags:
 *   --state-file <path>      TaskState JSON (defaults to .devmate/state/task.json).
 *   --base <ref>             Base ref to diff against (wins over auto-detection).
 *   --include-full-output    Embed the full redacted diff in the context (escape hatch).
 *
 * Exit: 0 on success, 2 on invalid input (missing/malformed TaskState).
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const repoRoot = await resolveRepoRoot(process.cwd());

  let stateFile;
  const sIdx = args.indexOf('--state-file');
  const sVal = args.at(sIdx + 1);
  if (sIdx !== -1 && sVal) stateFile = sVal;

  let baseRef;
  const bIdx = args.indexOf('--base');
  const bVal = args.at(bIdx + 1);
  if (bIdx !== -1 && bVal) baseRef = bVal;

  const includeFullOutput = args.includes('--include-full-output');

  const stateResult = readTaskState(stateFile);
  if (!stateResult.ok) {
    process.stderr.write(`pr-review: invalid TaskState — ${stateResult.errors.join('; ')}\n`);
    return 2;
  }

  const outputDir = join(repoRoot, '.devmate', 'state');
  const ctx = await gatherReviewContext(stateResult.state, {
    run: runCommand,
    repoRoot,
    now: () => new Date(),
    outputDir,
    baseRef,
    includeFullOutput,
  });

  process.stdout.write(JSON.stringify(ctx) + '\n');
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
