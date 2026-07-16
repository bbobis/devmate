// @ts-check
// Pure logic for the entrypoint-guard regression lint (issue #48).
//
// The pre-#48 entry guard compared import.meta.url against a hand-built
// 'file://' + process.argv[1] template string. On Windows argv[1] is a
// native backslash path while import.meta.url is a three-slash POSIX URL,
// the two sides never match, and main() silently never runs — hooks fail
// open and CI guards false-green. The canonical guard is isMainModule()
// from lib/env-guard.mjs; this module finds any regression to the broken
// form so CI can reject it.

import { join, resolve } from 'node:path';
import { listDirEntries, readTextFileSync } from './fs-safe.mjs';

/**
 * The broken-guard needle, assembled from parts so this file never contains
 * the flagged substring itself.
 * @type {string}
 */
export const BROKEN_ENTRY_GUARD = 'file://' + '${process.argv[1]}';

/**
 * Directory names never scanned.
 * @type {string[]}
 */
export const EXCLUDED_DIR_NAMES = ['node_modules', '.git', 'coverage'];

/**
 * Repo-relative directory prefixes (trailing slash included) never scanned.
 * `.claude/worktrees/` holds stale local worktree copies that are not part
 * of the tracked tree.
 * @type {string[]}
 */
export const EXCLUDED_PREFIXES = ['.claude/worktrees/'];

/**
 * @typedef {Object} EntryGuardViolation
 * @property {string} file  Repo-relative path (forward slashes).
 * @property {number} line  1-based line number.
 */

/**
 * Recursively yield absolute file paths under `dir`, skipping excluded
 * directory names.
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.includes(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

/**
 * Find every `.mjs` file under `repoRoot` whose source contains the
 * Windows-broken entry-guard comparison.
 * @param {string} repoRoot  Absolute repo root to scan.
 * @returns {Promise<EntryGuardViolation[]>}
 */
export async function findBrokenEntryGuards(repoRoot) {
  /** @type {EntryGuardViolation[]} */
  const violations = [];

  for await (const abs of walk(repoRoot)) {
    if (!abs.endsWith('.mjs')) continue;

    const rel = resolve(abs)
      .slice(resolve(repoRoot).length)
      .split('\\')
      .join('/')
      .replace(/^\//, '');
    if (EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;

    let text;
    try {
      text = readTextFileSync(abs);
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? '').includes(BROKEN_ENTRY_GUARD)) {
        violations.push({ file: rel, line: i + 1 });
      }
    }
  }

  return violations;
}

/**
 * @typedef {Object} UnrunnableHook
 * @property {string} event   The hooks.json event the command is registered under.
 * @property {string} file    Repo-relative script path (forward slashes).
 * @property {string} reason  Why it cannot execute.
 */

/**
 * Find every command registered in `hooks/hooks.json` whose script cannot
 * actually execute — because the file is missing, exports no `main()`, or never
 * self-invokes.
 *
 * This is the hole {@link findBrokenEntryGuards} does not cover. That lint greps
 * for a *broken* guard; a file with **no** guard at all produces zero hits. So a
 * registered hook could load, define its functions, and exit 0 having done
 * nothing — and both the lint and the spawn smoke test (which only asserts the
 * absence of MODULE_NOT_FOUND) would pass. `hooks/spec-integrity-guard.mjs` sat
 * in exactly that state: registered as a PostToolUse command, 245 lines long,
 * and a complete no-op in production, so the human spec-approval gate was
 * unprotected against a silent post-approval edit (#75).
 *
 * A registered hook that cannot run is a total, silent failure of that
 * enforcement layer — the worst failure mode devmate has, because the docs and
 * the manifest both say it is on.
 * @param {string} repoRoot  Absolute repo root (also the plugin root in-repo).
 * @param {{ loadManifest: (root: string) => unknown, extractScriptPath: (cmd: string) => string|null }} deps
 *   Injected so this stays pure and testable without reading the real manifest.
 * @returns {UnrunnableHook[]}
 */
