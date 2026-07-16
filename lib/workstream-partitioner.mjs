// @ts-check
import { listDependencyGates } from "./dependency-gates.mjs";
import { matchGlob } from "./gate-guard-core.mjs";

export { matchGlob } from "./gate-guard-core.mjs";

/** @typedef {import('./types.mjs').PersonaEntry} PersonaEntry */
/** @typedef {import('./types.mjs').WorkstreamPartition} WorkstreamPartition */
/** @typedef {import('./types.mjs').DispatchMode} DispatchMode */
/** @typedef {import('./types.mjs').JoinCondition} JoinCondition */

/**
 * E10-06: hard ceiling on concurrently dispatched workstreams. `large`-class
 * decomposition proposes at most this many parallel workstreams so fan-out is
 * never unbounded. The value matches the sub-agent budget guard's default
 * concurrency cap (hooks/subagent-budget-guard.mjs) — the guard remains the
 * runtime hard ceiling; this constant bounds what the orchestrator proposes.
 * @type {number}
 */
// TODO: calibrate via the "Calibrating the ceilings" decision rule in
// docs/parallel-dispatch.md (FO-8, issue #17): change this value only with a
// fanout-report snapshot that satisfies the rule, recorded in the CHANGELOG.
export const MAX_PARALLEL_WORKSTREAMS = 3;

/**
 * Options for {@link partitionWorkstreams}.
 * @typedef {Object} PartitionOptions
 * @property {number} [maxParallel]  Ceiling on concurrently dispatched
 *   workstreams (integer >= 1). Defaults to {@link MAX_PARALLEL_WORKSTREAMS}.
 *   A ceiling below 2 collapses `parallel` mode to sequential dispatch.
 */

/**
 * Resolve the effective parallelism ceiling from partition options.
 * An explicitly supplied ceiling must be an integer >= 1 — anything else is a
 * caller contract violation and throws (matching the module family's
 * throw-on-contract-violation style).
 * @param {PartitionOptions} [opts]
 * @returns {number}
 */
export function resolveMaxParallel(opts) {
  const maxParallel = opts?.maxParallel;
  if (maxParallel === undefined) return MAX_PARALLEL_WORKSTREAMS;
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(
      `partitionWorkstreams: maxParallel must be an integer >= 1, got ${JSON.stringify(maxParallel)}`,
    );
  }
  return maxParallel;
}

/**
 * Match a file against a persona's editableGlobs (taking offLimitsGlobs into account).
 * Returns true only when the file is editable AND not off-limits for this persona.
 * @param {PersonaEntry} persona
 * @param {string} filePath
 * @returns {boolean}
 */
function matchesPersona(persona, filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const editable = persona.editableGlobs.some((g) => matchGlob(g, normalized));
  if (!editable) return false;
  const offLimits = (persona.offLimitsGlobs ?? []).some((g) =>
    matchGlob(g, normalized),
  );
  return !offLimits;
}

/**
 * Determine the dispatch mode given the three workstream buckets.
 *
 * Rules:
 *   - sharedFiles is non-empty                          -> sequential-shared-first
 *   - only backendFiles is non-empty                    -> sequential-backend-first
 *   - only frontendFiles is non-empty                   -> sequential-frontend-first
 *   - both backend and frontend non-empty, no shared    -> parallel
 *   - everything empty                                  -> sequential-shared-first (no-op)
 *
 * @param {{ backendFiles: string[], frontendFiles: string[], sharedFiles: string[] }} buckets
 * @returns {DispatchMode}
 */
export function determineDispatchMode(buckets) {
  const { backendFiles, frontendFiles, sharedFiles } = buckets;
  if (sharedFiles.length > 0) return "sequential-shared-first";
  if (backendFiles.length > 0 && frontendFiles.length > 0) return "parallel";
  if (backendFiles.length > 0) return "sequential-backend-first";
  if (frontendFiles.length > 0) return "sequential-frontend-first";
  return "sequential-shared-first";
}

/**
 * Classify spec files into backend, frontend, and shared buckets and return the
 * appropriate dispatch mode. A file that matches both personas' editableGlobs
 * (typically a shared contract such as `types.ts` or `openapi.yaml`) lands in
 * sharedFiles. A file that matches neither persona also lands in sharedFiles so
 * the orchestrator handles it explicitly rather than skipping it.
 *
 * E10-06: parallel dispatch is bounded by `opts.maxParallel` (default
 * {@link MAX_PARALLEL_WORKSTREAMS}). When the ceiling is below 2, `parallel`
 * mode is downgraded to `sequential-backend-first` (backend dispatches first,
 * then frontend) so a `large`-class decomposition can never exceed its bound.
 * Omitting `opts` preserves the pre-E10-06 behaviour exactly.
 *
 * @param {string[]} specFiles  Relative paths from the spec "Files that will change" section.
 * @param {PersonaEntry[]} personas  Persona entries from devmate.config.json.
 * @param {PartitionOptions} [opts]  Optional parallelism ceiling.
 * @returns {WorkstreamPartition}
 */
export function partitionWorkstreams(specFiles, personas, opts) {
  const maxParallel = resolveMaxParallel(opts);
  const backend = personas.find((p) => p.persona === "backend");
  const frontend = personas.find((p) => p.persona === "frontend");

  /** @type {string[]} */
  const backendFiles = [];
  /** @type {string[]} */
  const frontendFiles = [];
  /** @type {string[]} */
  const sharedFiles = [];

  for (const file of specFiles) {
    const inBackend = backend ? matchesPersona(backend, file) : false;
    const inFrontend = frontend ? matchesPersona(frontend, file) : false;

    if (inBackend && inFrontend) {
      sharedFiles.push(file);
    } else if (inBackend) {
      backendFiles.push(file);
    } else if (inFrontend) {
      frontendFiles.push(file);
    } else {
      sharedFiles.push(file);
    }
  }

  const mode = determineDispatchMode({
    backendFiles,
    frontendFiles,
    sharedFiles,
  });
  // A ceiling below 2 forbids concurrent dispatch: downgrade `parallel` to a
  // deterministic sequential order (backend first, then frontend).
  const boundedMode =
    mode === "parallel" && maxParallel < 2 ? "sequential-backend-first" : mode;
  return { backendFiles, frontendFiles, sharedFiles, mode: boundedMode };
}

/**
 * Check whether the parallel-dispatch join condition is satisfied.
 *
 * The join condition is met when BOTH `backend-unit-pass` AND
 * `frontend-unit-pass` dependency gates have status `pass`. Until both pass,
 * the orchestrator may not advance to E2E or integration testing.
 *
 * Reads from `.devmate/state/gates.json` (overridable via `statePath` for tests).
 * Never throws: a missing or unreadable gates file is treated as no gates passing.
 *
 * @param {string} [statePath]  Optional override for `.devmate/state/gates.json`.
 * @returns {Promise<JoinCondition>}
 */
export async function checkJoinCondition(statePath) {
  /** @type {Record<string, { status?: string }>} */
  let gates = {};
  try {
    gates = listDependencyGates(statePath);
  } catch (/** @type {unknown} */ _err) {
    gates = {};
  }
  const backendUnitPass = gates["backend-unit-pass"]?.status === "pass";
  const frontendUnitPass = gates["frontend-unit-pass"]?.status === "pass";
  return {
    backendUnitPass,
    frontendUnitPass,
    met: backendUnitPass && frontendUnitPass,
  };
}
