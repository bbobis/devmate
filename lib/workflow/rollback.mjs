// @ts-check
// E5-7: deterministic, confirmation-gated rollback. Replaces destructive git
// steps that previously lived in agent prose. NO destructive git command can
// run without `confirmed: true`, and a dirty working tree aborts before any
// mutation.
//
// All git calls go through the shared spawn helper (E2-5 #21) — argv arrays,
// no shell. The runner is injectable (`opts.run`) purely so tests can mock
// subprocesses; production uses the real `runCommand`.
//
// Anti-hallucination reconciliation: the live `TaskState.preImplStash` is a
// single nullable string (the stash ref), NOT a {ref, commit} pair. The
// `targetCommit` is therefore derived deterministically as the stash's base
// commit via `git rev-parse <stashRef>^1` at plan-build time. No new state
// fields are invented.

import { runCommand } from '../loop/run-command.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').RollbackPlan} RollbackPlan */
/** @typedef {import('../types.mjs').RollbackResult} RollbackResult */
/** @typedef {import('../types.mjs').RunCommandResult} RunCommandResult */
/** @typedef {(argv: string[], opts?: { timeoutMs?: number, cwd?: string }) => Promise<RunCommandResult>} Runner */

const GIT_TIMEOUT_MS = 10_000;

/** Ordered recovery hints surfaced when rollback fails. */
export const RECOVERY_HINTS = Object.freeze([
  'Run: git stash list',
  'Run: git status',
  'Run: git reflog (to find the pre-rollback HEAD)',
  'Contact a maintainer if conflicts remain',
]);

/**
 * Validate that a stash ref exists and is recoverable.
 * @param {string} stashRef
 * @param {{ run?: Runner }} [opts]
 * @returns {Promise<{ exists: boolean, reason?: string }>}
 */
export async function validateStash(stashRef, opts = {}) {
  const run = opts.run ?? runCommand;
  const result = await run(['git', 'stash', 'list'], { timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    return { exists: false, reason: `git stash list failed: ${result.stderr.trim()}` };
  }
  if (!stashRef || !result.stdout.includes(stashRef)) {
    return { exists: false, reason: `Stash not found: ${stashRef}` };
  }
  return { exists: true };
}

/**
 * Check for uncommitted/staged changes in the working tree.
 * @param {{ run?: Runner }} [opts]
 * @returns {Promise<string[]>}  Dirty file paths (empty = clean).
 */
export async function checkDirtyState(opts = {}) {
  const run = opts.run ?? runCommand;
  const result = await run(['git', 'status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^.{1,2}\s+/, ''));
}

/**
 * Build a rollback plan from TaskState. Runs NO mutating git commands.
 * @param {TaskState} state
 * @param {{ run?: Runner }} [opts]
 * @returns {Promise<RollbackPlan>}
 */
export async function buildRollbackPlan(state, opts = {}) {
  const run = opts.run ?? runCommand;
  const stashRef = state.preImplStash;
  if (!stashRef) {
    throw new Error('buildRollbackPlan: state.preImplStash is null — nothing to roll back to.');
  }

  const stash = await validateStash(stashRef, { run });
  const dirtyFiles = await checkDirtyState({ run });

  // Resolve the stash's base commit (read-only) as the reset target.
  let targetCommit = '';
  const rev = await run(['git', 'rev-parse', `${stashRef}^1`], { timeoutMs: GIT_TIMEOUT_MS });
  if (rev.exitCode === 0) targetCommit = rev.stdout.trim();

  const hasConflicts = dirtyFiles.length > 0;
  const drySummary = [
    'Rollback plan (dry-run — no changes made):',
    `  stash ref:     ${stashRef} (${stash.exists ? 'found' : 'MISSING'})`,
    `  reset target:  ${targetCommit || '(unresolved)'}`,
    `  dirty files:   ${dirtyFiles.length}`,
    `  conflict risk: ${hasConflicts ? 'yes (dirty tree)' : 'no'}`,
  ].join('\n');

  return {
    stashRef,
    targetCommit,
    dirtyFiles,
    hasConflicts,
    drySummary,
    recoveryHints: [...RECOVERY_HINTS],
  };
}

/**
 * Execute a rollback plan after confirmation. MUST NOT be called from prose.
 * @param {RollbackPlan} plan
 * @param {{ dryRun?: boolean, confirmed?: boolean, run?: Runner }} opts
 * @returns {Promise<RollbackResult>}
 */
export async function applyRollback(plan, opts) {
  const run = opts.run ?? runCommand;

  // Dry-run never touches git.
  if (opts.dryRun) {
    return { success: true, message: plan.drySummary, recoveryHints: [] };
  }

  // Confirmation is mandatory for any destructive path.
  if (!opts.confirmed) {
    throw new Error(
      'Rollback requires explicit confirmation. Pass confirmed: true or use --confirm flag.',
    );
  }

  // Abort BEFORE any mutation if the tree is dirty.
  if (plan.dirtyFiles.length > 0) {
    return {
      success: false,
      message: 'Dirty working tree detected. Commit or stash your changes first.',
      recoveryHints: plan.recoveryHints,
    };
  }

  // Stash must exist.
  if (!plan.stashRef) {
    return { success: false, message: 'No stash ref to restore.', recoveryHints: plan.recoveryHints };
  }
  const stash = await validateStash(plan.stashRef, { run });
  if (!stash.exists) {
    return {
      success: false,
      message: stash.reason ?? `Stash not found: ${plan.stashRef}`,
      recoveryHints: plan.recoveryHints,
    };
  }

  // Reset, then pop the stash. Separate spawn calls, argv arrays.
  const reset = await run(['git', 'reset', '--hard', plan.targetCommit], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (reset.exitCode !== 0) {
    return {
      success: false,
      message: `git reset --hard failed: ${reset.stderr.trim()}`,
      recoveryHints: plan.recoveryHints,
    };
  }

  const pop = await run(['git', 'stash', 'pop', plan.stashRef], { timeoutMs: GIT_TIMEOUT_MS });
  if (pop.exitCode !== 0) {
    return {
      success: false,
      message: `git stash pop failed: ${pop.stderr.trim()}`,
      recoveryHints: plan.recoveryHints,
    };
  }

  return { success: true, message: 'Rollback complete.', recoveryHints: [] };
}
