// @ts-check
/**
 * E2-gate: orch-assert-fullstack — validate fullstack dispatch preconditions (TCM-9, P3).
 *
 * Usage:
 *   node scripts/orch-assert-fullstack.mjs --state <path>
 *
 * Reads task.json at <path> and calls assertFullstackDispatchAllowed().
 * Prints a single-line JSON {ok, error?} to stdout.
 * Exit: 0 on ok; 1 on validation failure; 2 on usage/read error.
 */

import { readTextFileSync } from '../lib/fs-safe.mjs';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { assertFullstackDispatchAllowed } from '../lib/workflow/orchestrator.mjs';

/**
 * Parse argv tokens deterministically using explicit positional checks.
 * No regex — token splitting only.
 * @param {string[]} args
 * @returns {{ state: string|undefined }}
 */
function parseArgs(args) {
  let state;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state' && i + 1 < args.length) {
      state = args.at(i + 1);
      i += 1;
    }
  }
  return { state };
}

/**
 * Validate a file path at the input boundary.
 * Rejects empty strings and paths containing NUL bytes.
 * @param {string|undefined} p
 * @returns {boolean}
 */
function isSafePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0');
}

/**
 * @param {string[]} args
 * @returns {number}
 */
export function main(args) {
  const { state } = parseArgs(args);

  if (!isSafePath(state)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing or invalid --state' }) + '\n');
    return 2;
  }

  /** @type {import('../lib/types.mjs').TaskState} */
  let taskState;
  try {
    const raw = readTextFileSync(/** @type {string} */ (state));
    taskState = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failure = JSON.stringify({ ok: false, error: `cannot read state file: ${msg}` });
    process.stdout.write(failure + '\n');
    return 1;
  }

  const result = assertFullstackDispatchAllowed(taskState);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  process.exit(main(process.argv.slice(2)));
}
