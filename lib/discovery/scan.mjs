// @ts-check
/**
 * FO-3: deterministic parallel candidate scan (Phase 1 of the fan-out/fan-in
 * two-phase discovery design).
 *
 * Candidate generation for "where is the code that does X" is the long pole
 * of implementation sessions, and none of it requires a model: it is four
 * independent, mechanical strategies (name match, content grep, import-graph
 * neighbors, test-mirror convention) that run in parallel via
 * `lib/orchestrator/fanout.mjs` and merge into one ranked, pointer-only
 * candidate list at ~zero token cost.
 *
 * Every strategy is a `FanoutWorker` thunk: it returns a validated
 * `WorkerReturn` (finding + sourcePointer only — never the full candidate
 * array, TCM-10) and pushes its actual candidates into a per-worker slot of
 * a closure-owned `Map` (the "side channel" the issue calls for). Only
 * `runDiscoveryScan` reads that map, after `fanout()` has decided which
 * workers succeeded — a timed-out or contract-violating worker's partial
 * candidates are never merged.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { fanout } from '../orchestrator/fanout.mjs';
import { WorkerReturnBuilder } from '../context/worker-contract.mjs';
import { listDirEntries, readTextFile, statPath } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').WorkerReturn} WorkerReturn */
/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../types.mjs').FanoutWorker} FanoutWorker */

/**
 * A single strategy's raw hit before merge scoring. Kept out of any
 * WorkerReturn field — travels only through the in-memory side channel.
 * @typedef {Object} RawCandidate
 * @property {string} path  Absolute or repo-relative path, either slash style.
 * @property {number} hits  Number of matches/signals this strategy found for the path.
 * @property {string} why   One-line reason, e.g. 'name match: gate' or 'git grep: 3 lines'.
 */

/**
 * A merged, scored, deduplicated candidate (`mergeCandidates` output row).
 * @typedef {Object} MergedCandidate
 * @property {string}   path
 * @property {number}   score
 * @property {string[]} strategies
 * @property {number}   hits
 * @property {string}   why
 */

const execFileAsync = promisify(execFile);

/** Directory names never descended into during a repo walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.devmate', 'dist', 'build', 'coverage']);

/** Source-file extensions considered for by-name/by-content/by-imports scanning. */
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.mts', '.cts', '.ts', '.tsx', '.jsx', '.json', '.md'];

/** Extensions tried (in order) when resolving a relative import specifier to a file. */
const RESOLVE_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.mts', '.cts', '.ts', '.tsx', '.json'];

/** Directory-index filenames tried when a specifier resolves to a directory. */
const INDEX_CANDIDATES = ['index.mjs', 'index.js', 'index.cjs', 'index.ts'];

/** Skip files larger than this when doing a pure-Node content scan (bytes). */
const MAX_TEXT_SCAN_BYTES = 1024 * 1024;

/** Hard cap on files walked/scanned per strategy invocation (bounds worst case). */
const MAX_WALK_FILES = 20_000;

/** Per-git-grep-invocation term budget, in characters, to stay well under OS argv limits. */
const GIT_GREP_CHUNK_CHAR_BUDGET = 3000;

/** git grep / fallback per-term match cap (mirrors `--max-count`). */
const MAX_COUNT_PER_TERM = 50;

/** Default budget-class → maxSources mapping. Must track `lib/context/output-contract.mjs`. */
const MAX_SOURCES_BY_BUDGET = new Map([
  ['tiny', 3],
  ['standard', 10],
  ['large', 999],
]);

/** Fixed token-cost annotation for every strategy worker (TCM-9/TCM-10: 0 LLM tokens). */
const TOKEN_NOTES = 'deterministic scan — 0 LLM tokens';

// ---------------------------------------------------------------------------
// Path helpers — pure string manipulation (no OS-specific path module calls
// on untrusted candidate strings), so behavior is identical on Windows,
// macOS, and Linux regardless of which separator a strategy happened to emit.
// ---------------------------------------------------------------------------

/**
 * @param {string} p
 * @returns {string}
 */
