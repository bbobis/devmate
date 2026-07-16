// @ts-check
import { dirname, resolve } from 'node:path';
import { readTextFileSync } from '../fs-safe.mjs';
import {
  DEFAULT_SESSION_ARTIFACT_PATHS,
  DEFAULT_SESSION_ARTIFACT_WRITERS,
} from '../gate-guard-core.mjs';
import { resolveUnitTestCommand } from './verification.mjs';

/** @typedef {import('../types.mjs').PersonaEntry} PersonaEntry */
/** @typedef {import('../types.mjs').SessionArtifactWriter} SessionArtifactWriter */
/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('../types.mjs').ConfigResult} ConfigResult */
/** @typedef {import('../types.mjs').DomainConfig} DomainConfig */

/**
 * Fields a domains[] entry may declare (DN-1). Matches
 * docs/devmate-config.schema.json's `additionalProperties: false` per-entry
 * strictness — an entry with any other key is rejected.
 * @type {ReadonlySet<string>}
 */
const DOMAIN_ENTRY_KEYS = new Set(['domain', 'keywords', 'globs', 'contextFile', 'relatedDomains', 'entryPoints']);

/**
 * Look for a non-string entry (or a non-array shape) in a domains[] list field.
 * @param {unknown} items
 * @param {string} fieldLabel  e.g. "domains[0].keywords" — used in the error message.
 * @returns {string|null}  Error message, or null when valid.
 */
function findStringListFieldError(items, fieldLabel) {
  if (!Array.isArray(items)) {
    return `${fieldLabel} must be an array`;
  }
  for (let i = 0; i < items.length; i++) {
    if (typeof items[i] !== 'string') {
      return `${fieldLabel}[${i}] must be a string`;
    }
  }
  return null;
}

/**
 * Validate the optional `verification.checks[]` list (E14 re-spec). Each check
 * needs non-empty string `id`/`command`/`category`, a unique `id`, an optional
 * boolean `optional`, and an optional string `source`. `category` is an OPEN
 * string on purpose — the check set is fit to the codebase, never a fixed enum.
 * @param {unknown} checks
 * @returns {string|null}  Error message, or null when valid.
 */
function validateVerificationChecks(checks) {
  if (!Array.isArray(checks)) {
    return 'devmate.config.json verification.checks must be an array when present';
  }
  /** @type {Set<string>} */
  const seenIds = new Set();
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      return `devmate.config.json verification.checks[${i}] must be an object`;
    }
    const rec = /** @type {Record<string, unknown>} */ (c);
    const id = rec['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return `devmate.config.json verification.checks[${i}].id must be a non-empty string`;
    }
    if (typeof rec['command'] !== 'string' || /** @type {string} */ (rec['command']).trim() === '') {
      return `devmate.config.json verification.checks[${i}].command must be a non-empty string`;
    }
    if (typeof rec['category'] !== 'string' || /** @type {string} */ (rec['category']).trim() === '') {
      return `devmate.config.json verification.checks[${i}].category must be a non-empty string`;
    }
    if (seenIds.has(id)) {
      return `devmate.config.json verification.checks contains duplicate id '${id}'`;
    }
    seenIds.add(id);
    if (rec['optional'] !== undefined && typeof rec['optional'] !== 'boolean') {
      return `devmate.config.json verification.checks[${i}].optional must be a boolean when present`;
    }
    if (rec['source'] !== undefined && typeof rec['source'] !== 'string') {
      return `devmate.config.json verification.checks[${i}].source must be a string when present`;
    }
  }
  return null;
}

/**
 * B7: The one duplicate-persona message, shared by every validator that
 * rejects a cross-repo persona-name collision (validateDevmateConfig and
 * validateMultiRootInit) so the two sites can never drift apart. Names the
 * producer (monoroot) and its repair verb, never a dead end.
 * @param {string} personaName  The colliding persona name.
 * @param {string} firstRepo    Repo that claimed the name first.
 * @param {string} secondRepo   Repo that collided with it.
 * @returns {string}
 */
