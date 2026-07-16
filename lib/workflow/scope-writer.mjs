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
import { resolve } from 'node:path';
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
 * @param {string} repoRoot
 * @param {{ taskId: string, lane: Lane, allowedPaths: readonly string[], allowedGlobs: readonly string[] }} scope
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string }>}
 */
export async function writeScope(repoRoot, scope) {
  const paths = scope.allowedPaths.filter((p) => typeof p === 'string' && p.trim() !== '');
  const globs = scope.allowedGlobs.filter((g) => typeof g === 'string' && g.trim() !== '');

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
