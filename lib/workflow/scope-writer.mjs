// @ts-check
/**
 * #92 — the one place a `scope.md` is serialized and written.
 *
 * The scope contract is devmate's per-file boundary: gate-guard Rule 6 denies a
 * source edit to any path outside it. It was enforced on **no lane**, because
 * the file was never written. `writeFeatureScope` and `writeChoreScope` had no
 * production callers (the orchestrator has no `execute` tool and cannot call a
 * JS function), and `@diagnose` — the agent whose prompt instructs it to author
 * the bug lane's scope.md — has no `edit` tool and cannot write a file. Rule 5
 * (persona ownership) had been switched off in #77 on the explicit reasoning
 * that Rule 6 would govern instead, so the boundary was: skipped when unpinned,
 * delegated to a contract nobody authored, and waived when that contract was
 * absent.
 *
 * As with the gate itself (#91), the fix is that the layer which can actually
 * execute writes the artifact: the hook derives scope.md from the file lists the
 * agents return, and no agent needs a tool it does not have.
 *
 * This module owns the serializer so the hook and the two lane writers cannot
 * drift into three subtly different formats — the format `lib/workflow/scope.mjs`
 * parses is unforgiving (only `- ` bullets, only `## ` headings), and a writer
 * that gets it subtly wrong produces a scope.md that parses to an EMPTY
 * contract, which Rule 6 reads as "deny every edit".
 */
import { resolve, sep } from 'node:path';
import { ensureDir, writeTextFile } from '../fs-safe.mjs';
import { DEFAULT_TEST_GLOBS } from '../gate-guard-core.mjs';

/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../types.mjs').Lane} Lane */

/**
 * The test-file glob floor. TDD writes test files the plan never enumerates, so
 * they must be in scope or the first failing test is itself an out-of-scope
 * edit. Unions the config's top-level `testGlobs`, every persona's `testGlobs`,
 * and the built-in floor, deduped.
 * @param {DevmateConfig} config
 * @returns {string[]}
 */
export function collectTestGlobs(config) {
  /** @type {Set<string>} */
  const globs = new Set(DEFAULT_TEST_GLOBS);
  const topLevel = /** @type {{ testGlobs?: string[] }} */ (config).testGlobs;
  if (Array.isArray(topLevel)) {
    for (const g of topLevel) if (typeof g === 'string' && g) globs.add(g);
  }
  for (const persona of config.personas) {
    if (Array.isArray(persona.testGlobs)) {
      for (const g of persona.testGlobs) if (typeof g === 'string' && g) globs.add(g);
    }
  }
  return [...globs];
}

/**
 * Prefix repo-relative paths with the owning persona's repo dir in a multi-root
 * workspace, where the guard sees workspace-relative paths. Idempotent. Lifted
 * out of the chore lane, which was the only writer that did this — the feature
 * lane's writer did not, so its scope.md would have matched nothing in a
 * multi-root setup.
 * @param {readonly string[]} files
 * @param {DevmateConfig} config
 * @param {string} persona  Persona whose `repo` dir owns these files.
 * @returns {string[]}
 */
export function resolveWorkspacePaths(files, config, persona) {
  if (config.mode !== 'multi-root') return [...files];
  const owner = config.personas.find((p) => p.persona === persona);
  const repo = owner?.repo ?? '';
  if (!repo) return [...files];
  const prefix = repo.endsWith('/') ? repo : `${repo}/`;
  return files.map((f) => {
    const normalized = f.replace(/\\/g, '/');
    return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;
  });
}

/**
 * #170 — drop any allowed-path entry that resolves OUTSIDE the workspace root: an
 * absolute path or a `..` traversal (`../../etc/passwd`-shaped).
 *
 * A worker return is a trusted-agent artifact, but scope.md is the exact boundary
 * that bounds `@fullstack`'s edits — and `enforceScope` matches `allowedPaths` by
 * literal equality, so an escaping entry serialized into `## Allowed paths` would
 * make gate-guard Rule 6 AUTHORIZE an edit to a path outside the workspace,
 * defeating the contract's whole purpose. Containment is lexical (matching
 * `enforceScope`'s own lexical matching), so a non-existent path is judged the
 * same way an existing one is.
 *
 * Kept entries are returned VERBATIM — never rewritten to their resolved form,
 * because `enforceScope` compares the literal string against the workspace-
 * relative edit path, and an absolute rewrite would then match nothing.
 *
 * Separators are normalized `\` → `/` before resolving, mirroring `enforceScope`,
 * which normalizes both the edit path and every allowed entry the same way before
 * matching. Without it a backslash traversal (`..\\..\\etc\\passwd`) is one opaque
 * filename to `resolve` on POSIX — judged "contained" here, yet normalized back to
 * `../../etc/passwd` at match time, which would re-open the hole on the CI/Linux
 * runner.
 *
 * @param {string} repoRoot  Absolute workspace root.
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function filterWorkspacePaths(repoRoot, paths) {
  const root = resolve(repoRoot);
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;

  /** @type {string[]} */
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const trimmed = p.trim();
    if (trimmed === '') continue;
    const resolved = resolve(root, trimmed.replace(/\\/g, '/'));
    if (resolved === root || resolved.startsWith(withSep)) out.push(p);
  }
  return out;
}