export function formatDuplicatePersonaError(personaName, firstRepo, secondRepo) {
  return (
    `devmate: duplicate persona '${personaName}' found in repos ` +
    `'${firstRepo}' and '${secondRepo}'. ` +
    `Each persona name must be unique across all repos in a multi-root workspace. ` +
    `Rename one persona in the affected repo's devmate.config.json, ` +
    `then run "Re-sync devmate" in monoroot to regenerate the workspace config.`
  );
}

/**
 * Find a persona entry by name.
 * @param {DevmateConfig} config
 * @param {string} personaName
 * @returns {PersonaEntry|undefined}
 */
export function findPersona(config, personaName) {
  return config.personas.find((entry) => entry.persona === personaName);
}

/**
 * Return configured test globs for the given persona.
 * @param {DevmateConfig} config
 * @param {string} personaName
 * @returns {string[]|undefined}
 */
export function getPersonaTestGlobs(config, personaName) {
  const persona = findPersona(config, personaName);
  return persona?.testGlobs;
}

/**
 * Default path for the per-consumer devmate config file.
 * @type {string}
 */
export const CONFIG_PATH = '.devmate/devmate.config.json';

/**
 * schemaVersion values this build understands. v1 = single-repo configs written
 * by `devmate init`; v2 = merged multi-root configs written by
 * monoroot. `mode` — not this number — is the structural
 * discriminator; the version set only gates forward-compatibility. A config
 * numbered above the max is rejected with an upgrade pointer rather than a
 * generic error (see validateDevmateConfig).
 * @type {readonly number[]}
 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);

/**
 * Resolve the delegation-floor mode from a config object. The string
 * `delegationFloor` ('off' | 'warn' | 'block') wins; the legacy boolean
 * `enforceDelegationFloor: true` maps to 'block'. Anything else is 'off'.
 * @param {unknown} config
 * @returns {'off'|'warn'|'block'}
 */
export function resolveDelegationFloorMode(config) {
  if (config === null || typeof config !== 'object') return 'off';
  const rec = /** @type {Record<string, unknown>} */ (config);
  const mode = rec['delegationFloor'];
  if (mode === 'off' || mode === 'warn' || mode === 'block') return mode;
  if (rec['enforceDelegationFloor'] === true) return 'block';
  return 'off';
}

/**
 * Resolve the persona-scope enforcement mode from a config object. `personaScope`
 * ('off' | 'warn' | 'block') selects how a completion-time persona-scope
 * violation (a `@fullstack` dispatch that changed a file outside its persona's
 * territory) is handled. Defaults to **'warn'** (record + surface, do not halt).
 * @param {unknown} config
 * @returns {'off'|'warn'|'block'}
 */
export function resolvePersonaScopeMode(config) {
  if (config === null || typeof config !== 'object') return 'warn';
  const rec = /** @type {Record<string, unknown>} */ (config);
  const mode = rec['personaScope'];
  if (mode === 'off' || mode === 'warn' || mode === 'block') return mode;
  return 'warn';
}

/**
 * Resolve the optional per-lane delegation-floor requirement override from a
 * config object. Returns the `delegationFloorRequirements` map (lane -> any-of
 * groups) when present and object-shaped, else undefined (use built-in defaults).
 * @param {unknown} config
 * @returns {Record<string, unknown>|undefined}
 */
export function resolveDelegationFloorRequirements(config) {
  if (config === null || typeof config !== 'object') return undefined;
  const rec = /** @type {Record<string, unknown>} */ (config);
  const req = rec['delegationFloorRequirements'];
  return req !== null && typeof req === 'object' && !Array.isArray(req)
    ? /** @type {Record<string, unknown>} */ (req)
    : undefined;
}

