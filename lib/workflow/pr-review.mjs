// @ts-check
// PRR-2: deterministic, injectable gatherer for the `/devmate-pr-review` skill.
//
// Gathers the review context — the current task's branch diff (capped at the
// boundary, TCM-9), the lane's planning artifacts as pointers, and a handful of
// cheap precomputed alignment signals — and writes it to
// `.devmate/state/pr-review-context.json`. The reviewing agent reads that
// digest, applies the resource-skill lenses, and emits the typed
// PrReviewArtifact; this module never judges and never prints the raw diff.
//
// Determinism: the clock (`now`) and the subprocess runner (`run`) are injected,
// exactly like `lib/workflow/rollback.mjs`. No `Date.now()` / `Math.random()` /
// direct spawn lives here, so a canned runner + fixed clock replay byte-for-byte.
//
// All git calls go through the injected runner as argv arrays (shell:false).

import { join, resolve } from 'node:path';
import { runCommand } from '../loop/run-command.mjs';
import { buildLoopOutput } from '../loop/output-cap.mjs';
import { matchGlob } from '../gate-guard-core.mjs';
import { readTextFile, pathExists } from '../fs-safe.mjs';
import { writeResult } from '../output/write-result.mjs';
import { parseAcceptanceCriteria } from '../spec-progress.mjs';
import { enforceScope, readScopeForTask } from './scope.mjs';
import { readSecurityArtifact } from './agents/security.mjs';

/** @typedef {import('../types.mjs').TaskState} TaskState */
/** @typedef {import('../types.mjs').RunCommandResult} RunCommandResult */
/** @typedef {import('../types.mjs').PrReviewContext} PrReviewContext */
/** @typedef {import('./agents/planner.mjs').PlannerArtifact} PlannerArtifact */
/** @typedef {(argv: string[], opts?: { timeoutMs?: number, cwd?: string }) => Promise<RunCommandResult>} Runner */

/** Wall-clock ceiling for any single git invocation. */
const GIT_TIMEOUT_MS = 15_000;

/** Cap on list lengths persisted into the context so the digest stays bounded. */
const MAX_LIST = 200;

/** Resource skills whose refs the reviewer consults. */
const RESOURCE_SKILLS = Object.freeze([
  'app-security-handbook',
  'coding-best-practices',
  'pragmatic-programmer',
]);

/**
 * Test-file globs used to detect changed test files. Mirrors the conservative
 * subset the TDD guard cares about; matched via the shared `matchGlob` (no
 * dynamic RegExp).
 * @type {readonly string[]}
 */
const TEST_GLOBS = Object.freeze([
  '**/*.test.mjs',
  '**/*.spec.mjs',
  '**/*.test.js',
  '**/*.test.ts',
  'test/**',
  'tests/**',
]);

/** Candidate base branches probed (in order) when none is configured/derivable. */
const BASE_CANDIDATES = Object.freeze(['main', 'master']);

/**
 * Normalize a path to forward slashes for stable comparison/matching.
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Cap a list to MAX_LIST entries. Returns `{ list, overflowed }`.
 * @template T
 * @param {T[]} items
 * @returns {{ list: T[], overflowed: boolean }}
 */
function capList(items) {
  if (items.length <= MAX_LIST) return { list: items, overflowed: false };
  return { list: items.slice(0, MAX_LIST), overflowed: true };
}

/**
 * Sanitize a token into a filesystem-safe attempt-id segment.
 * @param {string} value
 * @returns {string}
 */
function safeSegment(value) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * Parse `git diff --name-status` output into `{ status, path }` rows. Renames
 * and copies (`R100\told\tnew`) are recorded under their new path.
 * @param {string} stdout
 * @returns {Array<{ status: string, path: string }>}
 */
function parseNameStatus(stdout) {
  /** @type {Array<{ status: string, path: string }>} */
  const rows = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0].trim();
    // Renames/copies carry the destination path last; plain edits carry it at [1].
    const path = toPosix(parts[parts.length - 1].trim());
    if (path !== '') rows.push({ status, path });
  }
  return rows;
}

