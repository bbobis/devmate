// @ts-check
/**
 * E16-4: pure scorer for the planner component eval. No I/O, no clock, no LLM
 * call — it grades a CAPTURED `plan.json` artifact against a rubric fixture so a
 * planner regression is attributable to this specialist alone (Huyen, AI
 * Engineering ch4, step 1). Mirrors the pure-scorer + committed-baseline split of
 * evals/gate-robustness and evals/ac-coverage.
 *
 * The plan artifact is `{ tasks: PlannerTask[], assumptions, openRisks,
 * unverified }` (lib/workflow/agents/planner.mjs). A `PlannerTask` is
 * `{ description, ac: string[], tddApproach: string, persona, files }`. There is
 * no per-AC test object; the mapping is per-task — so an acceptance criterion is
 * MAPPED when it appears in some task's `ac[]` AND that task carries a non-empty
 * `tddApproach` (a plan that lists an AC but plans no test for its task has not
 * mapped it). score = fraction of required ACs mapped; missing = the unmapped
 * ones; spurious = ACs a task claims that the rubric does not require.
 *
 * Note: on a plan.json that passed `validatePlannerArtifact` every task already
 * carries a non-empty `tddApproach`, so on validated captures the mapping clause
 * reduces to AC coverage (does each required AC appear in some task?). The clause
 * still discriminates on UN-validated / degraded captures — the case this eval
 * exists to catch — where a specialist emitted a task with no test approach. A
 * richer per-AC→test mapping would need a richer plan artifact shape (follow-up).
 */

/**
 * @typedef {Object} PlannerRubric
 * @property {string[]} requiredAcs        Acceptance criteria that must be mapped to a planned test.
 * @property {number} [passThreshold]      Suite gate; not read by the scorer.
 * @property {number} [expectedGoodScore]  Suite regression pin; not read by the scorer.
 */

/**
 * Normalize an AC string for comparison (trim surrounding whitespace; ACs are
 * otherwise declared verbatim in both the plan and the rubric).
 * @param {unknown} ac
 * @returns {string}
 */
function normAc(ac) {
  return typeof ac === 'string' ? ac.trim() : '';
}

/**
 * Round to 4dp — repo house style; keeps float noise from flapping the CI gate.
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Score a plan artifact against its rubric.
 * @param {{ tasks?: Array<{ ac?: string[], tddApproach?: string }> }} output  Parsed plan.json.
 * @param {PlannerRubric} rubric
 * @returns {{ score: number, missing: string[], spurious: string[] }}
 */
export function scoreComponent(output, rubric) {
  const tasks = Array.isArray(output && output.tasks) ? output.tasks : [];
  const required = (Array.isArray(rubric && rubric.requiredAcs) ? rubric.requiredAcs : [])
    .map(normAc)
    .filter((a) => a !== '');
  const requiredSet = new Set(required);

  // An AC is mapped iff a task both lists it and plans a test (non-empty tddApproach).
  /** @type {Set<string>} */
  const mapped = new Set();
  /** @type {Set<string>} */
  const claimed = new Set();
  for (const task of tasks) {
    const acs = Array.isArray(task && task.ac) ? task.ac.map(normAc).filter((a) => a !== '') : [];
    const hasTest = typeof (task && task.tddApproach) === 'string' && task.tddApproach.trim() !== '';
    for (const ac of acs) {
      claimed.add(ac);
      if (hasTest) mapped.add(ac);
    }
  }

  const missing = required.filter((ac) => !mapped.has(ac));
  const spurious = [...claimed].filter((ac) => !requiredSet.has(ac));
  const score = required.length === 0 ? 1 : round4((required.length - missing.length) / required.length);
  return { score, missing, spurious };
}
