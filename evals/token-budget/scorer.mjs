// @ts-check
/**
 * E9-21: pure scorer for the token-budget eval. No I/O — the suite drives the
 * real budget/compaction/memory libraries over the deterministic fixtures and
 * passes the observed outcomes here. Mirrors the issue-quality scorer
 * structure: a pure function returning a typed result.
 */

/** @typedef {import('../../lib/types.mjs').TokenBudgetEvalResult} TokenBudgetEvalResult */
/** @typedef {import('../../lib/types.mjs').CompactionArtifact} CompactionArtifact */

/**
 * Observed outcomes of one synthetic trajectory run.
 * @typedef {Object} TokenBudgetObservations
 * @property {Array<{ type?: string }>} traceEvents        All trace events appended during the run.
 * @property {{ ok: boolean, missingFields: string[] }} resumeVerdict  canResumeFromCompaction output.
 * @property {number} estimatedTokens                       Estimated tokens of the post-compaction active context.
 * @property {number} classThresholdTokens                  The budget-class threshold to stay within.
 * @property {number} promotedFactCount                     Facts present in the repo ledger post-compaction.
 */

/**
 * Score a token-budget trajectory run: four invariants, each counted into the
 * final score.
 * @param {TokenBudgetObservations} obs
 * @returns {TokenBudgetEvalResult}
 */
export function scoreTokenBudget(obs) {
  const budgetEventsFired = obs.traceEvents.some((e) => e.type === 'budget_warning');
  const resumeSufficient = obs.resumeVerdict.ok === true;
  const activeContextBounded =
    Number.isFinite(obs.estimatedTokens) &&
    Number.isFinite(obs.classThresholdTokens) &&
    obs.estimatedTokens <= obs.classThresholdTokens;
  const ledgerPromoted = obs.promotedFactCount > 0;

  const score = [budgetEventsFired, resumeSufficient, activeContextBounded, ledgerPromoted].filter(
    Boolean
  ).length;

  return { budgetEventsFired, resumeSufficient, activeContextBounded, ledgerPromoted, score };
}
