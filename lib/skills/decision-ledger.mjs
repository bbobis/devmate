// @ts-check
/**
 * Skill-matching decision ledger.
 *
 * Every skill-match decision — the FULL scored candidate list (including
 * negatively-triggered and below-threshold candidates), the selected subset,
 * the operating point, and the workflow context — is appended here so the
 * matcher stops being triple-blind. The prior telemetry logged only zero-result
 * misses, stripped negatively-triggered candidates before logging, and wrote
 * via an un-awaited fire-and-forget. This ledger fixes all three: it records
 * wrong-winner and below-floor-correct outcomes as first-class data, and it
 * carries the `manifestsLoaded` / `skillsDir` canary that makes the loader path
 * bug visible (manifestsLoaded: 0 on a deployment that resolved an empty skills
 * directory).
 *
 * Reuses the E3-1 locked-append primitive and mirrors recordWorkerTelemetry:
 * awaited, exclusive-locked, and append-only (autoCompact disabled) so a
 * concurrent write never interleaves and the miner (E14-2) never finds a
 * silently-truncated tail.
 */

import { dirname } from 'node:path';
import { ensureDir } from '../fs-safe.mjs';
import { appendJsonl } from '../memory/append-jsonl.mjs';
import { readJsonl } from '../json-io.mjs';

/** @typedef {import('../types.mjs').MatchResult} MatchResult */
/** @typedef {import('../types.mjs').SkillDecision} SkillDecision */

/**
 * Append one skill-match decision under exclusive lock. Creates the parent
 * directory if absent. Append-only: auto-compaction is disabled so the ledger
 * is never truncated out from under the telemetry miner.
 *
 * @param {Omit<SkillDecision, 'timestamp'>} decision  The decision, minus its timestamp.
 * @param {{ ledgerPath: string }} opts  Absolute ledger path (under the consumer's .devmate/state/).
 * @returns {Promise<void>}
 */
export async function recordSkillDecision(decision, opts) {
  const { ledgerPath } = opts;
  await ensureDir(dirname(ledgerPath));

  /** @type {SkillDecision} */
  const entry = {
    timestamp: new Date().toISOString(),
    query: decision.query,
    manifestsLoaded: decision.manifestsLoaded,
    skillsDir: decision.skillsDir,
    sources: decision.sources,
    scored: decision.scored,
    selected: decision.selected,
    topN: decision.topN,
    minConfidence: decision.minConfidence,
    lane: decision.lane,
    gate: decision.gate,
    intent: decision.intent,
  };

  await appendJsonl(ledgerPath, entry, { autoCompact: false });
}

/**
 * Read every skill-match decision from a ledger. Single-reader for the eval
 * suite and the nightly telemetry miner. Returns [] when the ledger does not
 * yet exist; malformed lines surface as a parse error (never silently dropped).
 *
 * @param {string} ledgerPath
 * @returns {Promise<SkillDecision[]>}
 */
export async function readSkillDecisions(ledgerPath) {
  try {
    const rows = await readJsonl(ledgerPath);
    return /** @type {SkillDecision[]} */ (rows);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}