/**
 * Resolve the AC-coverage gate mode from a config object. `acCoverageGate`
 * ('off' | 'warn' | 'block') selects how the verification-passed / pr-ready
 * gate preconditions react to an incomplete acceptance-criteria coverage read
 * (AC-1's `computeAcCoverage`): 'off' (no read, no block, no trace churn —
 * the default), 'warn' (record a `contract_violation` but allow the
 * transition), or 'block' (refuse). Mirrors `resolveDelegationFloorMode`'s
 * mode resolution shape (no legacy boolean here — there is no prior key to
 * stay backward compatible with).
 * // TODO: calibrate after Phase 1 rollout — default is a provisional placeholder
 * @param {unknown} config
 * @returns {'off'|'warn'|'block'}
 */
export function resolveAcCoverageGateMode(config) {
  if (config === null || typeof config !== 'object') return 'off';
  const rec = /** @type {Record<string, unknown>} */ (config);
  const mode = rec['acCoverageGate'];
  if (mode === 'off' || mode === 'warn' || mode === 'block') return mode;
  return 'off';
}

/**
 * Resolve the PR-review gate mode from a config object. `prReviewGate`
 * ('off' | 'warn' | 'block') selects how the `pr-ready` gate precondition
 * (feature + bug lanes) reacts to a missing/invalid PrReviewArtifact or a
 * non-APPROVE verdict (PRR-3): 'off' (no read, no block, no trace churn —
 * the default), 'warn' (record a `contract_violation` but allow the
 * transition), or 'block' (refuse). Mirrors `resolveAcCoverageGateMode`'s
 * mode-resolution shape (no legacy boolean — there is no prior key to stay
 * backward compatible with).
 * // TODO: calibrate after Phase 1 rollout — default is a provisional placeholder
 * @param {unknown} config
 * @returns {'off'|'warn'|'block'}
 */
export function resolvePrReviewGateMode(config) {
  if (config === null || typeof config !== 'object') return 'off';
  const rec = /** @type {Record<string, unknown>} */ (config);
  const mode = rec['prReviewGate'];
  if (mode === 'off' || mode === 'warn' || mode === 'block') return mode;
  return 'off';
}

/**
 * Default idle threshold, in hours, past which an in-flight task is treated as
 * stale (likely abandoned). 48h means a workflow left mid-flow over a weekend
 * no longer blocks an unrelated new task with a park/abandon interrogation.
 * @type {number}
 */
export const DEFAULT_STALE_TASK_HOURS = 48;

/**
 * Resolve the stale-task idle threshold (hours) from a config object. The
 * numeric `staleTaskHours` wins when it is a finite number > 0; anything else
 * falls back to {@link DEFAULT_STALE_TASK_HOURS}.
 * @param {unknown} config
 * @returns {number}
 */
