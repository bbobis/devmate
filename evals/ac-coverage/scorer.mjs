// @ts-check
/**
 * AC-6 (epic #416): pure scorer for the deterministic AC-coverage eval suite.
 *
 * The suite measures whether the AC-1 coverage read (`computeAcCoverage`,
 * `lib/spec-progress.mjs`) and the AC-2 gate (`checkGatePrecondition` at
 * `pr-ready`, `lib/gate-preconditions.mjs`) reach the CORRECT verdict on a
 * battery of known loss/gate scenarios. This module is the pure comparison
 * core: given a scenario's EXPECTED verdict (declared in the fixture from first
 * principles — what the harness *should* do) and the OBSERVED verdict (produced
 * by running the real harness against a materialized fixture — see
 * scripts/run-ac-coverage-evals.mjs), it decides whether the harness behaved
 * correctly. No I/O, no clock — safe to assert on directly (the eval-of-the-eval).
 */

/** A gate's decision on a transition. @typedef {'allow'|'refuse'} GateDecision */

/**
 * The per-scenario verdict, in two forms: EXPECTED (fixture-declared) and
 * OBSERVED (harness-produced). Both carry the same fields so scoring reduces to
 * a field-by-field comparison.
 * @typedef {Object} CoverageVerdict
 * @property {number} total        ACs parsed from spec.md (unique ids).
 * @property {number} completed    ACs with a recorded impl-AC{n} completion.
 * @property {boolean} coverageOk  Raw `computeAcCoverage(...).ok` (vacuously true when total is 0).
 * @property {GateDecision} off    pr-ready decision under acCoverageGate=off.
 * @property {GateDecision} warn   pr-ready decision under acCoverageGate=warn.
 * @property {GateDecision} block  pr-ready decision under acCoverageGate=block.
 * @property {number} warnViolations  ac-coverage contract_violation events warn mode recorded.
 */

/**
 * @typedef {Object} ScenarioScore
 * @property {string} id
 * @property {boolean} ok            True when observed matches expected on every field.
 * @property {string[]} mismatches   `field: expected X, observed Y` lines; empty when ok.
 */

/**
 * A scored scenario: its declared category, the observed verdict, and the score.
 * `category` classifies what the fixture represents so the report can measure
 * detection over the scenarios that are actual misses.
 * @typedef {Object} ScenarioResult
 * @property {string} id
 * @property {string} lane
 * @property {'correct'|'miss'|'known-limitation'} category
 * @property {CoverageVerdict} observed
 * @property {ScenarioScore} score
 * @property {string|null} note
 */

/**
 * The aggregate coverage report. Deterministic: the run timestamp is added by
 * the entrypoint when it writes the artifact, never here, so the eval-of-the-eval
 * can assert on `buildCoverageReport` output byte-for-byte across runs.
 * @typedef {Object} CoverageReport
 * @property {number} schemaVersion
 * @property {boolean} passed          Every scenario matched its expected verdict.
 * @property {number} scenarioCount
 * @property {string[]} failed         Ids whose observed verdict diverged from expected.
 * @property {string[]} knownLimitations  Miss ids Phase 1 cannot catch (documented, not silently passed).
 * @property {number} missCount        Scenarios categorized as a real miss Phase 1 targets.
 * @property {number} blockDetected    Of those misses, how many block mode refused.
 * @property {number} offDetected      Of those misses, how many off mode refused (the pre-gate baseline).
 * @property {number} detectionRate    blockDetected / missCount (1 when missCount is 0).
 * @property {ScenarioResult[]} scenarios
 */

/** Fields compared verbatim between expected and observed. @type {ReadonlyArray<keyof CoverageVerdict>} */
export const COMPARED_FIELDS = ['total', 'completed', 'coverageOk', 'off', 'warn', 'block', 'warnViolations'];

/**
 * Grade one scenario by comparing every field of the observed verdict to the
 * expected verdict. A single divergence fails the scenario and is reported so
 * the failure names the exact field that drifted.
 * @param {string} id
 * @param {CoverageVerdict} expected
 * @param {CoverageVerdict} observed
 * @returns {ScenarioScore}
 */
export function scoreScenario(id, expected, observed) {
  // Explicit field pairs (not dynamic `obj[field]` indexing) keep the
  // comparison prototype-pollution-safe; COMPARED_FIELDS documents the same set
  // and the eval-of-the-eval pins the two together.
  /** @type {Array<[string, unknown, unknown]>} */
  const pairs = [
    ['total', expected.total, observed.total],
    ['completed', expected.completed, observed.completed],
    ['coverageOk', expected.coverageOk, observed.coverageOk],
    ['off', expected.off, observed.off],
    ['warn', expected.warn, observed.warn],
    ['block', expected.block, observed.block],
    ['warnViolations', expected.warnViolations, observed.warnViolations],
  ];
  /** @type {string[]} */
  const mismatches = [];
  for (const [field, exp, obs] of pairs) {
    if (exp !== obs) {
      mismatches.push(`${field}: expected ${JSON.stringify(exp)}, observed ${JSON.stringify(obs)}`);
    }
  }
  return { id, ok: mismatches.length === 0, mismatches };
}

/**
 * Aggregate scored scenarios into the coverage report. Pure — no clock, no I/O.
 * `detectionRate` is the headline metric that replaces the RCA's unmeasured
 * "~20% of ACs missed": among the scenarios that are real, Phase-1-targetable
 * misses, the fraction the block-mode gate actually refuses. `offDetected`
 * captures the pre-gate baseline (off mode never refuses, so it is 0), making
 * the before/after effect of the gate measurable across runs.
 * @param {ScenarioResult[]} results
 * @returns {CoverageReport}
 */
export function buildCoverageReport(results) {
  const failed = results.filter((r) => !r.score.ok).map((r) => r.id);
  const knownLimitations = results.filter((r) => r.category === 'known-limitation').map((r) => r.id);
  const misses = results.filter((r) => r.category === 'miss');
  const blockDetected = misses.filter((r) => r.observed.block === 'refuse').length;
  const offDetected = misses.filter((r) => r.observed.off === 'refuse').length;
  const detectionRate = misses.length === 0 ? 1 : blockDetected / misses.length;
  return {
    schemaVersion: 1,
    passed: failed.length === 0,
    scenarioCount: results.length,
    failed,
    knownLimitations,
    missCount: misses.length,
    blockDetected,
    offDetected,
    detectionRate,
    scenarios: results,
  };
}
