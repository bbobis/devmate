// @ts-check
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, readTextFile, statPath } from '../fs-safe.mjs';
import { formatDuplicatePersonaError, validateDevmateConfig } from '../config/devmate-config.mjs';
import { MEMORY_PATH } from '../memory/paths.mjs';

/**
 * Path of the devmate config file relative to the workspace root.
 * @type {string}
 */
const CONFIG_REL = '.devmate/devmate.config.json';

/**
 * Path of the state directory relative to the workspace root.
 * @type {string}
 */
const STATE_DIR_REL = '.devmate/state';

/**
 * Minimal scaffold written into the canonical memory file when it does not
 * already exist. Never written over an existing file.
 * @type {string}
 */
const MEMORY_SCAFFOLD =
  '# Memory\n\n> Shared cross-repo memory for this multi-root session. Managed by you; safe to edit.\n';

/**
 * Return true when the resolved devmate config declares multi-root mode.
 * Never throws — returns false on any read/parse error (fail-open).
 *
 * @param {string} repoRoot  Absolute path to the resolved workspace root.
 * @returns {Promise<boolean>}
 */
export async function detectMultiRootMode(repoRoot) {
  const configPath = join(repoRoot, CONFIG_REL);
  try {
    const raw = await readTextFile(configPath);
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && parsed['mode'] === 'multi-root';
  } catch {
    // File absent, unreadable, or malformed JSON — treat as not multi-root.
    return false;
  }
}

/**
 * @typedef {Object} ValidateMultiRootInitResult
 * @property {boolean}  ok       True when config is valid and all artefacts are ready.
 * @property {string[]} errors   Human-readable validation failures (empty when ok).
 * @property {string[]} created  Absolute paths created during this call.
 */

/**
 * Validate an existing multi-root config and ensure required state artefacts
 * are present. Returns a structured result — never throws.
 *
 * Checks performed:
 *   1. Config file is readable and parseable.
 *   2. validateDevmateConfig() passes (schema, personas array, etc.).
 *   3. Duplicate persona names are rejected (belt-and-suspenders ahead of B7
 *      which will add the same check to validateDevmateConfig itself).
 *   4. .devmate/state/ directory exists (creates it if absent).
 *   5. Canonical memory file exists (writes scaffold if absent; NEVER overwrites).
 *
 * @param {string} repoRoot  Absolute path to the resolved workspace root.
 * @returns {Promise<ValidateMultiRootInitResult>}
 */