export function resolveStaleTaskHours(config) {
  if (config === null || typeof config !== 'object') return DEFAULT_STALE_TASK_HOURS;
  const rec = /** @type {Record<string, unknown>} */ (config);
  const raw = rec['staleTaskHours'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_STALE_TASK_HOURS;
}

/**
 * Validate the optional `sessionArtifactWriters` list (#93): each entry is a
 * `{ glob, agents[] }` pair naming the agents permitted to write the artifacts a
 * glob matches. Fails closed on any malformed entry — a half-read writer roster
 * would silently widen the boundary it exists to narrow.
 * @param {unknown} writers
 * @returns {string|null}  Error message, or null when valid.
 */
function validateSessionArtifactWriters(writers) {
  if (!Array.isArray(writers)) {
    return 'devmate.config.json sessionArtifactWriters must be an array when present';
  }
  for (let i = 0; i < writers.length; i++) {
    const entry = writers[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `devmate.config.json sessionArtifactWriters[${i}] must be an object`;
    }
    const rec = /** @type {Record<string, unknown>} */ (entry);
    if (typeof rec['glob'] !== 'string' || /** @type {string} */ (rec['glob']).trim() === '') {
      return `devmate.config.json sessionArtifactWriters[${i}].glob must be a non-empty string`;
    }
    if (!Array.isArray(rec['agents'])) {
      return `devmate.config.json sessionArtifactWriters[${i}].agents must be an array of agent names`;
    }
    const agents = /** @type {unknown[]} */ (rec['agents']);
    for (let j = 0; j < agents.length; j++) {
      if (typeof agents[j] !== 'string' || /** @type {string} */ (agents[j]).trim() === '') {
        return `devmate.config.json sessionArtifactWriters[${i}].agents[${j}] must be a non-empty string`;
      }
    }
  }
  return null;
}

/**
 * Resolve the session-artifact protection policy (#93) from a config object: the
 * globs no agent may hand-edit, and the per-artifact writer exceptions. Absent
 * or non-object config takes the protective defaults from gate-guard-core —
 * never an empty list, which is what left the rule dormant.
 * @param {unknown} config
 * @returns {{ paths: readonly string[], writers: readonly SessionArtifactWriter[] }}
 */
export function resolveSessionArtifactPolicy(config) {
  if (config === null || typeof config !== 'object') {
    return { paths: DEFAULT_SESSION_ARTIFACT_PATHS, writers: DEFAULT_SESSION_ARTIFACT_WRITERS };
  }
  const rec = /** @type {Record<string, unknown>} */ (config);
  const rawPaths = rec['sessionArtifactPaths'];
  const rawWriters = rec['sessionArtifactWriters'];
  return {
    paths: Array.isArray(rawPaths)
      ? /** @type {string[]} */ (rawPaths)
      : DEFAULT_SESSION_ARTIFACT_PATHS,
    writers: Array.isArray(rawWriters)
      ? /** @type {SessionArtifactWriter[]} */ (rawWriters)
      : DEFAULT_SESSION_ARTIFACT_WRITERS,
  };
}

/**
 * Validate a parsed devmate.config.json object.
 * @param {unknown} raw
 * @returns {ConfigResult}
 */
export function validateDevmateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'devmate.config.json must be a JSON object' };
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @type {string[]} */
  const warnings = [];

  // B2: multi-root configs branch on this flag. Single-root configs (no `mode`
  // or mode !== 'multi-root') take every existing validation path unchanged.
  const isMultiRoot = obj['mode'] === 'multi-root';

  const schemaVersion = obj['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { ok: false, error: 'devmate.config.json must have an integer schemaVersion' };
  }
  const maxKnownVersion = Math.max(...SUPPORTED_SCHEMA_VERSIONS);
  if (schemaVersion > maxKnownVersion) {
    return {
      ok: false,
      error:
        `devmate.config.json schemaVersion ${schemaVersion} is newer than this ` +
        `devmate build supports (max ${maxKnownVersion}). Upgrade the devmate plugin.`,
    };
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return {
      ok: false,
      error:
        `devmate.config.json schemaVersion ${schemaVersion} is not supported ` +
        `(expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).`,
    };
  }

  if (!Array.isArray(obj['personas']) || /** @type {unknown[]} */ (obj['personas']).length === 0) {
    return { ok: false, error: 'devmate.config.json must have a non-empty personas array' };
  }

  // Optional E13-4 maxConcurrentAgents: positive integer when present.
  if (obj['maxConcurrentAgents'] !== undefined) {
    const mca = obj['maxConcurrentAgents'];
    if (typeof mca !== 'number' || !Number.isInteger(mca) || mca < 1) {
      return { ok: false, error: 'devmate.config.json maxConcurrentAgents must be a positive integer when present' };
    }
  }

  // Opt-in delegation floor (default off). `delegationFloor` selects the mode —
  // 'off' | 'warn' | 'block'; the legacy boolean `enforceDelegationFloor: true`
  // still maps to 'block'. When active, entering impl-started is refused (block)
  // or recorded (warn) unless the lane's read-heavy analysis was delegated to
  // subagents (enforced by the impl-started gate precondition).
  if (obj['delegationFloor'] !== undefined &&
      !['off', 'warn', 'block'].includes(/** @type {string} */ (obj['delegationFloor']))) {
    return { ok: false, error: "devmate.config.json delegationFloor must be one of 'off', 'warn', 'block' when present" };
  }
  if (obj['enforceDelegationFloor'] !== undefined && typeof obj['enforceDelegationFloor'] !== 'boolean') {
    return { ok: false, error: 'devmate.config.json enforceDelegationFloor must be a boolean when present' };
  }

  // Persona-scope enforcement mode (default 'warn'). Selects how a completion-time
  // persona-scope violation (a fullstack dispatch that changed a file outside its
  // persona's territory) is handled: 'off' | 'warn' | 'block'.
  if (obj['personaScope'] !== undefined &&
      !['off', 'warn', 'block'].includes(/** @type {string} */ (obj['personaScope']))) {
    return { ok: false, error: "devmate.config.json personaScope must be one of 'off', 'warn', 'block' when present" };
  }

  // AC-coverage gate mode (default 'off'). `acCoverageGate` selects how the
  // verification-passed / pr-ready gate preconditions react to an incomplete
  // AC-1 coverage read: 'off' | 'warn' | 'block' (AC-2, epic #416).
  if (obj['acCoverageGate'] !== undefined &&
      !['off', 'warn', 'block'].includes(/** @type {string} */ (obj['acCoverageGate']))) {
    return { ok: false, error: "devmate.config.json acCoverageGate must be one of 'off', 'warn', 'block' when present" };
  }

  // PR-review gate mode (default 'off'). `prReviewGate` selects how the
  // pr-ready gate precondition (feature + bug lanes) reacts to a missing/
  // invalid PrReviewArtifact or a non-APPROVE verdict: 'off' | 'warn' |
  // 'block' (PRR-3).
  if (obj['prReviewGate'] !== undefined &&
      !['off', 'warn', 'block'].includes(/** @type {string} */ (obj['prReviewGate']))) {
    return { ok: false, error: "devmate.config.json prReviewGate must be one of 'off', 'warn', 'block' when present" };
  }

  // Optional per-lane requirement override: lane -> array of any-of groups
  // (string[][]). Replaces the built-in lane requirements for any lane it names.
  if (obj['delegationFloorRequirements'] !== undefined) {
    const dfr = obj['delegationFloorRequirements'];
    if (dfr === null || typeof dfr !== 'object' || Array.isArray(dfr)) {
      return { ok: false, error: 'devmate.config.json delegationFloorRequirements must be an object mapping lane to an array of any-of groups when present' };
    }
    for (const [laneName, groups] of Object.entries(/** @type {Record<string, unknown>} */ (dfr))) {
      if (!Array.isArray(groups)) {
        return { ok: false, error: `devmate.config.json delegationFloorRequirements.${laneName} must be an array of any-of groups` };
      }
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        if (!Array.isArray(group) || group.length === 0) {
          return { ok: false, error: `devmate.config.json delegationFloorRequirements.${laneName}[${gi}] must be a non-empty array of agent names` };
        }
        for (const agent of group) {
          if (typeof agent !== 'string' || agent.trim() === '') {
            return { ok: false, error: `devmate.config.json delegationFloorRequirements.${laneName}[${gi}] agent names must be non-empty strings` };
          }
        }
      }
    }
  }

  // #93 session-artifact protection: optional overrides of the protective
  // defaults. Both fail closed on malformed input.
  if (obj['sessionArtifactPaths'] !== undefined) {
    const paths = obj['sessionArtifactPaths'];
    if (!Array.isArray(paths)) {
      return { ok: false, error: 'devmate.config.json sessionArtifactPaths must be an array of globs when present' };
    }
    const list = /** @type {unknown[]} */ (paths);
    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string' || /** @type {string} */ (list[i]).trim() === '') {
        return { ok: false, error: `devmate.config.json sessionArtifactPaths[${i}] must be a non-empty string` };
      }
    }
  }
  if (obj['sessionArtifactWriters'] !== undefined) {
    const writersError = validateSessionArtifactWriters(obj['sessionArtifactWriters']);
    if (writersError) return { ok: false, error: writersError };
  }

  // Optional E12-2 testGlobs: must be an array of strings if present.
  if (obj['testGlobs'] !== undefined) {
    if (!Array.isArray(obj['testGlobs'])) {
      return { ok: false, error: 'devmate.config.json testGlobs must be an array of strings when present' };
    }
    const tg = /** @type {unknown[]} */ (obj['testGlobs']);
    for (let i = 0; i < tg.length; i++) {
      if (typeof tg[i] !== 'string') {
        return { ok: false, error: `devmate.config.json testGlobs[${i}] must be a string` };
      }
    }
  }

  // Optional E14 verification block. `checks[]` is canonical; unitTest/typeCheck/
  // e2e are accepted as DEPRECATED legacy input (normalized into checks by the
  // loader — see lib/config/verification.mjs).
  if (obj['verification'] !== undefined) {
    const verification = obj['verification'];
    if (verification === null || typeof verification !== 'object' || Array.isArray(verification)) {
      return { ok: false, error: 'devmate.config.json verification must be an object when present' };
    }
    const v = /** @type {Record<string, unknown>} */ (verification);
    if (v['unitTest'] !== undefined && typeof v['unitTest'] !== 'string') {
      return { ok: false, error: 'devmate.config.json verification.unitTest must be a string when present' };
    }
    if (v['typeCheck'] !== undefined && typeof v['typeCheck'] !== 'string') {
      return { ok: false, error: 'devmate.config.json verification.typeCheck must be a string when present' };
    }
    if (v['e2e'] !== undefined && typeof v['e2e'] !== 'string') {
      return { ok: false, error: 'devmate.config.json verification.e2e must be a string when present' };
    }
    if (v['checks'] !== undefined) {
      const checksError = validateVerificationChecks(v['checks']);
      if (checksError) return { ok: false, error: checksError };
    }
  }

  const personasArr = /** @type {unknown[]} */ (obj['personas']);
  for (let i = 0; i < personasArr.length; i++) {
    const entry = personasArr[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `personas[${i}] must be an object` };
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (typeof e['persona'] !== 'string' || String(e['persona']).trim() === '') {
      return { ok: false, error: `personas[${i}].persona must be a non-empty string` };
    }
    if (!Array.isArray(e['editableGlobs'])) {
      return { ok: false, error: `personas[${i}].editableGlobs must be an array` };
    }
    // B2: in multi-root mode each persona targets its own repo subdirectory.
    if (isMultiRoot) {
      if (typeof e['repo'] !== 'string' || String(e['repo']).trim() === '') {
        return { ok: false, error: `personas[${i}].repo must be a non-empty string in multi-root mode` };
      }
    }
    if (e['testGlobs'] !== undefined) {
      if (!Array.isArray(e['testGlobs'])) {
        return { ok: false, error: `personas[${i}].testGlobs must be an array of strings when present` };
      }
      const testGlobs = /** @type {unknown[]} */ (e['testGlobs']);
      for (let j = 0; j < testGlobs.length; j++) {
        if (typeof testGlobs[j] !== 'string') {
          return { ok: false, error: `personas[${i}].testGlobs[${j}] must be a string` };
        }
      }
    }
    // E13-2 optional instructionFile: must be a string or explicit null when present.
    if (e['instructionFile'] !== undefined) {
      const inst = e['instructionFile'];
      if (inst !== null && typeof inst !== 'string') {
        return { ok: false, error: `personas[${i}].instructionFile must be a string or null when present` };
      }
      if (typeof inst === 'string' && inst.trim() === '') {
        return { ok: false, error: `personas[${i}].instructionFile must not be an empty string` };
      }
    }
    // B9 optional provenance markers (producer-stamped). Validated only when
    // present so single-root and pre-B9 configs are unaffected; unknown extra
    // keys keep passing through untouched.
    if (e['source'] !== undefined && e['source'] !== 'repo' && e['source'] !== 'fallback') {
      return { ok: false, error: `personas[${i}].source must be 'repo' or 'fallback' when present` };
    }
    if (e['synthesized'] !== undefined && typeof e['synthesized'] !== 'boolean') {
      return { ok: false, error: `personas[${i}].synthesized must be a boolean when present` };
    }
  }

  // B7: in multi-root mode persona names are dispatch keys — duplicates make
  // routing ambiguous. Checked after the per-entry loop so every entry already
  // has a valid `repo` field by this point.
  if (isMultiRoot) {
    /** @type {Map<string, string>} */
    const seen = new Map(); // persona name → repo name
    for (const entry of personasArr) {
      const e = /** @type {Record<string, unknown>} */ (entry);
      const name = /** @type {string} */ (e['persona']);
      const repo = /** @type {string} */ (e['repo']);
      if (seen.has(name)) {
        return {
          ok: false,
          error: formatDuplicatePersonaError(name, /** @type {string} */ (seen.get(name)), repo),
        };
      }
      seen.set(name, repo);
    }

    // The schema's multi-root allOf has always required `primary`/`repos`;
    // enforce it here too so the hand validator matches the contract. Placed
    // AFTER the persona/dup-persona checks so no pre-existing fixture or
    // inline test changes its failure reason. `primary ∈ repos` is only a
    // warning — the producer owns that invariant and a drifted merge should
    // nudge, not brick the session.
    if (typeof obj['primary'] !== 'string' || String(obj['primary']).trim() === '') {
      return { ok: false, error: 'devmate.config.json primary must be a non-empty string in multi-root mode' };
    }
    if (!Array.isArray(obj['repos']) || /** @type {unknown[]} */ (obj['repos']).length === 0) {
      return { ok: false, error: 'devmate.config.json repos must be a non-empty array of strings in multi-root mode' };
    }
    const reposArr = /** @type {unknown[]} */ (obj['repos']);
    for (let i = 0; i < reposArr.length; i++) {
      if (typeof reposArr[i] !== 'string') {
        return { ok: false, error: `devmate.config.json repos[${i}] must be a string` };
      }
    }
    if (!reposArr.includes(obj['primary'])) {
      warnings.push(
        `[devmate] WARNING: primary '${obj['primary']}' is not listed in repos — ` +
          `the merged config looks drifted; run "Re-sync devmate" in monoroot to rebuild it`,
      );
    }
  }

  // DN-1: optional business-domain ownership map. Absent = no domains
  // declared — today's behavior, completely unaffected. Malformed entries
  // fail closed (never half-load); normalization (contextFile -> null,
  // relatedDomains/entryPoints -> []) happens after validation succeeds,
  // just before return.
  if (obj['domains'] !== undefined) {
    if (!Array.isArray(obj['domains'])) {
      return { ok: false, error: 'devmate.config.json domains must be an array when present' };
    }
    const domainsArr = /** @type {unknown[]} */ (obj['domains']);
    /** @type {Set<string>} */
    const seenDomainIds = new Set();
    for (let i = 0; i < domainsArr.length; i++) {
      const entry = domainsArr[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, error: `domains[${i}] must be an object` };
      }
      const d = /** @type {Record<string, unknown>} */ (entry);
      for (const key of Object.keys(d)) {
        if (!DOMAIN_ENTRY_KEYS.has(key)) {
          return { ok: false, error: `domains[${i}] has unknown key '${key}'` };
        }
      }
      if (typeof d['domain'] !== 'string' || String(d['domain']).trim() === '') {
        return { ok: false, error: `domains[${i}].domain must be a non-empty string` };
      }
      const domainId = /** @type {string} */ (d['domain']);
      if (seenDomainIds.has(domainId)) {
        return { ok: false, error: `devmate.config.json domains contains duplicate domain id '${domainId}'` };
      }
      seenDomainIds.add(domainId);

      const keywordsError = findStringListFieldError(d['keywords'], `domains[${domainId}].keywords`);
      if (keywordsError) return { ok: false, error: keywordsError };

      const globsError = findStringListFieldError(d['globs'], `domains[${domainId}].globs`);
      if (globsError) return { ok: false, error: globsError };

      if (d['contextFile'] !== undefined && d['contextFile'] !== null && typeof d['contextFile'] !== 'string') {
        return { ok: false, error: `domains[${domainId}].contextFile must be a string or null when present` };
      }
      if (d['relatedDomains'] !== undefined) {
        const relatedError = findStringListFieldError(d['relatedDomains'], `domains[${domainId}].relatedDomains`);
        if (relatedError) return { ok: false, error: relatedError };
      }
      if (d['entryPoints'] !== undefined) {
        const entryError = findStringListFieldError(d['entryPoints'], `domains[${domainId}].entryPoints`);
        if (entryError) return { ok: false, error: entryError };
      }
    }
  }

  // The TDD gate is driven by the resolved unit-test command: a verification
  // check with category 'unit-test' (canonical) or the deprecated legacy
  // verification.unitTest key. Warn when neither is configured.
  const unitTestCommand = resolveUnitTestCommand(
    /** @type {DevmateConfig} */ ({ verification: /** @type {any} */ (obj['verification']) }),
  );
  if (unitTestCommand === null) {
    warnings.push(
      '[devmate] WARNING: no unit-test verification check set in .devmate/devmate.config.json ' +
        "(add a verification.checks[] entry with category 'unit-test', or the legacy verification.unitTest) — TDD gate disabled",
    );
  }

  // Normalize domains (missing optionals -> []/null) into a shallow copy so
  // the raw parsed object is never mutated. When `domains` is absent the
  // returned config is the exact same `raw` reference — byte-for-byte
  // identical to today's behavior.
  /** @type {unknown} */
  let normalized = raw;
  if (Array.isArray(obj['domains'])) {
    const domainsArr = /** @type {Record<string, unknown>[]} */ (obj['domains']);
    const normalizedDomains = domainsArr.map((d) => ({
      domain: d['domain'],
      keywords: d['keywords'],
      globs: d['globs'],
      contextFile: d['contextFile'] ?? null,
      relatedDomains: d['relatedDomains'] ?? [],
      entryPoints: d['entryPoints'] ?? [],
    }));
    normalized = { ...obj, domains: normalizedDomains };
  }

  return { ok: true, config: /** @type {DevmateConfig} */ (normalized), warnings };
}

