// @ts-check
// DN-4: infer draft business domains from repo structure. The adoption
// barrier for the DN-1 domains config is the blank page — and a wrong map is
// worse than none, because downstream injection (DN-3) and re-rank (DN-5)
// trust it. So inference is deterministic (same tree ⇒ same draft), produces
// DRAFT artifacts only, and nothing here touches real config: the
// generate → review → apply flow (scripts/generate-domain-map.mjs,
// scripts/apply-domain-map.mjs) keeps the human gate between proposal and
// devmate.config.json, mirroring lib/init/infer-personas.mjs and the
// spec-writer draft→confirm pattern.
//
// Pure and I/O-free: works on the walker's file list, never reads files —
// so workspace packages are detected via nested package manifests in the
// list (the pure equivalent of reading workspaces globs), and cross-import
// analysis (relatedDomains) is left as a TODO for the human in the stub.

/** @typedef {import('../types.mjs').DomainConfig} DomainConfig */

/** Minimum file count for a src subdirectory to become a domain. */
// TODO: calibrate — provisional placeholder (first real consumer-repo runs)
export const MIN_FILES_PER_DOMAIN = 5;

/** Maximum inferred domains; beyond this the largest are kept and the rest reported. */
// TODO: calibrate — provisional placeholder (first real consumer-repo runs)
export const MAX_INFERRED_DOMAINS = 12;

/** Most-frequent basename tokens kept as keywords per domain. */
// TODO: calibrate — provisional placeholder
const MAX_KEYWORDS_PER_DOMAIN = 8;

/** Entry-point file paths listed per domain (draft hint, not a contract). */
const MAX_ENTRY_POINTS = 3;

/** Inferred per-domain test paths listed in the stub. */
const MAX_STUB_TEST_PATHS = 5;

/** Basename tokens too generic to be domain vocabulary. */
const GENERIC_TOKENS = new Set([
  'index', 'main', 'app', 'src', 'lib', 'test', 'tests', 'spec', 'specs',
  'util', 'utils', 'helper', 'helpers', 'types', 'type', 'config', 'configs',
  'common', 'shared', 'core', 'internal', 'mod', 'module', 'package',
  'readme', 'license', 'tsconfig',
]);

/** @param {string} p @returns {string} */
function toSlash(p) {
  return p.split('\\').join('/');
}

/**
 * Kebab-case a directory/package name into a domain id.
 * @param {string} name
 * @returns {string}
 */
function toDomainId(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Identifier-style tokens of a name: split on separators and camelCase,
 * lowercase, drop short/generic/numeric tokens.
 * @param {string} name
 * @returns {string[]}
 */
function tokensOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC_TOKENS.has(t));
}

/**
 * Basename with only the (last) extension removed — "foo.bar.test.ts" keeps
 * "foo.bar.test" so meaningful middle tokens survive keyword inference
 * (generic suffix tokens like test/spec are filtered downstream).
 * @param {string} relPath
 * @returns {string}
 */
