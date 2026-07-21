// @ts-check
/**
 * Issue 238: pure scorer for the planner-alignment component eval. No I/O, no
 * clock, no LLM — it grades a CAPTURED `plan.json` artifact's per-task
 * `alignment` decisions against a rubric, in isolation from the lane, so a
 * planner alignment regression is attributable to this specialist alone.
 * Mirrors the pure-scorer + committed-baseline split of the E16-4 planner eval.
 *
 * A `PlannerTask` carries `alignment: AlignmentDecision[]`
 * (lib/workflow/agents/planner.mjs). A capability is SATISFIED when some task
 * lists it in a decision that carries the evidence its kind requires (§3.2 of
 * the alignment contract): reuse -> target + usageEvidence; extend -> target +
 * patternRefs; add -> patternRefs; and a non-empty reason in every case.
 * score = fraction of required capabilities satisfied; missing = the unsatisfied
 * ones; spurious = capabilities a task claims that the rubric does not require.
 *
 * This grades a signal `validatePlannerArtifact` does not by itself pin to a
 * rubric: that the plan actually addressed the capabilities the task needed,
 * with real reuse/pattern evidence — not merely that SOME alignment array was
 * present. A degraded capture (an add decision with no patternRefs) fails here.
 */

/**
 * @typedef {Object} AlignmentRubric
 * @property {string[]} requiredCapabilities  Capabilities the plan must address with a well-formed decision.
 * @property {number} [passThreshold]         Suite gate; not read by the scorer.
 * @property {number} [expectedGoodScore]     Suite regression pin; not read by the scorer.
 */

/**
 * Normalize a string for comparison (trim; capabilities are declared verbatim
 * in both the plan and the rubric).
 * @param {unknown} value
 * @returns {string}
 */
function norm(value) {
  return typeof value === 'string' ? value.trim() : '';
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
 * True when `value` is a non-empty array of non-empty strings.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((e) => norm(e) !== '');
}

/**
 * True when `target` is an object with non-empty `symbol` and `path`.
 * @param {unknown} target
 * @returns {boolean}
 */
function hasTarget(target) {
  if (target === null || typeof target !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (target);
  return norm(record.symbol) !== '' && norm(record.path) !== '';
}

/**
 * A decision is satisfied when it carries the evidence its kind requires.
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
function decisionSatisfied(entry) {
  if (norm(entry.reason) === '') return false;
  switch (entry.decision) {
    case 'reuse':
      return hasTarget(entry.target) && isNonEmptyStringArray(entry.usageEvidence);
    case 'extend':
      return hasTarget(entry.target) && isNonEmptyStringArray(entry.patternRefs);
    case 'add':
      return isNonEmptyStringArray(entry.patternRefs);
    default:
      return false;
  }
}

/**
 * Score a plan artifact's alignment against its rubric.
 * @bounded-alloc — one Set entry per capability across a single plan.json's
 * already-parsed tasks/alignment arrays; no unbounded growth.
 * @param {{ tasks?: Array<{ alignment?: unknown[] }> }} output  Parsed plan.json.
 * @param {AlignmentRubric} rubric
 * @returns {{ score: number, missing: string[], spurious: string[] }}
 */
export function scoreComponent(output, rubric) {
  const tasks = Array.isArray(output && output.tasks) ? output.tasks : [];
  const required = (Array.isArray(rubric && rubric.requiredCapabilities) ? rubric.requiredCapabilities : [])
    .map(norm)
    .filter((c) => c !== '');
  const requiredSet = new Set(required);

  /** @type {Set<string>} */
  const satisfied = new Set();
  /** @type {Set<string>} */
  const claimed = new Set();
  for (const task of tasks) {
    const alignment = Array.isArray(task && task.alignment) ? task.alignment : [];
    for (const raw of alignment) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = /** @type {Record<string, unknown>} */ (raw);
      const capability = norm(entry.capability);
      if (capability === '') continue;
      claimed.add(capability);
      if (decisionSatisfied(entry)) satisfied.add(capability);
    }
  }

  const missing = required.filter((c) => !satisfied.has(c));
  const spurious = [...claimed].filter((c) => !requiredSet.has(c));
  const score = required.length === 0 ? 1 : round4((required.length - missing.length) / required.length);
  return { score, missing, spurious };
}
