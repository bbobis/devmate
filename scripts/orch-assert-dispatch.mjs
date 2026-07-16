// @ts-check
/**
 * E2-gate: orch-assert-dispatch — validate a subagent dispatch result (TCM-9, P3).
 *
 * Usage:
 *   node scripts/orch-assert-dispatch.mjs --agent <name> --file <path>
 *   node scripts/orch-assert-dispatch.mjs --agent fullstack --file <path> --trace <trace.jsonl>
 *
 * Reads the JSON result file and calls assertDispatchResult(). For a
 * trace-backed agent (fullstack, and its frontend/backend/editor personas)
 * `--trace` is required: the result must be corroborated by a `subagent_start`
 * trace event via assertDispatchResultBacked(), so an `ok` result the
 * orchestrator hand-authored to satisfy the validator — with no real dispatch
 * behind it — is rejected regardless of its shape.
 * Prints a single-line JSON {ok, error?} to stdout.
 * Exit: 0 on ok; 1 on validation failure; 2 on usage/read error.
 */

import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { parseJsonl } from '../lib/json-io.mjs';
import {
  assertDispatchResult,
  assertDispatchResultBacked,
  isTraceBackedResultAgent,
} from '../lib/workflow/orchestrator.mjs';

/**
 * Parse argv tokens deterministically using explicit positional checks.
 * No regex — token splitting only.
 * @param {string[]} args
 * @returns {{ agent: string|undefined, file: string|undefined, trace: string|undefined }}
 */
function parseArgs(args) {
  let agent;
  let file;
  let trace;
  for (let i = 0; i < args.length; i++) {
    const next = args.at(i + 1);
    if (args[i] === '--agent' && i + 1 < args.length) {
      agent = next;
      i += 1;
    } else if (args[i] === '--file' && i + 1 < args.length) {
      file = next;
      i += 1;
    } else if (args[i] === '--trace' && i + 1 < args.length) {
      trace = next;
      i += 1;
    }
  }
  return { agent, file, trace };
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
  const { agent, file, trace } = parseArgs(args);

  if (typeof agent !== 'string' || agent.trim() === '') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --agent' }) + '\n');
    return 2;
  }
  const agentName = agent.trim();

  if (!isSafePath(file)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing or invalid --file' }) + '\n');
    return 2;
  }

  // A trace-backed agent (fullstack + its personas) must prove the result came
  // from a real dispatch, so --trace is mandatory. Without it the check would
  // silently fall back to shape-only, and the guard could be bypassed by simply
  // omitting the flag — the failure this whole path exists to prevent.
  const traceBacked = isTraceBackedResultAgent(agentName);
  if (traceBacked && !isSafePath(trace)) {
    const error = `missing or invalid --trace — required to prove the ${agentName} result is backed by a real dispatch`;
    process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    return 2;
  }

  /** @type {unknown} */
  let parsed;
  try {
    const raw = readTextFileSync(/** @type {string} */ (file));
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failure = JSON.stringify({ ok: false, error: `cannot read file: ${msg}` });
    process.stdout.write(failure + '\n');
    return 1;
  }

  if (!traceBacked) {
    const result = assertDispatchResult(agentName, parsed);
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  // Load the task trace. A missing or unreadable trace means no dispatch has
  // been recorded — fall through with an empty event list so the backing check
  // fails closed (reject a result we cannot tie to a real subagent run).
  /** @type {unknown[]} */
  let traceEvents = [];
  try {
    const raw = readTextFileSync(/** @type {string} */ (trace));
    traceEvents = parseJsonl(raw);
  } catch {
    traceEvents = [];
  }

  const result = assertDispatchResultBacked(agentName, parsed, traceEvents);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  process.exit(main(process.argv.slice(2)));
}