function basenameNoExt(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * One inferred domain candidate before ranking/formatting.
 * @typedef {Object} DomainCandidate
 * @property {string} id     Kebab-case domain id.
 * @property {string} dir    Repo-relative slash directory owning the domain.
 * @property {string[]} files  Repo-relative files under `dir`.
 * @property {'package'|'src-dir'|'candidates'} source
 */

/**
 * Most frequent identifier-style basename tokens across a domain's files.
 * Deterministic: count desc, then alphabetical. Each token counts once per
 * file (indexOf dedupe — no per-file Set allocation inside the loop).
 * @param {string[]} files
 * @param {string[]} exclude  Tokens already present (dir-name tokens).
 * @returns {string[]}
 */
function frequentBasenameTokens(files, exclude) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  // "words" naming (not "tokens"): the no-insecure-comparison lint treats
  // comparisons on token-named identifiers as secret comparison.
  for (const f of files) {
    const words = tokensOf(basenameNoExt(f));
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (words.indexOf(w) !== i) continue; // dedupe within this file
      if (exclude.includes(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/**
 * Build the DRAFT stub context file for one domain (the DN-4 template).
 * @param {DomainConfig} domain
 * @param {string[]} testPaths
 * @returns {string}
 */
function buildStub(domain, testPaths) {
  const entryLines =
    (domain.entryPoints ?? []).length > 0
      ? /** @type {string[]} */ (domain.entryPoints).map((p) => `- ${p} — TODO: what it appears to do`)
      : ['- TODO for the human'];
  const testLines = testPaths.length > 0 ? testPaths.map((p) => `- ${p}`) : ['- TODO for the human'];
  const relatedLines =
    (domain.relatedDomains ?? []).length > 0
      ? /** @type {string[]} */ (domain.relatedDomains).map((d) => `- ${d}`)
      : ['- TODO for the human (cross-directory imports are not inferred)'];
  return [
    `# ${domain.domain} — domain context (DRAFT — edit before applying)`,
    '',
    '## Key entry files',
    ...entryLines,
    '',
    '## Invariants (what NOT to touch)',
    '- TODO for the human',
    '',
    '## Tests to run for this domain',
    ...testLines,
    '',
    '## Cross-domain contracts',
    ...relatedLines,
    '',
  ].join('\n');
}

/**
 * Infer draft business domains from repo structure. Deterministic for a given input.
 * Heuristics, in priority order:
 *  1. workspace packages — detected from top-most nested package manifests in the
 *     file list (the pure, file-list-only equivalent of reading package.json
 *     workspaces / pnpm-workspace globs) → one domain per package
 *  2. top-level src subdirectories with >= MIN_FILES_PER_DOMAIN files → one domain per dir
 *  3. FO-3 candidates artifact (when provided): co-occurring directory clusters reinforce/merge domains
 * Keywords: tokenized dir/package names + most frequent identifier-style tokens in basenames.
 *
 * @param {Object} input
 * @param {string} input.repoRoot
 * @param {string[]} input.fileList  Repo-relative paths (walker output, pre-filtered).
 * @param {object|null} input.candidatesArtifact  Parsed discovery-candidates.json or null.
 * @returns {{ domains: import('../types.mjs').DomainConfig[], stubs: Record<string, string>, droppedDomains: string[] }}
 */
export function inferDomains(input) {
  const fileList = [...new Set((input.fileList ?? []).map(toSlash))].sort();

  /** @type {Map<string, DomainCandidate>} */
  const byDir = new Map();

  /** @param {string} dir @param {'package'|'src-dir'|'candidates'} source */
  const addCandidate = (dir, source) => {
    if (byDir.has(dir)) return;
    const prefix = `${dir}/`;
    const files = fileList.filter((f) => f.startsWith(prefix));
    const segments = dir.split('/');
    const id = toDomainId(segments[segments.length - 1]);
    if (id === '') return;
    byDir.set(dir, { id, dir, files, source });
  };

  // Heuristic 1 — workspace packages: any nested package manifest marks its
  // directory as a package (pure detection over the file list; standard
  // packages/<name>/package.json monorepo layout).
  const packageDirs = fileList
    .filter((f) => f.endsWith('/package.json'))
    .map((f) => f.slice(0, -'/package.json'.length))
    .filter((dir) => dir !== '');
  // Keep only top-most package dirs (a package nested under another is not a
  // workspace member of this repo's map).
  for (const dir of packageDirs) {
    const nested = packageDirs.some((other) => other !== dir && dir.startsWith(`${other}/`));
    if (!nested) addCandidate(dir, 'package');
  }

  // Heuristic 2 — top-level src subdirectories with enough files.
  /** @type {Map<string, number>} */
  const srcSubCounts = new Map();
  for (const f of fileList) {
    const m = /^src\/([^/]+)\//.exec(f);
    if (m) srcSubCounts.set(`src/${m[1]}`, (srcSubCounts.get(`src/${m[1]}`) ?? 0) + 1);
  }
  for (const [dir, count] of [...srcSubCounts.entries()].sort()) {
    if (count >= MIN_FILES_PER_DOMAIN) addCandidate(dir, 'src-dir');
  }

  // Heuristic 3 — FO-3 candidates artifact (null-tolerant, first-class null
  // branch): co-occurring candidate directories not already covered become
  // domains when the cluster is large enough; clusters inside an existing
  // domain simply reinforce it (its files are already counted).
  const artifact = /** @type {{ candidates?: Array<{ path?: unknown }> } | null} */ (
    input.candidatesArtifact ?? null
  );
  if (artifact !== null && Array.isArray(artifact.candidates)) {
    /** @type {Map<string, number>} */
    const clusterCounts = new Map();
    for (const c of artifact.candidates) {
      if (typeof c?.path !== 'string') continue;
      const rel = toSlash(c.path);
      const covered = [...byDir.keys()].some((dir) => rel.startsWith(`${dir}/`));
      if (covered) continue;
      const segments = rel.split('/');
      if (segments.length < 2) continue;
      const dir = segments.length >= 3 ? segments.slice(0, 2).join('/') : segments[0];
      clusterCounts.set(dir, (clusterCounts.get(dir) ?? 0) + 1);
    }
    for (const [dir, count] of [...clusterCounts.entries()].sort()) {
      if (count >= MIN_FILES_PER_DOMAIN) addCandidate(dir, 'candidates');
    }
  }

  // Rank by file count (desc, ties alphabetical by dir) and cap.
  const ranked = [...byDir.values()].sort(
    (a, b) => b.files.length - a.files.length || a.dir.localeCompare(b.dir),
  );
  const kept = ranked.slice(0, MAX_INFERRED_DOMAINS);
  const droppedDomains = ranked.slice(MAX_INFERRED_DOMAINS).map((c) => c.id);

  /** @type {DomainConfig[]} */
  const domains = [];
  /** @type {Array<[string, string]>} */
  const stubEntries = [];
  /** @type {Set<string>} */
  const seenIds = new Set();

  for (const cand of kept) {
    if (seenIds.has(cand.id)) continue; // same leaf name twice — first (largest) wins
    seenIds.add(cand.id);

    const dirTokens = tokensOf(cand.dir.split('/').pop() ?? cand.dir);
    const keywords = [
      ...dirTokens,
      ...frequentBasenameTokens(cand.files, dirTokens),
    ].slice(0, MAX_KEYWORDS_PER_DOMAIN);

    const entryPoints = cand.files
      .filter((f) => /(^|\/)index\.[a-z]+$/.test(f))
      .slice(0, MAX_ENTRY_POINTS);

    /** @type {DomainConfig} */
    const domain = {
      domain: cand.id,
      keywords,
      globs: [`${cand.dir}/**`],
      contextFile: `.devmate/contexts/${cand.id}.md`,
      relatedDomains: [],
      ...(entryPoints.length > 0 ? { entryPoints } : {}),
    };
    domains.push(domain);

    const idToken = cand.id.split('-')[0];
    const testPaths = fileList
      .filter(
        (f) =>
          (f.startsWith(`${cand.dir}/`) && /\.(test|spec)\./.test(f)) ||
          (f.startsWith('test/') && f.includes(idToken)),
      )
      .slice(0, MAX_STUB_TEST_PATHS);
    stubEntries.push([cand.id, buildStub(domain, testPaths)]);
  }

  return { domains, stubs: Object.fromEntries(stubEntries), droppedDomains };
}