function toSlash(p) {
  return p.split('\\').join('/');
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isAsciiLetter(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * True when a slash-normalized path is absolute: POSIX-leading-slash or a
 * Windows drive letter (`C:/...`).
 * @param {string} slashPath
 * @returns {boolean}
 */
function isAbsoluteSlashPath(slashPath) {
  if (slashPath.startsWith('/')) return true;
  return slashPath.length >= 2 && isAsciiLetter(slashPath[0]) && slashPath[1] === ':';
}

/**
 * Resolve `rawPath` (absolute or relative, either slash style) against
 * `repoRoot`, collapsing `.`/`..` segments by hand, and return the
 * repo-relative POSIX path — or `null` when the result escapes `repoRoot`
 * (fail-closed, mirroring the contract-validator's traversal guard).
 * @param {string} repoRoot
 * @param {string} rawPath
 * @returns {string|null}
 */
export function normalizeCandidatePath(repoRoot, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;

  const rootSlash = toSlash(resolve(repoRoot));
  const rootSegs = rootSlash.split('/').filter(Boolean);

  const rawSlash = toSlash(rawPath);
  const segsIn = rawSlash.split('/').filter(Boolean);
  const startSegs = isAbsoluteSlashPath(rawSlash) ? segsIn : rootSegs.concat(segsIn);

  /** @type {string[]} */
  const stack = [];
  for (const seg of startSegs) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null; // escaped past the filesystem root
      stack.pop();
      continue;
    }
    stack.push(seg);
  }

  if (stack.length < rootSegs.length) return null;
  for (let i = 0; i < rootSegs.length; i++) {
    if (stack[i].toLowerCase() !== rootSegs[i].toLowerCase()) return null;
  }

  return stack.slice(rootSegs.length).join('/');
}

/**
 * Flatten a string for kebab/camel-case-insensitive substring comparison:
 * lowercase, then drop `-`, `_`, `.` separators.
 * @param {string} s
 * @returns {string}
 */
function flatten(s) {
  return s.toLowerCase().split('-').join('').split('_').join('').split('.').join('');
}

// ---------------------------------------------------------------------------
// Repo walk — shared by by-name, by-content's fallback, and by-imports'
// reverse-edge search.
// ---------------------------------------------------------------------------

/**
 * Recursively list files under `dir`, skipping `SKIP_DIRS`, up to
 * `MAX_WALK_FILES` total. Aborts early (returns what it has) when `signal`
 * fires. Returns absolute paths.
 * @param {string} repoRoot
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>}
 */