/**
 * Parse newline-separated file listing (e.g. `git ls-files`) into paths.
 * @param {string} stdout
 * @returns {string[]}
 */
function parseFileList(stdout) {
  return stdout
    .split('\n')
    .map((l) => toPosix(l.trim()))
    .filter((l) => l !== '');
}

/**
 * Read + JSON-parse a repo-local artifact, returning null on any failure.
 * @param {string} filePath
 * @returns {Promise<unknown|null>}
 */
async function readJsonOrNull(filePath) {
  try {
    // @trusted-local-json — repo-local session artifact authored by devmate.
    return JSON.parse(await readTextFile(filePath));
  } catch {
    return null;
  }
}

/**
 * Read the lane's planning artifacts and build the `artifacts` block plus the
 * derived inputs (planned files, scope) the alignment signals need.
 * @param {TaskState} state
 * @param {string} repoRoot
 * @returns {Promise<{
 *   artifacts: PrReviewContext['artifacts'],
 *   plannedFiles: string[],
 *   scope: import('../types.mjs').ParsedScope | null,
 * }>}
 */
async function gatherArtifacts(state, repoRoot) {
  const { taskId, lane } = state;
  const sessionDir = join(repoRoot, '.devmate', 'session');
  const taskDir = join(sessionDir, taskId);

  // --- spec (feature) -------------------------------------------------------
  const specPath = join(sessionDir, 'spec.md');
  const specFound = pathExists(specPath);
  /** @type {Array<{ id: number, text: string }>} */
  let acceptanceCriteria = [];
  /** @type {string[]} */
  let specOutOfScope = [];
  if (specFound) {
    const md = await readTextFile(specPath).catch(() => '');
    acceptanceCriteria = parseAcceptanceCriteria(md).map((c) => ({ id: c.id, text: c.text }));
    specOutOfScope = parseOutOfScope(md);
  }
  // Planned files: state.specFiles is the canonical deterministic list.
  const specFiles = Array.isArray(state.specFiles) ? state.specFiles.map(toPosix) : [];

  // --- plan (feature) -------------------------------------------------------
  const planPath = join(taskDir, 'plan.json');
  const planRaw = /** @type {PlannerArtifact|null} */ (await readJsonOrNull(planPath));
  const planFound = planRaw !== null;
  const planTasks = planFound && Array.isArray(planRaw.tasks) ? planRaw.tasks : [];
  /** @type {string[]} */
  const planFiles = [];
  for (const t of planTasks) {
    if (t && Array.isArray(t.files)) {
      for (const f of t.files) if (typeof f === 'string') planFiles.push(toPosix(f));
    }
  }

  const plannedFiles = [...new Set([...specFiles, ...planFiles])];

  // --- scope (bug/chore) ----------------------------------------------------
  const scopePath = join(taskDir, 'scope.md');
  const scope = await readScopeForTask(taskId, { repoRoot });
  const scopeFound = scope !== null;

  // --- diagnosis (bug) ------------------------------------------------------
  const diagnosisPath = join(taskDir, 'diagnosis.json');
  const diagRaw = /** @type {Record<string, unknown>|null} */ (await readJsonOrNull(diagnosisPath));
  const diagFound = diagRaw !== null;

  // --- security (all lanes, best-effort) ------------------------------------
  const securityPath = join(taskDir, 'security.json');
  let securityFound = false;
  let securityPassed = false;
  let securityFindingCount = 0;
  /** @type {string[]} */
  let securityUnverified = [];
  try {
    const sec = await readSecurityArtifact(taskId, { repoRoot });
    securityFound = true;
    securityPassed = Boolean(sec.passed);
    securityFindingCount = Array.isArray(sec.findings) ? sec.findings.length : 0;
    securityUnverified = Array.isArray(sec.unverified) ? sec.unverified.slice(0, MAX_LIST) : [];
  } catch {
    // Absent security artifact is expected on many tasks — best-effort only.
  }

  /** @type {PrReviewContext['artifacts']} */
  const artifacts = {
    spec: {
      found: specFound,
      path: specPath,
      acceptanceCriteria: acceptanceCriteria.slice(0, MAX_LIST),
      plannedFiles: specFiles.slice(0, MAX_LIST),
      outOfScope: specOutOfScope.slice(0, MAX_LIST),
    },
    plan: {
      found: planFound,
      path: planPath,
      taskCount: planTasks.length,
      files: [...new Set(planFiles)].slice(0, MAX_LIST),
      assumptions: planFound && Array.isArray(planRaw.assumptions) ? planRaw.assumptions.slice(0, MAX_LIST) : [],
      openRisks: planFound && Array.isArray(planRaw.openRisks) ? planRaw.openRisks.slice(0, MAX_LIST) : [],
      unverified: planFound && Array.isArray(planRaw.unverified) ? planRaw.unverified.slice(0, MAX_LIST) : [],
    },
    scope: {
      found: scopeFound,
      path: scopePath,
      lane: scope?.lane ?? '',
      allowedPaths: scope ? scope.allowedPaths.slice(0, MAX_LIST) : [],
      allowedGlobs: scope ? scope.allowedGlobs.slice(0, MAX_LIST) : [],
    },
    diagnosis: {
      found: diagFound,
      path: diagnosisPath,
      bugScope: diagFound && typeof diagRaw['bugScope'] === 'string' ? diagRaw['bugScope'] : '',
      suspectedLayer: diagFound && typeof diagRaw['suspectedLayer'] === 'string' ? diagRaw['suspectedLayer'] : '',
      reproCommand: diagFound && typeof diagRaw['reproCommand'] === 'string' ? diagRaw['reproCommand'] : '',
    },
    security: {
      found: securityFound,
      path: securityPath,
      passed: securityPassed,
      findingCount: securityFindingCount,
      unverified: securityUnverified,
    },
  };

  // lane parameter kept for symmetry / future lane-specific reads.
  void lane;

  return { artifacts, plannedFiles, scope };
}