/**
 * B2: Resolve each persona's `repo` into an absolute `repoPath` for a
 * multi-root config. Returns a shallow copy — the input is never mutated. All
 * other top-level and per-persona fields are preserved verbatim.
 *
 * @param {DevmateConfig} config    A validated config with mode === 'multi-root'.
 * @param {string}        repoRoot  Absolute path the persona repos are anchored against.
 * @returns {DevmateConfig}
 */
function resolveMultiRootConfig(config, repoRoot) {
  return {
    ...config,
    personas: config.personas.map((persona) => ({
      ...persona,
      repoPath: resolve(repoRoot, /** @type {string} */ (persona.repo)),
    })),
  };
}

/**
 * Load and validate devmate.config.json from the given path.
 * Returns { ok: false, error } when the file is missing, unreadable, or invalid.
 *
 * When the parsed config declares `mode: "multi-root"`, each persona is
 * augmented with an absolute `repoPath` = resolve(repoRoot, persona.repo).
 * Single-root loading is completely unchanged.
 *
 * @param {string} [configPath]  Defaults to CONFIG_PATH.
 * @param {string} [repoRoot]    Root the multi-root persona repos are anchored
 *                               against. Defaults to the directory containing
 *                               the `.devmate/` folder (dirname twice from
 *                               configPath). Ignored in single-root mode.
 * @returns {ConfigResult}
 */
export function loadDevmateConfig(configPath, repoRoot) {
  const path = configPath ?? CONFIG_PATH;
  let raw;
  try {
    raw = readTextFileSync(path);
  } catch (/** @type {unknown} */ _err) {
    return { ok: false, error: `Config file not found: ${path}. Run \`devmate init\` to create it.` };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Malformed JSON in ${path}: ${msg}` };
  }
  const result = validateDevmateConfig(parsed);
  if (!result.ok || result.config.mode !== 'multi-root') {
    return result;
  }
  // Multi-root: anchor persona repos against repoRoot. When not supplied,
  // derive it from configPath, which points at <repoRoot>/.devmate/<file>.
  const root = repoRoot ?? dirname(dirname(resolve(path)));
  return { ...result, config: resolveMultiRootConfig(result.config, root) };
}