export async function walkRepoFiles(repoRoot, opts = {}) {
  const { signal } = opts;
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [resolve(repoRoot)];

  while (stack.length > 0) {
    if (signal?.aborted) break;
    if (out.length >= MAX_WALK_FILES) break;
    const dir = /** @type {string} */ (stack.pop());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await listDirEntries(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(resolve(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(resolve(dir, entry.name));
      }
    }
  }
  return out;
}

/**
 * True when the first characters of `text` look binary (contain a NUL char).
 * Operates on the decoded string directly — no Buffer allocation needed.
 * @param {string} text
 * @returns {boolean}
 */
function looksBinary(text) {
  const scanLen = Math.min(text.length, 512);
  for (let i = 0; i < scanLen; i++) {
    if (i < text.length && text.charCodeAt(i) === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tiny inline concurrency limiter — bounds by-content's own child-process
// fan-out at Math.min(4, availableParallelism()), independent of the outer
// fanout() concurrency (which is unbounded across the 4 strategy workers).
// ---------------------------------------------------------------------------

/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrencyLimit(items, limit, worker) {
  const results = /** @type {R[]} */ (new Array(items.length));
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

// ---------------------------------------------------------------------------
// Strategy 1 — by-name
// ---------------------------------------------------------------------------

/**
 * Match `seedTerms` against file basenames: case-insensitive substring, plus
 * a kebab/camel-case-flattened substring match.
 * @param {string} repoRoot
 * @param {string[]} seedTerms
 * @param {{ signal?: AbortSignal, limit?: number }} [opts]
 * @returns {Promise<RawCandidate[]>}
 */
export async function scanByName(repoRoot, seedTerms, opts = {}) {
  const files = await walkRepoFiles(repoRoot, { signal: opts.signal });
  const flatTerms = seedTerms.map((t) => ({ raw: t, lower: t.toLowerCase(), flat: flatten(t) }));

  /** @type {RawCandidate[]} */
  const candidates = [];
  for (const abs of files) {
    if (opts.signal?.aborted) break;
    const rel = normalizeCandidatePath(repoRoot, abs);
    if (rel === null) continue;
    const base = rel.split('/').pop() ?? rel;
    const baseLower = base.toLowerCase();
    const baseFlat = flatten(base);

    let hits = 0;
    for (const term of flatTerms) {
      if (term.lower === '') continue;
      if (baseLower.includes(term.lower) || baseFlat.includes(term.flat)) hits++;
    }
    if (hits > 0) {
      candidates.push({ path: rel, hits, why: `name match: ${base}` });
    }
  }

  const limit = opts.limit;
  candidates.sort((a, b) => b.hits - a.hits || (a.path < b.path ? -1 : 1));
  return typeof limit === 'number' ? candidates.slice(0, limit) : candidates;
}

/**
 * @param {{ repoRoot: string, seedTerms: string[] }} opts
 * @param {Map<string, RawCandidate[]>} store
 * @returns {FanoutWorker}
 */
function buildByNameWorker({ repoRoot, seedTerms }, store) {
  const workerId = 'scan-by-name';
  return async (signal) => {
    const candidates = await scanByName(repoRoot, seedTerms, { signal });
    store.set(workerId, candidates);
    return finishWorker(workerId, candidates, 'Merge with the other strategies via mergeCandidates.');
  };
}

// ---------------------------------------------------------------------------
// Strategy 2 — by-content (git grep, with a pure-Node fallback)
// ---------------------------------------------------------------------------

/**
 * Split `terms` into chunks whose combined `-e <term>` length stays under
 * `GIT_GREP_CHUNK_CHAR_BUDGET`, so a single git-grep invocation never risks
 * an OS argv-length limit.
 * @param {string[]} terms
 * @returns {string[][]}
 */
function chunkTerms(terms) {
  /** @type {string[][]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [];
  let currentChars = 0;
  for (const term of terms) {
    const cost = term.length + 4; // "-e " + term + separating space
    if (current.length > 0 && currentChars + cost > GIT_GREP_CHUNK_CHAR_BUDGET) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(term);
    currentChars += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Parse one `git grep -n` output line (`path:line:text`) with boundary
 * scanning instead of a regex — the path itself may legitimately contain
 * arbitrary characters, so splitting on the first two colons is the only
 * safe deterministic parse.
 * @param {string} line
 * @returns {{ path: string, line: number, text: string }|null}
 */
function parseGrepLine(line) {
  const firstColon = line.indexOf(':');
  if (firstColon === -1) return null;
  const rest = line.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) return null;
  const lineNo = Number(rest.slice(0, secondColon));
  if (!Number.isFinite(lineNo)) return null;
  return { path: line.slice(0, firstColon), line: lineNo, text: rest.slice(secondColon + 1) };
}

/**
 * True when `repoRoot` is inside a usable git worktree with a working `git`
 * binary. A single cheap probe decides the git-vs-fallback branch for the
 * whole strategy, rather than per-chunk guessing.
 * @param {string} repoRoot
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function gitIsUsable(repoRoot, signal) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoRoot,
      signal,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Run `git grep -nI --max-count=<N> -e t1 -e t2 …` for one chunk of terms.
 * Exit code 1 ("no matches") is a normal empty result, not a failure.
 * @param {string} repoRoot
 * @param {string[]} terms
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}  raw stdout (empty string on no-match)
 */
async function runGitGrepChunk(repoRoot, terms, signal) {
  const args = ['grep', '-nI', `--max-count=${MAX_COUNT_PER_TERM}`];
  for (const term of terms) args.push('-e', term);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (/** @type {any} */ err) {
    if (err && err.code === 1 && typeof err.stdout === 'string') return err.stdout;
    return '';
  }
}

/**
 * Pure-Node line scan fallback used when git is unavailable: streams every
 * walked file (skipping binaries and files over 1 MiB) and matches terms
 * case-insensitively.
 * @param {string} repoRoot
 * @param {string[]} terms
 * @param {AbortSignal} [signal]
 * @returns {Promise<RawCandidate[]>}
 */
async function scanByContentFallback(repoRoot, terms, signal) {
  const files = await walkRepoFiles(repoRoot, { signal });
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t !== '');
  /** @type {Map<string, RawCandidate>} */
  const byPath = new Map();

  for (const abs of files) {
    if (signal?.aborted) break;
    let stat;
    try {
      stat = await statPath(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_TEXT_SCAN_BYTES) continue;

    let text;
    try {
      text = await readTextFile(abs);
    } catch {
      continue;
    }
    if (looksBinary(text.slice(0, 512))) continue;

    const rel = normalizeCandidatePath(repoRoot, abs);
    if (rel === null) continue;

    const lines = text.split('\n');
    let hits = 0;
    let firstMatch = '';
    for (const line of lines) {
      const lower = line.toLowerCase();
      for (const term of lowerTerms) {
        if (lower.includes(term)) {
          hits++;
          if (firstMatch === '') firstMatch = line.trim().slice(0, 120);
          break;
        }
      }
      if (hits >= MAX_COUNT_PER_TERM) break;
    }
    if (hits > 0) byPath.set(rel, { path: rel, hits, why: `content match: ${firstMatch}` });
  }
  return [...byPath.values()];
}

/**
 * git-grep-backed content search across `seedTerms`, falling back to a pure
 * Node scan when `repoRoot` is not a usable git worktree.
 * @param {string} repoRoot
 * @param {string[]} seedTerms
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<RawCandidate[]>}
 */
export async function scanByContent(repoRoot, seedTerms, opts = {}) {
  const terms = seedTerms.filter((t) => typeof t === 'string' && t.trim() !== '');
  if (terms.length === 0) return [];

  const useGit = await gitIsUsable(repoRoot, opts.signal);
  if (!useGit) {
    return scanByContentFallback(repoRoot, terms, opts.signal);
  }

  const chunks = chunkTerms(terms);
  const concurrency = Math.min(4, availableParallelism());
  const stdouts = await mapWithConcurrencyLimit(chunks, concurrency, (chunk) =>
    runGitGrepChunk(repoRoot, chunk, opts.signal)
  );

  /** @type {Map<string, RawCandidate>} */
  const byPath = new Map();
  for (const stdout of stdouts) {
    if (stdout === '') continue;
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue;
      const parsed = parseGrepLine(line);
      if (parsed === null) continue;
      const rel = normalizeCandidatePath(repoRoot, parsed.path);
      if (rel === null) continue;
      const existing = byPath.get(rel);
      if (existing) {
        existing.hits++;
      } else {
        byPath.set(rel, { path: rel, hits: 1, why: `git grep: ${parsed.text.trim().slice(0, 120)}` });
      }
    }
  }
  return [...byPath.values()];
}

/**
 * @param {{ repoRoot: string, seedTerms: string[] }} opts
 * @param {Map<string, RawCandidate[]>} store
 * @returns {FanoutWorker}
 */
function buildByContentWorker({ repoRoot, seedTerms }, store) {
  const workerId = 'scan-by-content';
  return async (signal) => {
    const candidates = await scanByContent(repoRoot, seedTerms, { signal });
    store.set(workerId, candidates);
    return finishWorker(workerId, candidates, 'Merge with the other strategies via mergeCandidates.');
  };
}

// ---------------------------------------------------------------------------
// Strategy 3 — by-imports (depth-1 ESM import graph neighbors)
// ---------------------------------------------------------------------------

/** Matches `from '<specifier>'` in both `import … from '…'` and `export … from '…'`. */
const IMPORT_FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
/** Matches dynamic `import('<specifier>')`. */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Extract every import/export specifier string from `text` (best-effort
 * regex adequate for candidate generation — not a real parser).
 * @param {string} text
 * @returns {string[]}
 */
function extractSpecifiers(text) {
  /** @type {string[]} */
  const specs = [];
  for (const m of text.matchAll(IMPORT_FROM_RE)) specs.push(m[1]);
  for (const m of text.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
  return specs;
}

/**
 * Resolve a relative import specifier against the file that imports it,
 * trying the repo's known extensions and directory-index files. Returns
 * `null` when nothing on disk matches (never hallucinate a candidate).
 * @param {string} fromFileAbs
 * @param {string} specifier
 * @returns {Promise<string|null>}
 */
async function resolveRelativeSpecifier(fromFileAbs, specifier) {
  if (!(specifier.startsWith('./') || specifier.startsWith('../'))) return null;
  const base = resolve(dirname(fromFileAbs), specifier);

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    try {
      const stat = await statPath(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try next
    }
  }
  for (const indexName of INDEX_CANDIDATES) {
    const candidate = resolve(base, indexName);
    try {
      const stat = await statPath(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * @param {string} relPath  repo-relative POSIX path
 * @returns {string} basename without its final extension
 */
function baseNameNoExt(relPath) {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Depth-1 import-graph neighbors of `seedFiles` (explicit, or derived from a
 * quick by-name pass when none were given): forward edges (files the seed
 * imports) plus reverse edges (files that import the seed, found by a
 * bounded basename search).
 * @param {string} repoRoot
 * @param {string[]} seedTerms
 * @param {string[]} seedFiles
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<RawCandidate[]>}
 */
export async function scanByImports(repoRoot, seedTerms, seedFiles, opts = {}) {
  const seeds =
    seedFiles.length > 0
      ? seedFiles
      : (await scanByName(repoRoot, seedTerms, { signal: opts.signal, limit: 5 })).map((c) => c.path);

  if (seeds.length === 0) return [];

  /** @type {Map<string, RawCandidate>} */
  const byPath = new Map();

  // Forward edges: parse each seed file's own imports.
  for (const seedRel of seeds) {
    if (opts.signal?.aborted) break;
    const seedAbs = resolve(repoRoot, seedRel);
    let text;
    try {
      text = await readTextFile(seedAbs);
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(text)) {
      const resolved = await resolveRelativeSpecifier(seedAbs, specifier);
      if (resolved === null) continue;
      const rel = normalizeCandidatePath(repoRoot, resolved);
      if (rel === null || rel === seedRel) continue;
      const existing = byPath.get(rel);
      if (existing) {
        existing.hits++;
      } else {
        byPath.set(rel, { path: rel, hits: 1, why: `imported by ${seedRel}` });
      }
    }
  }

  // Reverse edges: which files (bounded walk) import one of the seeds, by
  // basename — cheap, heuristic, depth-1 only.
  const seedBases = new Set(seeds.map((s) => baseNameNoExt(s)));
  const files = await walkRepoFiles(repoRoot, { signal: opts.signal });
  for (const abs of files) {
    if (opts.signal?.aborted) break;
    if (!SOURCE_EXTENSIONS.some((ext) => abs.endsWith(ext))) continue;
    const rel = normalizeCandidatePath(repoRoot, abs);
    if (rel === null || seeds.includes(rel)) continue;

    let text;
    try {
      text = await readTextFile(abs);
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(text)) {
      const specBase = baseNameNoExt(specifier.split('/').pop() ?? specifier);
      if (seedBases.has(specBase)) {
        const existing = byPath.get(rel);
        if (existing) {
          existing.hits++;
        } else {
          byPath.set(rel, { path: rel, hits: 1, why: `imports a seed file (${specBase})` });
        }
        break;
      }
    }
  }

  return [...byPath.values()];
}

/**
 * @param {{ repoRoot: string, seedTerms: string[], seedFiles: string[] }} opts
 * @param {Map<string, RawCandidate[]>} store
 * @returns {FanoutWorker}
 */
function buildByImportsWorker({ repoRoot, seedTerms, seedFiles }, store) {
  const workerId = 'scan-by-imports';
  return async (signal) => {
    const candidates = await scanByImports(repoRoot, seedTerms, seedFiles, { signal });
    store.set(workerId, candidates);
    return finishWorker(workerId, candidates, 'Merge with the other strategies via mergeCandidates.');
  };
}

// ---------------------------------------------------------------------------
// Strategy 4 — by-test-mirror
// ---------------------------------------------------------------------------

/**
 * Apply the repo's `test/` mirror convention bidirectionally:
 * `lib/x/y.mjs` ↔ `test/lib/x/y.test.mjs`.
 * @param {string} relPath  repo-relative POSIX path
 * @returns {string|null}  the mirrored repo-relative path, or null if the rule does not apply
 */
export function mirrorPath(relPath) {
  const TEST_INFIX = '.test.';
  if (relPath.startsWith('test/')) {
    const withoutPrefix = relPath.slice('test/'.length);
    const dot = withoutPrefix.lastIndexOf(TEST_INFIX);
    if (dot === -1) return null;
    return withoutPrefix.slice(0, dot) + '.' + withoutPrefix.slice(dot + TEST_INFIX.length);
  }
  const dot = relPath.lastIndexOf('.');
  if (dot <= 0) return null;
  return `test/${relPath.slice(0, dot)}.test${relPath.slice(dot)}`;
}

/**
 * For each seed file (explicit, or a quick by-name derivation), compute its
 * `test/` mirror and keep it only when it exists on disk.
 * @param {string} repoRoot
 * @param {string[]} seedTerms
 * @param {string[]} seedFiles
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<RawCandidate[]>}
 */
export async function scanByTestMirror(repoRoot, seedTerms, seedFiles, opts = {}) {
  const seeds =
    seedFiles.length > 0
      ? seedFiles
      : (await scanByName(repoRoot, seedTerms, { signal: opts.signal, limit: 5 })).map((c) => c.path);

  /** @type {RawCandidate[]} */
  const candidates = [];
  for (const seedRel of seeds) {
    if (opts.signal?.aborted) break;
    const mirrored = mirrorPath(seedRel);
    if (mirrored === null) continue;
    try {
      const stat = await statPath(resolve(repoRoot, mirrored));
      if (stat.isFile()) {
        candidates.push({ path: mirrored, hits: 1, why: `test mirror of ${seedRel}` });
      }
    } catch {
      // mirror does not exist — not a candidate
    }
  }
  return candidates;
}

/**
 * @param {{ repoRoot: string, seedTerms: string[], seedFiles: string[] }} opts
 * @param {Map<string, RawCandidate[]>} store
 * @returns {FanoutWorker}
 */
function buildByTestMirrorWorker({ repoRoot, seedTerms, seedFiles }, store) {
  const workerId = 'scan-by-test-mirror';
  return async (signal) => {
    const candidates = await scanByTestMirror(repoRoot, seedTerms, seedFiles, { signal });
    store.set(workerId, candidates);
    return finishWorker(workerId, candidates, 'Merge with the other strategies via mergeCandidates.');
  };
}

// ---------------------------------------------------------------------------
// Shared WorkerReturn assembly
// ---------------------------------------------------------------------------

/**
 * Build the compliant `WorkerReturn` a strategy hands back to `fanout()`.
 * The candidate array itself never appears here (TCM-10) — only a digest.
 * @param {string} workerId
 * @param {RawCandidate[]} candidates
 * @param {string} nextStep
 * @returns {WorkerReturn}
 */
function finishWorker(workerId, candidates, nextStep) {
  // Tie-break by path: filesystem traversal order (the fallback strategies'
  // insertion order) is not guaranteed stable across OSes, so without this
  // the reported `top:` candidate could vary run-to-run on a hits tie.
  const sorted = [...candidates].sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  const top = sorted[0];
  const finding =
    top === undefined
      ? '0 candidates found.'
      : `${candidates.length} candidate(s); top: ${top.path} (${top.hits} hit${top.hits === 1 ? '' : 's'})`;

  return new WorkerReturnBuilder(workerId)
    .setFinding(finding.slice(0, 500))
    .setSourcePointer({
      kind: 'file',
      path: top === undefined ? '.' : top.path,
      lineRange: null,
      reason: top === undefined ? 'no candidates matched' : top.why.slice(0, 200),
      confidence: top === undefined ? 0.1 : Math.min(0.5 + top.hits / 20, 1),
      freshness: new Date().toISOString(),
    })
    .setConfidence(candidates.length > 0 ? 0.8 : 0.2)
    .setArtifactWritten(null)
    .setNextStep(nextStep.slice(0, 200))
    .setTokenNotes(TOKEN_NOTES)
    .setDebugMode(false)
    .build();
}

// ---------------------------------------------------------------------------
// Public: buildScanWorkers, mergeCandidates, runDiscoveryScan
// ---------------------------------------------------------------------------

/**
 * Build the four independent strategy workers plus the side-channel store
 * their candidates land in. Callers pass `workers` straight to `fanout()`.
 * @param {{ repoRoot: string, seedTerms: string[], seedFiles?: string[] }} opts
 * @returns {{ workers: FanoutWorker[], store: Map<string, RawCandidate[]> }}
 */
export function buildScanWorkers(opts) {
  const repoRoot = resolve(opts.repoRoot);
  const seedTerms = opts.seedTerms;
  const seedFiles = opts.seedFiles ?? [];

  /** @type {Map<string, RawCandidate[]>} */
  const store = new Map();
  const workers = [
    buildByNameWorker({ repoRoot, seedTerms }, store),
    buildByContentWorker({ repoRoot, seedTerms }, store),
    buildByImportsWorker({ repoRoot, seedTerms, seedFiles }, store),
    buildByTestMirrorWorker({ repoRoot, seedTerms, seedFiles }, store),
  ];
  return { workers, store };
}

/**
 * Merge per-strategy candidate lists into one ranked, capped list.
 *
 * Scoring (documented heuristic, deterministic, no ML/embeddings):
 * `score = strategies.length * 10 + min(hits, 20) + (seedProximity ? 5 : 0)`,
 * where `seedProximity` is true when the candidate shares a directory with
 * any of `opts.seedFiles`. Ties break on path ascending (stable, reviewable
 * output). Paths that resolve outside `opts.repoRoot` are dropped
 * (fail-closed) before scoring.
 * @param {Array<{ strategy: string, candidates: RawCandidate[] }>} perStrategyCandidates
 * @param {{ maxSources: number, repoRoot: string, seedFiles?: string[] }} opts
 * @returns {{ candidates: MergedCandidate[], dropped: number }}
 */
export function mergeCandidates(perStrategyCandidates, opts) {
  const { maxSources, repoRoot, seedFiles = [] } = opts;

  const seedDirs = new Set(
    seedFiles
      .map((f) => normalizeCandidatePath(repoRoot, f))
      .filter((/** @type {string|null} */ f) => f !== null)
      .map((/** @type {string} */ f) => f.split('/').slice(0, -1).join('/'))
  );

  /** @type {Map<string, { path: string, strategies: Set<string>, hits: number, why: string }>} */
  const byPath = new Map();
  let traversalDropped = 0;

  for (const { strategy, candidates } of perStrategyCandidates) {
    for (const raw of candidates) {
      const norm = normalizeCandidatePath(repoRoot, raw.path);
      if (norm === null) {
        traversalDropped++; // escapes repoRoot — dropped, fail-closed, but never silent
        continue;
      }

      let entry = byPath.get(norm);
      if (!entry) {
        // eslint-disable-next-line secure-coding/no-unlimited-resource-allocation -- one Set per unique candidate path; bounded by MAX_WALK_FILES (20k) per strategy, not user-controlled input.
        entry = { path: norm, strategies: new Set(), hits: 0, why: raw.why };
        byPath.set(norm, entry);
      }
      entry.strategies.add(strategy);
      entry.hits += raw.hits;
    }
  }

  /** @type {MergedCandidate[]} */
  const scored = [...byPath.values()].map((entry) => {
    const dir = entry.path.split('/').slice(0, -1).join('/');
    const proximityBonus = seedDirs.has(dir) ? 5 : 0;
    const score = entry.strategies.size * 10 + Math.min(entry.hits, 20) + proximityBonus;
    return {
      path: entry.path,
      score,
      strategies: [...entry.strategies].sort(),
      hits: entry.hits,
      why: entry.why,
    };
  });

  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const capDropped = Math.max(0, scored.length - maxSources);
  const candidates = scored.slice(0, Math.max(0, maxSources));
  return { candidates, dropped: capDropped + traversalDropped };
}

/**
 * Resolve the default `maxSources` cap for a budget class. Values must track
 * `lib/context/output-contract.mjs`'s `classifyBudget` (tiny=3, standard=10,
 * large=999 — unbounded, ContextReducer required upstream).
 * @param {BudgetClass} budgetClass
 * @returns {number}
 */
export function resolveMaxSources(budgetClass) {
  return MAX_SOURCES_BY_BUDGET.get(budgetClass) ?? /** @type {number} */ (MAX_SOURCES_BY_BUDGET.get('standard'));
}

/**
 * Run the full Phase-1 discovery scan: dispatch the four strategies via
 * `fanout()`, then merge their side-channel candidates into one ranked,
 * capped list. Never throws for operational failures — timeouts and
 * contract violations become `violations` entries and (when severe enough)
 * `insufficient: true`; only programmer errors (missing repoRoot/seedTerms)
 * throw.
 * @param {{
 *   repoRoot: string,
 *   seedTerms: string[],
 *   seedFiles?: string[],
 *   budgetClass?: BudgetClass,
 *   maxSources?: number,
 *   timeoutMs?: number,
 *   minSuccessRate?: number,
 *   telemetryPath?: string,
 * }} opts
 * @returns {Promise<{
 *   candidates: MergedCandidate[],
 *   dropped: number,
 *   insufficient: boolean,
 *   violations: string[],
 *   telemetry: import('../types.mjs').WorkerTelemetry[],
 * }>}
 */
export async function runDiscoveryScan(opts) {
  if (typeof opts.repoRoot !== 'string' || opts.repoRoot.trim() === '') {
    throw new Error('runDiscoveryScan: repoRoot is required');
  }
  if (!Array.isArray(opts.seedTerms) || opts.seedTerms.length === 0) {
    throw new Error('runDiscoveryScan: seedTerms must be a non-empty array');
  }
  if (opts.maxSources !== undefined && (!Number.isInteger(opts.maxSources) || opts.maxSources < 0)) {
    throw new Error('runDiscoveryScan: maxSources must be a non-negative integer');
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new Error('runDiscoveryScan: timeoutMs must be a positive number');
  }

  const repoRoot = resolve(opts.repoRoot);
  const seedFiles = opts.seedFiles ?? [];
  const budgetClass = opts.budgetClass ?? 'standard';
  const maxSources = opts.maxSources ?? resolveMaxSources(budgetClass);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const minSuccessRate = opts.minSuccessRate ?? 0.5;

  const { workers, store } = buildScanWorkers({ repoRoot, seedTerms: opts.seedTerms, seedFiles });

  const fanoutResult = await fanout(workers, {
    budgetClass,
    timeoutMs,
    minSuccessRate,
    ...(opts.telemetryPath !== undefined ? { telemetryPath: opts.telemetryPath } : {}),
  });

  const perStrategyCandidates = fanoutResult.results.map((r) => ({
    strategy: r.workerId,
    candidates: store.get(r.workerId) ?? [],
  }));

  const { candidates, dropped } = mergeCandidates(perStrategyCandidates, { maxSources, repoRoot, seedFiles });

  return {
    candidates,
    dropped,
    insufficient: fanoutResult.insufficient,
    violations: fanoutResult.violations,
    telemetry: fanoutResult.telemetry,
  };
}
