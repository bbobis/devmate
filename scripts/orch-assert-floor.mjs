// @ts-check
/**
 * orch-assert-floor — enforce the dispatch floor before an internal gate advances.
 *
 * Usage:
 *   node scripts/orch-assert-floor.mjs --gate <gate> --trace <path-to-trace.jsonl>
 *
 * Reads the task's trace JSONL and calls assertDispatchFloor(). A gate with no
 * registered floor passes; a floored gate passes only when a `subagent_start`
 * trace event proves the owning specialist was dispatched. This is the mirror
 * of orch-assert-dispatch.mjs: that script validates a dispatch *result*, this
 * one refuses to advance a gate when the orchestrator did the work inline.
 *
 * Prints a single-line JSON {ok, error?} to stdout.
 * Exit: 0 on ok; 1 on floor violation; 2 on usage error.
 */

import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { parseJsonl } from '../lib/json-io.mjs';
import { assertDispatchFloor } from '../lib/workflow/orchestrator.mjs';

/**
 * Parse argv tokens deterministically using explicit positional checks.
 * @param {string[]} args
 * @returns {{ gate: string|undefined, trace: string|undefined }}
 */
function parseArgs(args) {
  let gate;
  let trace;
  for (let i = 0; i < args.length; i++) {
    const next = args.at(i + 1);
    if (args[i] === '--gate' && i + 1 < args.length) {
      gate = next;
      i += 1;
    } else if (args[i] === '--trace' && i + 1 < args.length) {
      trace = next;
      i += 1;
    }
  }
  return { gate, trace };
}

/**
 * Validate a file path at the input boundary.
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
  const { gate, trace } = parseArgs(args);

  if (typeof gate !== 'string' || gate.trim() === '') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --gate' }) + '\n');
    return 2;
  }

  if (!isSafePath(trace)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing or invalid --trace' }) + '\n');
    return 2;
  }

  /** @type {unknown[]} */
  let traceEvents = [];
  try {
    const raw = readTextFileSync(/** @type {string} */ (trace));
    traceEvents = parseJsonl(raw);
  } catch {
    // A missing or unreadable trace means no dispatch has been recorded. Fall
    // through with an empty event list: the floor blocks a floored gate (the
    // safe direction — do not advance on inline work) and passes the rest.
    traceEvents = [];
  }

  const result = assertDispatchFloor({ gate: gate.trim(), traceEvents });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  process.exit(main(process.argv.slice(2)));
}