export async function validateMultiRootInit(repoRoot) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const created = [];

  // 1 + 2: Read and validate the config.
  const configPath = join(repoRoot, CONFIG_REL);
  let raw;
  try {
    raw = await readTextFile(configPath);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    errors.push(
      code === 'ENOENT'
        ? `devmate.config.json not found at ${configPath}`
        : `Could not read devmate.config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, errors, created };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`devmate.config.json is not valid JSON at ${configPath}`);
    return { ok: false, errors, created };
  }

  const validation = validateDevmateConfig(parsed);
  if (!validation.ok) {
    errors.push(validation.error);
    return { ok: false, errors, created };
  }

  // 3: Duplicate persona name check — belt-and-suspenders ahead of B7.
  // validateDevmateConfig (B7, not yet merged) will add this to the shared
  // validator. Until then, enforce it here so multi-root sessions are always
  // safe regardless of merge order.
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const personasArr = /** @type {unknown[]} */ (obj['personas']);
  /** @type {Map<string, string>} */
  const seen = new Map(); // persona name → repo name
  for (const entry of personasArr) {
    const e = /** @type {Record<string, unknown>} */ (entry);
    const name = String(e['persona'] ?? '');
    const repo = String(e['repo'] ?? '');
    if (seen.has(name)) {
      errors.push(formatDuplicatePersonaError(name, /** @type {string} */ (seen.get(name)), repo));
      return { ok: false, errors, created };
    }
    seen.set(name, repo);
  }

  // 4: Ensure .devmate/state/ exists.
  const stateDirAbs = join(repoRoot, STATE_DIR_REL);
  if (!(await isDir(stateDirAbs))) {
    await ensureDir(stateDirAbs);
    created.push(stateDirAbs);
  }

  // 5: Ensure canonical memory file exists — write scaffold only when absent.
  const memoryAbs = join(repoRoot, MEMORY_PATH);
  if (!(await pathExists(memoryAbs))) {
    await ensureDir(join(repoRoot, '.devmate'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 'wx' (O_EXCL) create-only write IS the never-overwrite guarantee for the memory scaffold; facade writers deliberately do not expose open flags. Path is join(repoRoot, MEMORY_PATH).
    await writeFile(memoryAbs, MEMORY_SCAFFOLD, { flag: 'wx' });
    created.push(memoryAbs);
  }

  return { ok: true, errors: [], created };
}

/**
 * B9: Format a failed multi-root guard result as an actionable pointer instead
 * of a dead-end error dump. devmate is read-only for multi-root configs — the
 * workspace config is written by monoroot (the sole writer) — so a validation
 * failure must point at the source and name the exact verb to run, never leave
 * the user stuck.
 *
 * @param {ValidateMultiRootInitResult} result  A failed result (ok === false).
 * @param {{ repoRoot: string }} ctx
 * @returns {string}
 */
export function formatMultiRootGuardFailure(result, ctx) {
  const problems = result.errors.length > 0 ? result.errors : ['multi-root config validation failed'];
  const bullets = problems.map((e) => `  - ${e}`).join('\n');
  return [
    '[devmate-init] This multi-root workspace config has a problem devmate cannot fix from here.',
    'devmate is read-only for multi-root configs — the workspace config is written by',
    'monoroot (the sole writer). Fix at the source, then regenerate.',
    '',
    'Problem(s):',
    bullets,
    '',
    `Workspace root: ${ctx.repoRoot}`,
    '',
    'To fix:',
    "  1. Correct the offending repo's .devmate/devmate.config.json (or run `devmate init` inside it).",
    '  2. In VS Code, run "Multi-Repo Workspace: Re-sync devmate" to rebuild the workspace config in place',
    '     (or re-create the session if the workspace is gone).',
  ].join('\n');
}

/**
 * B10: Repos running on a synthesized fallback persona, derived from the
 * producer's `source` markers. Mirrors the util's `synthesizedReposOf`. Pure and
 * non-throwing — safe to call on any parsed config.
 *
 * @param {import('../types.mjs').DevmateConfig} config
 * @returns {string[]}
 */
export function fallbackReposOf(config) {
  if (!config || !Array.isArray(config.personas)) {
    return [];
  }
  /** @type {string[]} */
  const repos = [];
  for (const p of config.personas) {
    if (
      p &&
      p.source === 'fallback' &&
      typeof p.repo === 'string' &&
      !repos.includes(p.repo)
    ) {
      repos.push(p.repo);
    }
  }
  return repos;
}

/**
 * B10: Non-blocking nudge naming the repos on fallback scoping and the exact
 * repair route. Advisory only — the session is fully usable on fallback personas.
 *
 * @param {string[]} fallbackRepos  Non-empty list of repo names on fallback.
 * @returns {string}
 */
export function formatFallbackNudge(fallbackRepos) {
  const n = fallbackRepos.length;
  const noun = n === 1 ? 'repo is' : 'repos are';
  return (
    `[devmate] ${n} ${noun} on fallback scoping (${fallbackRepos.join(', ')}). ` +
    `Add a .devmate/devmate.config.json in each (devmate init), then run ` +
    `"Re-sync devmate" in monoroot for real boundaries.`
  );
}

/**
 * Contract-version skew nudge: the producer (monoroot) stamps the shared
 * contract version it wrote the merged config against as `contractVersion`;
 * when that stamp differs from the consumer's pinned version the session
 * still runs, but the user should re-align the two sides. Mirrors
 * `formatFallbackNudge` — advisory only, fail-open: callers only invoke it
 * when both versions are actual numbers that differ, so an unstamped config
 * (an older producer) never nudges.
 *
 * @param {number} configVersion    The contractVersion stamped into the merged config.
 * @param {number} consumerVersion  The contract version this devmate build targets.
 * @returns {string}
 */
export function formatContractSkewNudge(configVersion, consumerVersion) {
  const direction = configVersion > consumerVersion
    ? 'update the devmate plugin'
    : 'update the monoroot extension';
  return (
    `[devmate] contract version skew: the merged config was written at contract ` +
    `v${configVersion} but this devmate build targets v${consumerVersion}. ` +
    `The session still works; to re-align, ${direction}, then run ` +
    `"Re-sync devmate" in monoroot to rebuild the workspace config.`
  );
}

/**
 * True if `p` exists and is a directory.
 * @param {string} p  Absolute path.
 * @returns {Promise<boolean>}
 */
async function isDir(p) {
  try {
    const s = await statPath(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * True if `p` exists (any type).
 * @param {string} p  Absolute path.
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try {
    await statPath(p);
    return true;
  } catch {
    return false;
  }
}
