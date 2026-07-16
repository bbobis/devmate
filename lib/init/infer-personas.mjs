// @ts-check
import { buildStarterConfig } from '../config/init-config.mjs';

/** @typedef {import('../types.mjs').PersonaEntry} PersonaEntry */
/** @typedef {import('./scan-repo-signals.mjs').RepoSignals} RepoSignals */

// TODO: calibrate after first multi-language onboarding — default globs are provisional.
const DEFAULT_PERSONA_TEST_GLOBS = ['**/*.spec.*', '**/*.test.*'];

/** Top-level dirs that read as UI/frontend territory (sorted for stable globs). */
const UI_DIRS = ['app', 'assets', 'client', 'components', 'pages', 'public', 'src', 'static', 'styles', 'ui', 'web'];

/** Top-level dirs that read as server/backend territory (sorted for stable globs). */
const SERVER_DIRS = ['api', 'backend', 'cmd', 'internal', 'lib', 'pkg', 'server', 'services'];

/**
 * Map a candidate dir-name list to `<dir>/**` globs for those actually present
 * at the repo top level, falling back to `fallback` when none are found. This
 * is what grounds proposed globs in the real layout instead of fixed literals.
 * @param {RepoSignals} signals
 * @param {string[]} candidates  Candidate top-level dir names.
 * @param {string[]} fallback    Globs to use when no candidate dir exists.
 * @returns {string[]}
 */
function groundedGlobs(signals, candidates, fallback) {
  const globs = candidates.filter((d) => signals.topLevelDirs.includes(d)).map((d) => `${d}/**`);
  return globs.length > 0 ? globs : fallback;
}

/**
 * The frontend persona proposed when TS/JS signals are present. Globs are
 * grounded in the repo's real top-level layout — conservative proposals, NOT
 * guarantees; the user reviews and edits them before anything is written
 * (anti-hallucination: never silent-write a guess).
 * @param {RepoSignals} signals
 * @returns {PersonaEntry}
 */
function frontendPersona(signals) {
  return {
    persona: 'frontend',
    editableGlobs: groundedGlobs(signals, UI_DIRS, ['src/**/*.{ts,tsx,js,jsx,css}', 'public/**']),
    offLimitsGlobs: groundedGlobs(signals, SERVER_DIRS, ['src/main/java/**', 'src/test/java/**']),
    testGlobs: DEFAULT_PERSONA_TEST_GLOBS,
  };
}

/**
 * The backend persona proposed when Java/server signals are present. Globs are
 * grounded in the real layout; a Java `src/main` / `src/test` layout is added
 * explicitly when present.
 * @param {RepoSignals} signals
 * @returns {PersonaEntry}
 */
function backendPersona(signals) {
  const editable = groundedGlobs(signals, SERVER_DIRS, ['src/main/**', 'src/test/**', 'lib/**']);
  if (signals.srcChildren.includes('main')) editable.push('src/main/**');
  if (signals.srcChildren.includes('test')) editable.push('src/test/**');
  return {
    persona: 'backend',
    editableGlobs: [...new Set(editable)],
    offLimitsGlobs: groundedGlobs(signals, UI_DIRS.filter((d) => d !== 'src'), ['src/ui/**', 'public/**']),
    testGlobs: DEFAULT_PERSONA_TEST_GLOBS,
  };
}

/**
 * Detect a TS/JS frontend stack from signals. A package manifest is the primary
 * signal; a tsconfig or a UI-ish src subdir strengthens it.
 * @param {RepoSignals} s
 * @returns {boolean}
 */
function looksFrontend(s) {
  if (!s.hasPackageJson) return false;
  // package.json alone is enough for a JS stack; tsconfig / UI dirs reinforce.
  return true;
}

/**
 * Detect a Java backend stack from signals: a Java build file, or a
 * src/main/java layout.
 * @param {RepoSignals} s
 * @returns {boolean}
 */
function looksBackend(s) {
  if (s.hasJavaBuild) return true;
  return s.srcSubdirs.includes('main/java') || s.srcSubdirs.includes('test/java');
}

/**
 * Infer proposed personas from repo signals. Deterministic and pure: the same
 * RepoSignals always yields identical personas. Returns at least one persona;
 * when no stack is recognized it falls back to the starter default personas.
 *
 * @param {RepoSignals} signals
 * @returns {PersonaEntry[]}
 */
export function inferPersonas(signals) {
  /** @type {PersonaEntry[]} */
  const personas = [];

  if (looksFrontend(signals)) {
    personas.push(frontendPersona(signals));
  }
  if (looksBackend(signals)) {
    personas.push(backendPersona(signals));
  }

  if (personas.length === 0) {
    // No recognizable stack — fall back to the validated starter personas so
    // the proposal is always valid and has >= 1 persona.
    return buildStarterConfig().personas;
  }

  return personas;
}
