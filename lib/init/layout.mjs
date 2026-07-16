// @ts-check

/**
 * The canonical set of state subdirectories seeded under `.devmate/`.
 *
 * Single source of truth — reused by the initializer and tests so paths are
 * never hardcoded in multiple places. Derived from the real lazy-mkdir write
 * sites in the codebase (e.g. facts ledger, gates, task state live directly
 * under `.devmate/state/`; trace, handoff, compaction, and repo each get their
 * own subdir).
 *
 * Paths are relative to the resolved repo root.
 * @type {string[]}
 */
export const STATE_DIRS = [
  '.devmate/state',
  '.devmate/state/trace',
  '.devmate/state/handoff',
  // One file per subagent dispatch. `merge-discovery` reads this directory and
  // `orch-assert-dispatch` validates files in it, but nothing ever seeded or
  // wrote it — the dispatch protocol rested on a directory that did not exist.
  // The PostToolUse hook writes it now (lib/workflow/persist-worker-return.mjs).
  '.devmate/state/worker-returns',
  '.devmate/state/compaction',
  '.devmate/state/repo',
  '.devmate/memory/tasks',
];
