// @ts-check
// Deterministic floor for verification hydration: read (never execute) the
// repo's real verification evidence — package.json scripts, Makefile targets,
// language-marker conventions, and CI `run:` steps — and emit grounded
// candidates. Every candidate cites a real `source`, so the downstream LLM
// enrichment stage selects and labels evidence rather than inventing commands.
//
// Pure w.r.t. the tree: same files ⇒ same candidates (deterministic sort, no
// clock, no rng). Bounded: reads only well-known marker files and the
// .github/workflows directory — never walks the whole tree.
import { join } from 'node:path';
import { listDir, pathExists, readTextFile } from '../fs-safe.mjs';
import { parseJsonSafe } from '../json-io.mjs';

/** @typedef {import('../types.mjs').VerificationCandidate} VerificationCandidate */

/** Max CI `run:` steps harvested, to stay bounded on large workflows. */
const MAX_CI_CANDIDATES = 20;

/**
 * Classify a script name / command into a best-effort verification category.
 * Matching is on a flattened token string so 'test:unit', 'typeCheck', and
 * 'type-check' all resolve. Returns 'unknown' when nothing matches — the infer
 * step keeps unknowns out of the promoted floor.
 * @param {string} text  Script name and/or command.
 * @returns {string}
 */
export function classifyCommand(text) {
  const t = text.toLowerCase();
  // Order matters: more specific test flavors before the generic unit-test.
  if (/\b(e2e|playwright|cypress|webdriver)\b/.test(t) || t.includes('test:e2e')) return 'e2e';
  if (t.includes('integration') || t.includes('test:int')) return 'integration';
  if (/\b(typecheck|tsc|mypy)\b/.test(t) || t.includes('type-check') || t.includes('type:check')) return 'type-check';
  if (/\b(lint|eslint|ruff|clippy|vet|flake8|pylint)\b/.test(t)) return 'lint';
  if (/\b(format|prettier|fmt|gofmt|black)\b/.test(t)) return 'format';
  if (/\b(audit)\b/.test(t)) return 'audit';
  if (/\b(contract|pact)\b/.test(t)) return 'contract';
  if (/\b(verify|validate)\b/.test(t) || t === 'check' || t.includes(' check')) return 'verify';
  if (/\b(test|spec|jest|vitest|pytest|mocha)\b/.test(t)) return 'unit-test';
  if (/\b(build|compile|bundle|tsup|rollup|webpack)\b/.test(t)) return 'build';
  return 'unknown';
}

/**
 * Scan the repo for grounded verification-command candidates.
 * @param {string} repoRoot  Absolute path to the repo root.
 * @returns {Promise<VerificationCandidate[]>}  Deterministically sorted.
 */
export async function scanVerificationSignals(repoRoot) {
  /** @type {VerificationCandidate[]} */
  const candidates = [];

  await collectPackageScripts(repoRoot, candidates);
  await collectMakefileTargets(repoRoot, candidates);
  collectLanguageMarkers(repoRoot, candidates);
  await collectCiRunSteps(repoRoot, candidates);

  return sortCandidates(candidates);
}

/**
 * package.json `scripts` — the highest-signal source. `test` runs as `npm test`;
 * every other script as `npm run <name>`.
 * @param {string} repoRoot
 * @param {VerificationCandidate[]} out
 * @returns {Promise<void>}
 */
async function collectPackageScripts(repoRoot, out) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!pathExists(pkgPath)) return;
  let parsed;
  try {
    parsed = parseJsonSafe(await readTextFile(pkgPath));
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const scripts = /** @type {Record<string, unknown>} */ (parsed)['scripts'];
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return;

  const entries = Object.entries(/** @type {Record<string, unknown>} */ (scripts)).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const [name, body] of entries) {
    if (typeof body !== 'string' || body.trim() === '') continue;
    const command = name === 'test' ? 'npm test' : `npm run ${name}`;
    const category = classifyCommand(`${name} ${body}`);
    out.push({
      command,
      category,
      source: `package.json#scripts.${name}`,
      confidence: name === 'test' ? 0.95 : 0.85,
    });
  }
}

/**
 * Makefile phony/real targets, as `make <target>`.
 * @param {string} repoRoot
 * @param {VerificationCandidate[]} out
 * @returns {Promise<void>}
 */
