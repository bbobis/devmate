// @ts-check
// P06: Unified scope.md schema — parse, validate, and enforce the edit-boundary
// contract shared by all three workflow lanes (bug, chore, feature).
//
// Canonical scope.md format:
//
//   ---
//   lane: chore
//   ---
//   # Scope
//
//   ## Allowed paths
//   - package.json
//
//   ## Allowed globs
//   - docs/**/*.md
//
// The gate-guard reads this file via readScopeForTask, parses it with
// parseScope, and passes the result to evaluateGuard via opts.scope.  An
// absent scope.md is never a denial — enforcement only activates when the file
// is present and parseable.

import { readTextFile } from '../fs-safe.mjs';
import { resolve, sep } from 'node:path';
import { matchGlob } from '../gate-guard-core.mjs';

/** @typedef {import('../types.mjs').ParsedScope} ParsedScope */

/**
 * #187 — true when an edit TARGET resolves OUTSIDE the workspace root: a `..`
 * traversal that rises above the root, or an absolute path pointing elsewhere.
 *
 * This is the enforcement-side complement of #170/#180's write-side scope
 * sanitization. `matchGlob` matches segment-by-segment (a `**` consumes any
 * segments, `*`/`?` match a literal `..` or absolute segment), so a wildcard-
 * leading glob — including the always-on test-glob floor `**` + `/*.test.mjs` —
 * matches an out-of-workspace path and gate-guard Rule 6 would AUTHORIZE the edit.
 * The only layer that can close that is the enforcement boundary: resolve the
 * target against the root and refuse anything that escapes, BEFORE consulting the
 * (fuzzy) glob contract.
 *
 * Resolution-based, never a naive `..`-substring reject: a contained
 * `sub/../lib/x.mjs` and an absolute path INSIDE the workspace both pass, while
 * `../../etc/passwd`, `/etc/passwd`, and `C:\Windows\x` are caught. Multi-root is
 * respected — a workspace-relative path resolves under the monoroot parent.
 * Separators are normalized `\` → `/` first, mirroring the guard's own matching,
 * and containment tests `resolved === root || resolved.startsWith(root + sep)` so
 * a sibling directory sharing a name prefix (`/ws/root-evil`) cannot slip through.
 *
 * Bounds the DECLARED target lexically — it deliberately does NOT `realpath`
 * (the pure evaluator forbids I/O, and a stat on the hot path would add TOCTOU),
 * so a symlink INSIDE the workspace pointing out is out of scope for this layer.
 * The `startsWith` compare is byte-wise: on Windows a differing-case absolute path
 * errs toward deny (fail-closed), which the real flow never hits since the edit
 * path and the root share casing by construction (both from the same host cwd).
 *
 * @param {string} repoRoot   Absolute workspace root.
 * @param {string} filePath   The edit target (workspace-relative or absolute).
 * @returns {boolean}          True when the target escapes the workspace.
 */
export function pathEscapesWorkspace(repoRoot, filePath) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const root = resolve(repoRoot);
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  const resolved = resolve(root, filePath.replace(/\\/g, '/'));
  return !(resolved === root || resolved.startsWith(withSep));
}

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}  ok
 * @property {string[]} errors  Human-readable error messages when ok is false.
 */

/**
 * B5: Options for enforceScope.
 * @typedef {Object} EnforceScopeOpts
 * @property {string} [repoPrefix]  When provided, strip this prefix (e.g. 'api/')
 *   from `filePath` before testing against allowedPaths. Used in multi-root mode
 *   where the gate-guard sees workspace-relative paths but scope.md may contain
 *   either workspace-relative OR repo-relative paths. Must end with '/'.
 */

/** Valid lane values accepted by validateScope. */
const VALID_LANES = /** @type {const} */ (['bug', 'chore', 'feature']);

/**
 * Parse a scope.md content string into a typed scope contract.
 *
 * Frontmatter: a `---\nlane: <value>\n---` block at the start of the file.
 * Sections: `## Allowed paths` and `## Allowed globs` each followed by
 * bullet lines (`- <entry>`). Missing sections yield empty arrays.
 * Unknown frontmatter keys are silently ignored.
 *
 * @param {string} content  Raw scope.md content.
 * @returns {ParsedScope}
 */
