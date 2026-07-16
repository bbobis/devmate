// @ts-check
// Pure inference: turn grounded verification candidates (from
// scan-verification-signals.mjs) into the deterministic `checks[]` floor.
// Same candidates ⇒ identical checks. No I/O, no clock, no rng.
//
// Promotion policy for the floor: keep only candidates classified into a
// recognized verification category (drops 'unknown' script/target names like
// `deploy`/`clean`), dedupe by normalized command (highest-confidence source
// wins — candidates arrive pre-sorted), assign stable kebab ids, cap the count.
// Everything scanned (including the dropped candidates) still lives in the
// evidence artifact for the LLM enrichment stage / human to reconsider.

/** @typedef {import('../types.mjs').VerificationCandidate} VerificationCandidate */
/** @typedef {import('../types.mjs').VerificationCheck} VerificationCheck */

/** Upper bound on floor checks, so a script-heavy repo can't produce a wall. */
export const MAX_INFERRED_CHECKS = 12;

/**
 * Normalize a command for dedup: trim and collapse internal whitespace.
 * @param {string} command
 * @returns {string}
 */
function normalizeCommand(command) {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * Build the deterministic verification-check floor from scanned candidates.
 * @param {VerificationCandidate[]} candidates  Deterministically sorted (confidence desc).
 * @returns {VerificationCheck[]}
 */
export function inferVerificationChecks(candidates) {
  /** @type {Set<string>} */
  const seenCommands = new Set();
  /** @type {Map<string, number>} */
  const idCounts = new Map();
  /** @type {VerificationCheck[]} */
  const checks = [];

  for (const candidate of candidates) {
    if (checks.length >= MAX_INFERRED_CHECKS) break;
    if (candidate.category === 'unknown') continue;
    const command = normalizeCommand(candidate.command);
    if (command === '' || seenCommands.has(command)) continue;
    seenCommands.add(command);

    const baseId = candidate.category;
    const n = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, n);
    const id = n === 1 ? baseId : `${baseId}-${n}`;

    checks.push({ id, command, category: candidate.category, source: candidate.source });
  }

  return checks;
}
