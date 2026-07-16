// @ts-check
/**
 * orch-assert-persona-scope — verify a fullstack dispatch stayed inside its
 * persona's edit boundary, at dispatch-completion time.
 *
 * Usage:
 *   node scripts/orch-assert-persona-scope.mjs --persona <name> --file <result-path> [--config <path>]
 *
 * Reads the dispatch result JSON (the same file passed to orch-assert-dispatch),
 * extracts `payload.changedFiles`, and calls assertPersonaScope(). Per-edit
 * persona attribution is infeasible in the PreToolUse guard, so this is the
 * completion-time counterpart: a dispatch result pairs `persona` with
 * `changedFiles` cleanly and parallel-safely. A file owned by a *different*
 * declared persona, or matching this persona's offLimitsGlobs, is a violation.
 *
 * The `personaScope` config mode governs the exit behaviour:
 *   - off   → no-op, exit 0.
 *   - warn  → print any violation, exit 0 (orchestrator surfaces, does not halt).
 *   - block → exit 1 on a violation (orchestrator halts the lane).
 *
 * Prints a single-line JSON {ok, error?, violations?, mode} to stdout.
 * Exit: 0 on ok/off/warn; 1 on a violation in block mode; 2 on usage error.
 */

import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { getOwn } from '../lib/object-utils.mjs';
import { loadDevmateConfig, resolvePersonaScopeMode } from '../lib/config/devmate-config.mjs';
import { assertPersonaScope } from '../lib/workflow/orchestrator.mjs';

/**
 * Parse argv tokens deterministically using explicit positional checks.
 * @param {string[]} args
 * @returns {{ persona: string|undefined, file: string|undefined, config: string|undefined }}
 */
function parseArgs(args) {
  let persona;
  let file;
  let config;
  for (let i = 0; i < args.length; i++) {
    const next = args.at(i + 1);
    if (args[i] === '--persona' && i + 1 < args.length) {
      persona = next;
      i += 1;
    } else if (args[i] === '--file' && i + 1 < args.length) {
      file = next;
      i += 1;
    } else if (args[i] === '--config' && i + 1 < args.length) {
      config = next;
      i += 1;
    }
  }
  return { persona, file, config };
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
 * Extract `payload.changedFiles` (string[]) from a parsed dispatch result.
 * @param {unknown} result
 * @returns {string[]}
 */
function changedFilesOf(result) {
  if (result === null || typeof result !== 'object') return [];
  const payload = getOwn(/** @type {Record<string, unknown>} */ (result), 'payload');
  if (payload === null || typeof payload !== 'object') return [];
  const cf = getOwn(/** @type {Record<string, unknown>} */ (payload), 'changedFiles');
  return Array.isArray(cf) ? cf.filter((x) => typeof x === 'string') : [];
}

/**
 * @param {string[]} args
 * @returns {number}
 */
export function main(args) {
  const { persona, file, config } = parseArgs(args);

  if (typeof persona !== 'string' || persona.trim() === '') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --persona' }) + '\n');
    return 2;
  }
  if (!isSafePath(file)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing or invalid --file' }) + '\n');
    return 2;
  }
  if (config !== undefined && !isSafePath(config)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --config' }) + '\n');
    return 2;
  }

  const cfgResult = config !== undefined ? loadDevmateConfig(config) : loadDevmateConfig();
  if (!cfgResult.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'config load failed', detail: cfgResult.error }) + '\n');
    return 1;
  }

  const mode = resolvePersonaScopeMode(cfgResult.config);
  if (mode === 'off') {
    process.stdout.write(JSON.stringify({ ok: true, mode }) + '\n');
    return 0;
  }

  /** @type {unknown} */
  let result;
  try {
    result = JSON.parse(readTextFileSync(/** @type {string} */ (file)));
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: 'unreadable --file', detail: msg }) + '\n');
    return 1;
  }

  const assertion = assertPersonaScope(persona.trim(), changedFilesOf(result), cfgResult.config);
  process.stdout.write(JSON.stringify({ ...assertion, mode }) + '\n');

  // warn records/surfaces but never halts; block halts on a violation.
  if (mode === 'warn') return 0;
  return assertion.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  process.exit(main(process.argv.slice(2)));
}