async function collectMakefileTargets(repoRoot, out) {
  const mkPath = join(repoRoot, 'Makefile');
  if (!pathExists(mkPath)) return;
  let text;
  try {
    text = await readTextFile(mkPath);
  } catch {
    return;
  }
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-zA-Z][\w.-]*)\s*:(?!=)/.exec(line);
    if (!match) continue;
    const target = match[1];
    if (target.startsWith('.') || seen.has(target)) continue;
    seen.add(target);
    out.push({
      command: `make ${target}`,
      category: classifyCommand(target),
      source: `Makefile#${target}`,
      confidence: 0.6,
    });
  }
}

/**
 * Language-marker conventions — canonical commands keyed on a marker file's
 * presence (no file parsing, so no toml/yaml dependency).
 * @param {string} repoRoot
 * @param {VerificationCandidate[]} out
 * @returns {void}
 */
function collectLanguageMarkers(repoRoot, out) {
  const has = (/** @type {string} */ rel) => pathExists(join(repoRoot, rel));
  const add = (/** @type {string} */ command, /** @type {string} */ category, /** @type {string} */ source) => {
    out.push({ command, category, source, confidence: 0.75 });
  };

  const pyMarker = ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg'].find(has);
  if (pyMarker) add('pytest', 'unit-test', pyMarker);
  if (has('mypy.ini')) add('python -m mypy .', 'type-check', 'mypy.ini');

  if (has('Cargo.toml')) {
    add('cargo test', 'unit-test', 'Cargo.toml');
    add('cargo clippy', 'lint', 'Cargo.toml');
    add('cargo build', 'build', 'Cargo.toml');
  }
  if (has('go.mod')) {
    add('go test ./...', 'unit-test', 'go.mod');
    add('go vet ./...', 'lint', 'go.mod');
    add('go build ./...', 'build', 'go.mod');
  }
  if (has('pom.xml')) {
    add('mvn test', 'unit-test', 'pom.xml');
    add('mvn -q -DskipTests compile', 'type-check', 'pom.xml');
  }
  const gradle = ['build.gradle', 'build.gradle.kts'].find(has);
  if (gradle) {
    add('gradle test', 'unit-test', gradle);
    add('gradle build', 'build', gradle);
  }
}

/**
 * CI `run:` steps — grounded but noisy, so lowest confidence. Only inline
 * single-line `run:` forms are harvested (block scalars are skipped). Bounded.
 * @param {string} repoRoot
 * @param {VerificationCandidate[]} out
 * @returns {Promise<void>}
 */
async function collectCiRunSteps(repoRoot, out) {
  const dir = join(repoRoot, '.github', 'workflows');
  if (!pathExists(dir)) return;
  /** @type {string[]} */
  let files;
  try {
    files = (await listDir(dir)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  } catch {
    return;
  }
  let harvested = 0;
  for (const file of files) {
    if (harvested >= MAX_CI_CANDIDATES) break;
    let text;
    try {
      text = await readTextFile(join(dir, file));
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (harvested >= MAX_CI_CANDIDATES) break;
      const command = ciRunCommand(line);
      if (command === null) continue;
      out.push({
        command,
        category: classifyCommand(command),
        source: `.github/workflows/${file}#run`,
        confidence: 0.4,
      });
      harvested += 1;
    }
  }
}

/**
 * Extract an inline CI `run:` command from a workflow line, or null. String
 * parsing (no regex) — the `- ` list-item prefix and block-scalar markers are
 * handled explicitly; block scalars (`run: |`) are skipped.
 * @param {string} line
 * @returns {string|null}
 */
function ciRunCommand(line) {
  let s = line.trim();
  if (s.startsWith('- ')) s = s.slice(2).trim();
  if (!s.startsWith('run:')) return null;
  const command = s.slice('run:'.length).trim();
  if (command === '' || command === '|' || command === '>' || command === '|-' || command === '>-') return null;
  return command;
}

/**
 * Deterministic ordering: confidence desc, then source asc, then command asc.
 * @param {VerificationCandidate[]} candidates
 * @returns {VerificationCandidate[]}
 */
function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.command < b.command ? -1 : a.command > b.command ? 1 : 0;
  });
}
