// @ts-check
/**
 * E9-10: orch-assert-router — enforce the router confidence threshold (P1).
 *
 * Usage:
 *   node scripts/orch-assert-router.mjs [--file <path>]
 *
 * Reads the router result JSON (default `.devmate/state/router-result.json`),
 * validates it via parseRouterResult, and compares confidence to
 * MIN_ROUTER_CONFIDENCE. Prints a single-line JSON {ok, escalate?, error?} to
 * stdout.
 * Exit: 0 = proceed; 1 = escalate to human (confidence below threshold);
 *       2 = usage/read/parse error.
 */

import { readTextFileSync } from '../lib/fs-safe.mjs';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { parseRouterResult, MIN_ROUTER_CONFIDENCE } from '../lib/routing/router.mjs';

/** Default router result path when --file is not supplied. */
const DEFAULT_ROUTER_RESULT = '.devmate/state/router-result.json';

/**
 * Parse argv tokens deterministically using explicit positional checks.
 * @param {string[]} args
 * @returns {{ file: string|undefined }}
 */
function parseArgs(args) {
  let file;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && i + 1 < args.length) {
      file = args.at(i + 1);
      i += 1;
    }
  }
  return { file };
}

/**
 * Validate a file path at the input boundary.
 * @param {string} p
 * @returns {boolean}
 */
function isSafePath(p) {
  return p.length > 0 && !p.includes('\0');
}

/**
 * @param {string[]} args
 * @returns {number}
 */
export function main(args) {
  const { file } = parseArgs(args);
  const path = file ?? DEFAULT_ROUTER_RESULT;

  if (!isSafePath(path)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --file' }) + '\n');
    return 2;
  }

  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readTextFileSync(path));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failure = JSON.stringify({ ok: false, error: `cannot read/parse router result: ${msg}` });
    process.stdout.write(failure + '\n');
    return 2;
  }

  const parsed = parseRouterResult(raw);
  if (!parsed.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: parsed.error }) + '\n');
    return 2;
  }

  const { confidence, lane } = parsed.result;
  if (confidence < MIN_ROUTER_CONFIDENCE) {
    const escalation = JSON.stringify({
      ok: false,
      escalate: true,
      error:
        `Router confidence ${confidence} is below the ${MIN_ROUTER_CONFIDENCE} threshold ` +
        `for lane "${lane}" — escalate to human for lane confirmation before proceeding.`,
    });
    process.stdout.write(escalation + '\n');
    return 1;
  }

  process.stdout.write(JSON.stringify({ ok: true, lane, confidence }) + '\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  process.exit(main(process.argv.slice(2)));
}