/**
 * The fixed leading path of a glob — the segments before the FIRST segment that
 * contains a glob wildcard. `matchGlob` (lib/gate-guard-core.mjs) treats only `*`
 * and `?` as wildcards (a double-star is a `*` segment); `[` and `{` are matched
 * literally, so a segment containing them is a fixed segment. '' when the glob
 * starts with a wildcard segment (a leading double-star, or `*.md`). Input must be
 * forward-slash normalized.
 * @param {string} normalizedGlob
 * @returns {string}
 */
function fixedGlobPrefix(normalizedGlob) {
  /** @type {string[]} */
  const fixed = [];
  for (const seg of normalizedGlob.split('/')) {
    if (/[*?]/.test(seg)) break;
    fixed.push(seg);
  }
  return fixed.join('/');
}

/**
 * #180 — the glob-channel counterpart of {@link filterWorkspacePaths}: drop any
 * allowed-GLOB that could authorize an edit OUTSIDE the workspace.
 *
 * `matchGlob` (lib/gate-guard-core.mjs) matches segment by segment — a double-star
 * consumes any number of segments and a literal `..` in the pattern matches a `..`
 * in the path — so an escaping glob like `../../etc/` + double-star matches
 * `../../etc/passwd`, and gate-guard Rule 6 would AUTHORIZE that edit. The bug
 * lane's `@diagnose` return is the only attacker-influenceable glob source (the
 * feature/chore lanes feed only the trusted test-glob floor). Two independent
 * escapes are dropped:
 *   - a `..` segment ANYWHERE — matchGlob matches it literally, and a leading
 *     double-star can consume `..` segments to reach outside;
 *   - an absolute or otherwise-escaping FIXED PREFIX (`/etc/` + a wildcard, or a
 *     `C:\Windows\` prefix).
 * A wildcard-leading glob with no `..` (the double-star test floor, or `*.md`) is
 * anchored inside the workspace and kept. Kept globs are returned VERBATIM so
 * `matchGlob` compares the same string.
 *
 * @param {string} repoRoot  Absolute workspace root.
 * @param {readonly string[]} globs
 * @returns {string[]}
 */
export function filterWorkspaceGlobs(repoRoot, globs) {
  const root = resolve(repoRoot);
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;

  /** @type {string[]} */
  const out = [];
  for (const g of globs) {
    if (typeof g !== 'string') continue;
    const trimmed = g.trim();
    if (trimmed === '') continue;
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) continue; // any `..` segment escapes
    const prefix = fixedGlobPrefix(normalized);
    if (prefix !== '') {
      const resolved = resolve(root, prefix);
      if (!(resolved === root || resolved.startsWith(withSep))) continue; // absolute/escaping prefix
    }
    out.push(g);
  }
  return out;
}

/**
 * Serialize a scope contract into the exact format `parseScope` accepts.
 * @param {{ lane: Lane, allowedPaths: readonly string[], allowedGlobs: readonly string[] }} scope
 * @returns {string}
 */
export function serializeScope(scope) {
  const clean = (/** @type {readonly string[]} */ xs) =>
    xs.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => `- ${x.trim()}`);

  return [
    '---',
    `lane: ${scope.lane}`,
    '---',
    '# Scope',
    '',
    '## Allowed paths',
    ...clean(scope.allowedPaths),
    '',
    '## Allowed globs',
    ...clean(scope.allowedGlobs),
    '',
  ].join('\n');
}

/** Absolute path of a task's scope contract. */
/**
 * @param {string} repoRoot
 * @param {string} taskId
 * @returns {string}
 */
export function scopePathFor(repoRoot, taskId) {
  return resolve(repoRoot, '.devmate', 'session', taskId, 'scope.md');
}

/**
 * Write a task's scope.md.
 *
 * Refuses to write an EMPTY contract. A scope.md with no paths and no globs
 * parses successfully and then denies every single edit under Rule 6 — the lane
 * would enter implementation and be unable to touch anything, which reads to a
 * user as devmate being broken rather than as a scoping failure. An empty file
 * list means the upstream artifact was empty, and the honest response is to
 * write nothing: `impl-started` then refuses for want of a scope, naming the
 * real cause.
 *
 * #170/#180: allowed paths and globs are first filtered for workspace containment
 * ({@link filterWorkspacePaths} / {@link filterWorkspaceGlobs}) — a traversal or
 * absolute entry from a worker return is dropped before it can serialize into the
 * contract. When that empties both lists, the empty-contract refusal above fires,
 * so an all-escaping return is refused, not silently written blank.
 *
 * @param {string} repoRoot
 * @param {{ taskId: string, lane: Lane, allowedPaths: readonly string[], allowedGlobs: readonly string[] }} scope
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string }>}
 */
export async function writeScope(repoRoot, scope) {
  const paths = filterWorkspacePaths(repoRoot, scope.allowedPaths);
  const globs = filterWorkspaceGlobs(repoRoot, scope.allowedGlobs);

  if (paths.length === 0 && globs.length === 0) {
    return {
      ok: false,
      reason:
        'refusing to write an empty scope.md: it would parse to a contract that denies every edit',
    };
  }

  const path = scopePathFor(repoRoot, scope.taskId);
  await ensureDir(resolve(path, '..'));
  await writeTextFile(
    path,
    serializeScope({ lane: scope.lane, allowedPaths: paths, allowedGlobs: globs }),
  );
  return { ok: true, path };
}