export function parseScope(content) {
  const normalized = content.replace(/\r\n/g, '\n');

  // Extract the `lane:` value from YAML-style frontmatter `---\n...\n---`.
  let lane = '';
  let body = normalized;
  if (normalized.startsWith('---\n')) {
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const fmBody = normalized.slice(4, endIdx);
      for (const line of fmBody.split('\n')) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('lane:')) {
          lane = trimmed.slice(5).trim();
          break;
        }
      }
      body = normalized.slice(endIdx + '\n---\n'.length);
    }
  }

  /**
   * Extract bullet list items from a named `## <heading>` section.
   * Stops at the next `## ` heading or end of string.
   * Uses `[^\S\n]` to match only horizontal whitespace so that blank lines
   * between sections are NOT consumed by the header pattern.
   * @param {string} sectionHeading  Heading text (without `## `).
   * @returns {string[]}
   */
  function extractSection(sectionHeading) {
    const lines = body.split('\n');
    const headingNeedle = sectionHeading.trim().toLowerCase();
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('##')) continue;
      const text = trimmed.slice(2).trim().toLowerCase();
      if (text === headingNeedle) {
        start = i + 1;
        break;
      }
    }
    if (start === -1) return [];

    /** @type {string[]} */
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('##')) break;
      if (!trimmed.startsWith('- ')) continue;
      const entry = trimmed.slice(2).trim();
      if (entry.length > 0) out.push(entry);
    }
    return out;
  }

  return {
    allowedPaths: extractSection('Allowed paths'),
    allowedGlobs: extractSection('Allowed globs'),
    lane: /** @type {ParsedScope['lane']} */ (lane),
  };
}

/**
 * Validate a parsed scope contract.  Non-throwing — mirrors the
 * `validateDiagnosisResult` convention: returns `{ ok, errors }`.
 *
 * @param {ParsedScope} parsed
 * @returns {ValidationResult}
 */
export function validateScope(parsed) {
  /** @type {string[]} */
  const errors = [];

  if (!parsed.lane || !(/** @type {readonly string[]} */ (VALID_LANES)).includes(parsed.lane)) {
    errors.push(
      `Invalid or missing lane: '${parsed.lane}'. Must be one of: ${VALID_LANES.join(', ')}.`,
    );
  }
  if (parsed.allowedPaths.length === 0 && parsed.allowedGlobs.length === 0) {
    errors.push(
      'Scope contract has no allowedPaths and no allowedGlobs — nothing is permitted.',
    );
  }
  for (const p of parsed.allowedPaths) {
    if (typeof p !== 'string' || p.trim() === '') {
      errors.push(`allowedPaths contains an invalid entry: ${JSON.stringify(p)}`);
    }
  }
  for (const g of parsed.allowedGlobs) {
    if (typeof g !== 'string' || g.trim() === '') {
      errors.push(`allowedGlobs contains an invalid entry: ${JSON.stringify(g)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Enforce scope: returns `{ allowed: true }` when `filePath` matches any
 * entry in `scope.allowedPaths` (literal equality, after path-separator
 * normalization) or any entry in `scope.allowedGlobs` (via `matchGlob`).
 * Returns `{ allowed: false, reason }` when the path falls outside all
 * permitted entries.
 *
 * B5 — multi-root support: when `opts.repoPrefix` is supplied the incoming
 * `filePath` is also tested after the prefix is stripped, so a workspace-
 * relative path like `api/src/index.ts` matches an allowedPath of
 * `api/src/index.ts` (written by `writeChoreScope` in multi-root mode) as
 * well as a legacy repo-relative entry `src/index.ts` that predates B5.
 * Single-root consumers pass no opts and are completely unaffected.
 *
 * @param {string} filePath  File path being written.
 * @param {ParsedScope} scope  Parsed scope contract.
 * @param {EnforceScopeOpts} [opts]
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function enforceScope(filePath, scope, opts = {}) {
  const normalized = filePath.replace(/\\/g, '/');

  // B5: derive the repo-relative form so legacy scope.md entries (pre-B5,
  // written without the repo prefix) can still match in multi-root setups.
  const repoPrefix = opts.repoPrefix
    ? (opts.repoPrefix.endsWith('/') ? opts.repoPrefix : `${opts.repoPrefix}/`)
    : '';
  const repoRelative =
    repoPrefix && normalized.startsWith(repoPrefix)
      ? normalized.slice(repoPrefix.length)
      : null;

  for (const p of scope.allowedPaths) {
    const normalizedP = p.replace(/\\/g, '/');
    if (normalizedP === normalized) return { allowed: true };
    // Also accept the legacy repo-relative form for backwards compat.
    if (repoRelative !== null && normalizedP === repoRelative) return { allowed: true };
  }

  for (const g of scope.allowedGlobs) {
    if (matchGlob(g, normalized)) return { allowed: true };
    if (repoRelative !== null && matchGlob(g, repoRelative)) return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `out of scope per scope.md (lane: ${scope.lane}): '${filePath}' is not in allowedPaths or allowedGlobs.`,
  };
}

/**
 * Read and parse the scope.md for a given task from disk.
 * Returns `null` when the file is absent, empty, or cannot be parsed —
 * never throws. The gate-guard calls this as a best-effort pre-check; any
 * read failure is silently ignored (fail-open for availability).
 *
 * @param {string} taskId
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<ParsedScope | null>}
 */
export async function readScopeForTask(taskId, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const scopePath = resolve(repoRoot, '.devmate', 'session', taskId, 'scope.md');
  try {
    const content = await readTextFile(scopePath);
    if (!content.trim()) return null;
    return parseScope(content);
  } catch (_) {
    return null;
  }
}
