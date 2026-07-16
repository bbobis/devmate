// @ts-check
import { resolve } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { queryMemory } from "../lib/memory/query.mjs";
import { REPO_LEDGER_REL } from "../lib/memory/paths.mjs";
import { writeResult } from "../lib/output/write-result.mjs";

/** @typedef {import('../lib/types.mjs').MemoryQueryRequest} MemoryQueryRequest */

// The shared repo ledger that promotion writes to (lib/memory/paths.mjs). The
// former default ('memory.jsonl') pointed at a file nothing ever writes, so a
// bare `query-memory` always returned empty. Default to the canonical ledger.
const DEFAULT_LEDGER = REPO_LEDGER_REL;

/**
 * E3-7: `query-memory` — agent-invoked bounded repo-memory query.
 *
 * Reads the repo memory ledger and prints at most `topN` compact
 * pointer+summary matches as one JSON line. Never pastes raw ledger contents.
 * Also writes result to .devmate/state/query-memory-result.json so the agent
 * can read_file when shell integration is absent (E11-1).
 *
 * Flags:
 *   --ledger <path>       Ledger path (default .devmate/state/repo/repo.jsonl).
 *   --lane <lane>         Filter to a workflow lane.
 *   --path-prefix <pfx>   Filter/boost facts whose source starts with prefix.
 *   --tag <tag>           Boost facts matching this tag (repeatable).
 *   --text <hint>         Free-text hint for keyword scoring.
 *   --top-n <n>           Max matches to return (default 10).
 *   --limit <n>           Alias of --top-n (FO-6); the later flag wins.
 *   --include-expired     Include stale facts (audit mode).
 *   --verify              Drop facts whose source no longer resolves (verify-before-use).
 *   --stale-check         Annotate discovery facts with `stale` by recomputing the
 *                         referenced file's digest (FO-6; opt-in — costs IO).
 *   --root <dir>          Repo root for --verify / --stale-check (default cwd).
 *
 * Discovery facts (FO-6) are returned visibly typed: `kind: "discovery"` plus
 * a `[discovery]` summary prefix in the output.
 *
 * Exit: 0 always (empty results are valid); 1 only on I/O error.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let ledger = DEFAULT_LEDGER;
  /** @type {MemoryQueryRequest} */
  const request = { tags: [] };
  let verify = false;
  let staleCheck = false;
  /** @type {string|undefined} */
  let root;

  for (let i = 0; i < args.length; i += 1) {
    const a = args.at(i);
    const next = args.at(i + 1);
    if (a === "--ledger" && next) {
      ledger = next;
      i += 1;
    } else if (a === "--lane" && next) {
      request.lane = next;
      i += 1;
    } else if (a === "--path-prefix" && next) {
      request.pathPrefix = next;
      i += 1;
    } else if (a === "--tag" && next) {
      /** @type {string[]} */ (request.tags).push(next);
      i += 1;
    } else if (a === "--text" && next) {
      request.text = next;
      i += 1;
    } else if ((a === "--top-n" || a === "--limit") && next) {
      const n = Number.parseInt(next, 10);
      if (Number.isFinite(n)) request.topN = n;
      i += 1;
    } else if (a === "--include-expired") {
      request.includeExpired = true;
    } else if (a === "--verify") {
      verify = true;
    } else if (a === "--stale-check") {
      staleCheck = true;
    } else if (a === "--root" && next) {
      root = next;
      i += 1;
    }
  }

  if (Array.isArray(request.tags) && request.tags.length === 0) {
    delete request.tags;
  }

  // --verify drops facts whose source no longer resolves under --root (cwd
  // by default) — verify-before-use so recall never returns stale pointers.
  // --stale-check (FO-6) annotates discovery facts instead of dropping them.
  /** @type {{ verifyRoot?: string, staleCheckRoot?: string }} */
  const opts = {};
  if (verify) opts.verifyRoot = resolve(root ?? process.cwd());
  if (staleCheck) opts.staleCheckRoot = resolve(root ?? process.cwd());
  const result = await queryMemory(ledger, request, opts);
  // Visible typing (FO-6): discovery facts carry a [discovery] prefix on
  // every output surface (stdout JSON and the state file alike).
  for (const m of result.matches) {
    if (m.kind === "discovery" && !m.summary.startsWith("[discovery] ")) {
      m.summary = `[discovery] ${m.summary}`;
    }
  }
  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/query-memory-result.json", result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
