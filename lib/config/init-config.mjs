// @ts-check
import { dirname, join } from 'node:path';
import { ensureDirSync, pathExists, writeTextFileSync } from '../fs-safe.mjs';
import { CONFIG_PATH, validateDevmateConfig } from './devmate-config.mjs';

/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../types.mjs').PersonaEntry} PersonaEntry */

// TODO: calibrate after first multi-language onboarding — default globs are provisional.
const DEFAULT_PERSONA_TEST_GLOBS = ['**/*.spec.*', '**/*.test.*'];

/**
 * The empty verification floor: a valid, self-describing `checks[]` with no
 * checks yet. The inference flow replaces this with grounded checks scanned
 * from the repo; the static starter ships it empty (the loader then warns that
 * the TDD gate is disabled until a unit-test check is added).
 * @returns {import('../types.mjs').VerificationConfig}
 */
function defaultVerification() {
  return { checks: [] };
}

/**
 * Build a starter devmate.config.json object with at least one persona and
 * editable/off-limits globs. This is what the gate-guard fail-safe message
 * (`run devmate init`) points consumers to.
 *
 * @returns {DevmateConfig}
 */
export function buildStarterConfig() {
  return {
    schemaVersion: 1,
    personas: [
      {
        persona: 'frontend',
        editableGlobs: ['src/**/*.{ts,tsx,css}', 'public/**'],
        offLimitsGlobs: ['src/main/java/**', 'src/test/java/**'],
        testGlobs: DEFAULT_PERSONA_TEST_GLOBS,
      },
      {
        persona: 'backend',
        editableGlobs: ['src/main/**', 'src/test/**', 'lib/**'],
        offLimitsGlobs: ['src/ui/**', 'public/**'],
        testGlobs: DEFAULT_PERSONA_TEST_GLOBS,
      },
    ],
    verification: defaultVerification(),
  };
}

/**
 * Build a devmate config object from a given set of personas. Used by the
 * inference flow (#142) so an inferred proposal goes through the SAME schema
 * validation as the static starter config.
 *
 * @param {PersonaEntry[]} personas  Proposed personas (e.g. from inferPersonas).
 * @param {import('../types.mjs').VerificationConfig} [verification]
 *   Inferred verification (e.g. from inferVerificationChecks). Defaults to the
 *   empty verification floor.
 * @returns {DevmateConfig}
 */
export function buildConfigFromPersonas(personas, verification = defaultVerification()) {
  return {
    schemaVersion: 1,
    personas: personas.map((persona) => ({
      ...persona,
      testGlobs: persona.testGlobs ?? DEFAULT_PERSONA_TEST_GLOBS,
    })),
    verification,
  };
}

/**
 * Write a schema-validated starter config to disk.
 *
 * Behavior:
 *  - Refuses to overwrite an existing file unless `force` is true.
 *  - Validates the generated config before writing; never writes an invalid file.
 *
 * @param {object}        [opts]
 * @param {string}        [opts.configPath]  Explicit target path; takes priority over repoRoot.
 * @param {string}        [opts.repoRoot]    Repo root to anchor CONFIG_PATH against.
 *                                           Falls back to process.cwd() when omitted.
 * @param {boolean}       [opts.force]       Overwrite an existing file. Default false.
 * @param {DevmateConfig} [opts.config]      Config to write. Defaults to the static starter config.
 * @returns {{ ok: true, path: string, created: boolean } | { ok: false, error: string }}
 */
export function initConfig(opts) {
  const base = opts?.repoRoot ?? process.cwd();
  const configPath = opts?.configPath ?? join(base, CONFIG_PATH);
  const force = opts?.force ?? false;

  if (pathExists(configPath) && !force) {
    return {
      ok: false,
      error: `Config already exists at ${configPath}. Pass --force to overwrite.`,
    };
  }

  const starter = opts?.config ?? buildStarterConfig();
  const result = validateDevmateConfig(starter);
  if (!result.ok) {
    return { ok: false, error: `Refusing to write invalid starter config: ${result.error}` };
  }

  ensureDirSync(dirname(configPath));
  writeTextFileSync(configPath, JSON.stringify(starter, null, 2) + '\n');
  return { ok: true, path: configPath, created: true };
}