export function findUnrunnableHooks(repoRoot, deps) {
  /** @type {UnrunnableHook[]} */
  const violations = [];

  /** @type {{ hooks?: Record<string, unknown> } | null} */
  let manifest;
  try {
    manifest = /** @type {{ hooks?: Record<string, unknown> } | null} */ (
      deps.loadManifest(repoRoot)
    );
  } catch {
    // No readable manifest under this root — nothing is registered, so nothing
    // can be unrunnable. The manifest's own existence and validity are the
    // concern of lib/hooks/registry.mjs and the startup readiness check, not of
    // this lint, which is only about the scripts a manifest names.
    return violations;
  }
  const hooks = manifest?.hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== 'object') {
    return violations;
  }

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const rec = /** @type {Record<string, unknown>} */ (entry);

      // Check BOTH command variants. Every registration in hooks.json carries a
      // `windows` override alongside `command`, and the two are edited by hand —
      // if `windows` drifts to a different (or missing) script, Windows users get
      // a registered-but-unrunnable hook while this lint stays green on the
      // POSIX field. Windows-only hook breakage is not hypothetical in this repo
      // (#48 was exactly that). Dedupe on the resolved path so the normal case
      // (both fields naming the same script) is checked once.
      // @bounded-alloc — one Set of at most 2 entries (command, windows) per
      // hooks.json registration; the manifest is a repo-authored file with a
      // fixed handful of entries, never user input.
      /** @type {Set<string>} */
      const rels = new Set();
      for (const field of [rec['command'], rec['windows']]) {
        if (typeof field !== 'string') continue;
        const rel = deps.extractScriptPath(field);
        if (rel !== null) rels.add(rel);
      }
      if (rels.size === 0) continue; // not a .mjs command (nothing to check)

      for (const rel of rels) {
        const abs = resolve(repoRoot, rel);
        let text;
        try {
          text = readTextFileSync(abs);
        } catch {
          violations.push({ event, file: rel, reason: 'registered script does not exist' });
          continue;
        }

        // Substring checks, not a regex: `\s+…\s+` around an optional group is a
        // nested-quantifier ReDoS shape and the security lint rejects it. These
        // are the only two forms CONTRIBUTING §6 permits anyway.
        const exportsMain =
          text.includes('export async function main') ||
          text.includes('export function main');
        if (!exportsMain) {
          violations.push({
            event,
            file: rel,
            reason: 'exports no main() — see CONTRIBUTING §6',
          });
          continue;
        }

        if (!text.includes('isMainModule(import.meta.url)')) {
          violations.push({
            event,
            file: rel,
            reason:
              'never self-invokes — the hook loads and exits 0 doing nothing when spawned',
          });
          continue;
        }

        // #76: every registered entrypoint must resolve a workspace root. The
        // hook cwd is unspecified (observed: workspaceFolders[0], which the
        // monoroot layout makes the workspace's own .devmate/ folder), and no
        // hook event carries a root field — so a script that never resolves
        // one is anchoring its .devmate/ reads and writes on whatever cwd the
        // host happened to pick. That is precisely how half the hooks wrote a
        // doubled .devmate/.devmate tree while the other half wrote correctly.
        const resolvesRoot =
          text.includes('resolveHookRoot(') || text.includes('resolveRepoRoot(');
        if (!resolvesRoot) {
          violations.push({
            event,
            file: rel,
            reason:
              'never resolves a workspace root — .devmate/ paths anchor on the unspecified hook cwd; use resolveHookRoot from lib/init/repo-root.mjs',
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Format unrunnable-hook violations as a table.
 * @param {UnrunnableHook[]} violations
 * @returns {string}
 */
export function formatUnrunnableHookTable(violations) {
  const header = '| Event | Script | Why it cannot run |';
  const sep = '|---|---|---|';
  const rows = violations.map((v) => `| ${v.event} | ${v.file} | ${v.reason} |`);
  return [header, sep, ...rows].join('\n');
}

/**
 * Format violations as a compact fixed-width table for the terminal.
 * @param {EntryGuardViolation[]} violations
 * @returns {string}
 */
export function formatEntryGuardTable(violations) {
  const header = '| File | Line | Fix |';
  const sep = '|---|---|---|';
  const rows = violations.map(
    (v) => `| ${v.file} | ${v.line} | guard with isMainModule(import.meta.url) from lib/env-guard.mjs |`
  );
  return [header, sep, ...rows].join('\n');
}