/**
 * Extract bullet-list items from a `## Out of scope` section of a spec.md.
 * @param {string} markdown
 * @returns {string[]}
 */
function parseOutOfScope(markdown) {
  const lines = markdown.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) {
      const heading = trimmed.replace(/^#+/, '').trim().toLowerCase();
      inSection = heading === 'out of scope';
      continue;
    }
    if (inSection && trimmed.startsWith('- ')) {
      const entry = trimmed.slice(2).trim();
      if (entry !== '') out.push(entry);
    }
  }
  return out;
}

/**
 * Resolve the base ref to diff against. `baseRef` arg wins; else derive
 * `origin/HEAD`, else probe `main`/`master`. Returns '' when none resolves.
 * @param {Runner} run
 * @param {string} repoRoot
 * @param {string} [baseRef]
 * @returns {Promise<string>}
 */
async function resolveBaseRef(run, repoRoot, baseRef) {
  const opts = { timeoutMs: GIT_TIMEOUT_MS, cwd: repoRoot };
  if (typeof baseRef === 'string' && baseRef.trim() !== '') return baseRef.trim();

  // origin/HEAD → `refs/remotes/origin/<branch>` → `origin/<branch>`.
  const sym = await run(['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], opts);
  if (sym.exitCode === 0) {
    const ref = sym.stdout.trim();
    const marker = 'refs/remotes/';
    if (ref.startsWith(marker)) return ref.slice(marker.length);
  }

  // Probe well-known local branches.
  for (const candidate of BASE_CANDIDATES) {
    const verify = await run(['git', 'rev-parse', '--verify', '--quiet', candidate], opts);
    if (verify.exitCode === 0 && verify.stdout.trim() !== '') return candidate;
  }

  return '';
}

/**
 * Gather the deterministic PR-review context for one task and persist it to
 * `.devmate/state/pr-review-context.json`. Never throws on a missing git repo —
 * returns a context with `git.available === false` and an explanatory note.
 *
 * @param {TaskState} state
 * @param {{
 *   run?: Runner,
 *   repoRoot: string,
 *   now: () => Date,
 *   outputDir: string,
 *   baseRef?: string,
 *   includeFullOutput?: boolean,
 * }} opts
 * @returns {Promise<PrReviewContext>}
 */
export async function gatherReviewContext(state, opts) {
  const run = opts.run ?? runCommand;
  const { repoRoot, now, outputDir } = opts;
  const includeFullOutput = opts.includeFullOutput === true;
  const generatedAt = now().toISOString();

  const { artifacts, plannedFiles, scope } = await gatherArtifacts(state, repoRoot);

  const gitOpts = { timeoutMs: GIT_TIMEOUT_MS, cwd: repoRoot };

  // --- git availability -----------------------------------------------------
  let insideRepo = false;
  try {
    const check = await run(['git', 'rev-parse', '--is-inside-work-tree'], gitOpts);
    insideRepo = check.exitCode === 0 && check.stdout.trim() === 'true';
  } catch {
    insideRepo = false; // git binary missing / spawn error — treat as unavailable.
  }

  if (!insideRepo) {
    return finalize(state, generatedAt, artifacts, {
      available: false,
      baseRef: '',
      base: '',
      head: '',
      changedFiles: [],
      untrackedFiles: [],
      diffDigest: '',
      diffCapped: '',
      diffFullPath: '',
      truncated: false,
      note: 'not a git work tree — diff unavailable; review from artifacts only',
    }, plannedFiles, scope, repoRoot);
  }

  // --- resolve refs ---------------------------------------------------------
  const baseRef = await resolveBaseRef(run, repoRoot, opts.baseRef);
  const headRes = await run(['git', 'rev-parse', 'HEAD'], gitOpts);
  const head = headRes.exitCode === 0 ? headRes.stdout.trim() : '';

  // `base` is always a commit SHA (or '' when unresolved) — never a ref name,
  // per the PrReviewGit.base contract. `diffTarget` is what we actually diff
  // against: the base SHA when known, else the empty-tree sentinel so a fresh
  // repo still produces a full diff rather than erroring.
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  let base = '';
  let diffTarget = EMPTY_TREE;
  let note = '';
  if (baseRef !== '') {
    const mb = await run(['git', 'merge-base', 'HEAD', baseRef], gitOpts);
    if (mb.exitCode === 0 && mb.stdout.trim() !== '') {
      base = mb.stdout.trim();
      diffTarget = base;
    } else {
      // No common ancestor: diff against the ref's tip, resolving it to a SHA
      // so `git.base` never holds a ref name.
      const rp = await run(['git', 'rev-parse', '--verify', '--quiet', baseRef], gitOpts);
      if (rp.exitCode === 0 && rp.stdout.trim() !== '') {
        base = rp.stdout.trim();
        diffTarget = base;
        note = `no merge-base with ${baseRef}; diffing against its tip directly`;
      } else {
        note = `no merge-base and ${baseRef} unresolved; diffing against the empty tree`;
      }
    }
  } else {
    note = 'no base ref resolved (origin/HEAD, main, master all absent); diffing against empty tree';
  }

  // --- capped diff (TCM-9) --------------------------------------------------
  const diffRes = await run(['git', 'diff', diffTarget], gitOpts);
  const baseShort = safeSegment((base || baseRef || 'nobase').slice(0, 12));
  const attemptId = `pr-review-${safeSegment(state.taskId)}-${baseShort}`;
  // Branch on the flag so TypeScript resolves the correct buildLoopOutput
  // overload (its opts type is a `false`/`true` literal, not a boolean).
  const loopOutput = includeFullOutput
    ? await buildLoopOutput(diffRes, { attemptId, outputDir, includeFullOutput: true })
    : await buildLoopOutput(diffRes, { attemptId, outputDir });

  // --- changed / untracked files -------------------------------------------
  const nameStatusRes = await run(['git', 'diff', '--name-status', diffTarget], gitOpts);
  const allChanged = parseNameStatus(nameStatusRes.stdout);
  const untrackedRes = await run(['git', 'ls-files', '--others', '--exclude-standard'], gitOpts);
  const allUntracked = parseFileList(untrackedRes.stdout);

  const cappedChanged = capList(allChanged);
  const cappedUntracked = capList(allUntracked);

  /** @type {import('../types.mjs').PrReviewGit} */
  const git = {
    available: true,
    baseRef,
    base,
    head,
    changedFiles: cappedChanged.list,
    untrackedFiles: cappedUntracked.list,
    diffDigest: loopOutput.output_digest,
    diffCapped: loopOutput.output_capped,
    diffFullPath: loopOutput.full_output_path,
    truncated: cappedChanged.overflowed || cappedUntracked.overflowed,
    note,
  };
  if (includeFullOutput && 'output_full' in loopOutput) {
    git.diffFull = /** @type {import('../types.mjs').LoopOutputFull} */ (loopOutput).output_full;
  }

  return finalize(state, generatedAt, artifacts, git, plannedFiles, scope, repoRoot, allChanged);
}

/**
 * Assemble the final PrReviewContext, compute alignment signals, persist it,
 * and return it.
 * @param {TaskState} state
 * @param {string} generatedAt
 * @param {PrReviewContext['artifacts']} artifacts
 * @param {import('../types.mjs').PrReviewGit} git
 * @param {string[]} plannedFiles
 * @param {import('../types.mjs').ParsedScope | null} scope
 * @param {string} repoRoot
 * @param {Array<{ status: string, path: string }>} [changedFiles]  Full (uncapped) list for signals.
 * @returns {Promise<PrReviewContext>}
 */
async function finalize(state, generatedAt, artifacts, git, plannedFiles, scope, repoRoot, changedFiles = []) {
  const { lane } = state;
  const changedPaths = changedFiles.map((c) => c.path);
  const changedSet = new Set(changedPaths);

  // Test files changed (all lanes).
  const testFilesChanged = changedPaths.filter((p) => TEST_GLOBS.some((g) => matchGlob(g, p)));

  // Out-of-scope (bug/chore): each changed file that scope.md forbids.
  /** @type {string[]} */
  const outOfScopeFiles = [];
  if ((lane === 'bug' || lane === 'chore') && scope) {
    for (const p of changedPaths) {
      if (!enforceScope(p, scope).allowed) outOfScopeFiles.push(p);
    }
  }

  // Feature set differences against the plan's file set.
  /** @type {string[]} */
  let unlistedFiles = [];
  /** @type {string[]} */
  let plannedButUnchanged = [];
  if (lane === 'feature') {
    const plannedSet = new Set(plannedFiles);
    unlistedFiles = changedPaths.filter((p) => !plannedSet.has(p));
    plannedButUnchanged = plannedFiles.filter((p) => !changedSet.has(p));
  }

  /** @type {PrReviewContext['alignmentSignals']} */
  const alignmentSignals = {
    outOfScopeFiles: outOfScopeFiles.slice(0, MAX_LIST),
    unlistedFiles: unlistedFiles.slice(0, MAX_LIST),
    plannedButUnchanged: plannedButUnchanged.slice(0, MAX_LIST),
    testFilesChanged: testFilesChanged.slice(0, MAX_LIST),
    regressionTestPresent: testFilesChanged.length > 0,
  };

  /** @type {PrReviewContext} */
  const ctx = {
    schemaVersion: 1,
    taskId: state.taskId,
    lane,
    workflowGate: state.workflowGate,
    generatedAt,
    git,
    artifacts,
    alignmentSignals,
    resourceSkills: [...RESOURCE_SKILLS],
  };

  const contextPath = resolve(repoRoot, '.devmate', 'state', 'pr-review-context.json');
  await writeResult(contextPath, ctx);

  return ctx;
}
