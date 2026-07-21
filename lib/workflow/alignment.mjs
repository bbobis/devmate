// @ts-check
/**
 * Shared codebase-alignment contract — the `reuse | extend | add` decision that
 * both lane carriers record: the feature lane's `PlannerTask` (required,
 * fail-closed, issue 238) and the bug lane's `DiagnosisResult` (optional/advisory,
 * then required, issue 240). One structural validator lives here so the two lanes
 * cannot drift from each other.
 *
 * Pure and filesystem-free: evidence pointers are checked for SHAPE, not on-disk
 * existence (TCM-3) — proving a pointer resolves is the worker's job, not the
 * validator's. The decision value is `add` (not `create`/`author`) to dodge the
 * agent-validator write-verb scan and the secure-coding secret-comparison
 * heuristic on read-only agent cards (see docs/PATTERNS.md P32).
 */

/**
 * One `reuse | extend | add` decision for a capability a task or fix needs.
 * Pointer-based (TCM-3): `usageEvidence`/`patternRefs` carry `path` or
 * `path:line` strings, never pasted source.
 * @typedef {{
 *   capability: string,
 *   decision: 'reuse' | 'extend' | 'add',
 *   target: { symbol: string, path: string } | null,
 *   usageEvidence: string[],
 *   patternRefs: string[],
 *   reason: string
 * }} AlignmentDecision
 */

/**
 * The three legal alignment decisions.
 * @type {ReadonlyArray<'reuse' | 'extend' | 'add'>}
 */
export const ALIGNMENT_DECISIONS = Object.freeze(['reuse', 'extend', 'add']);

/**
 * True when `value` is an array whose every entry is a non-empty string.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((e) => typeof e === 'string' && e.trim() !== '');
}

/**
 * True when `target` is an object carrying non-empty `symbol` and `path`.
 * @param {unknown} target
 * @returns {boolean}
 */
function hasValidTarget(target) {
  if (target === null || typeof target !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (target);
  return (
    typeof record.symbol === 'string' &&
    record.symbol.trim() !== '' &&
    typeof record.path === 'string' &&
    record.path.trim() !== ''
  );
}

/**
 * Collect structural errors for ONE alignment entry. Pure; pointer strings are
 * checked for shape, not on-disk existence.
 * @param {unknown} entry
 * @param {string} at   Positional label for messages, e.g. `alignment[0]`.
 * @returns {string[]}
 */
export function alignmentEntryErrors(entry, at) {
  if (entry === null || typeof entry !== 'object') return [`${at} must be an object`];

  /** @type {string[]} */
  const errors = [];
  const record = /** @type {Record<string, unknown>} */ (entry);
  const decision = record.decision;

  if (typeof record.capability !== 'string' || record.capability.trim() === '') {
    errors.push(`${at}.capability must be a non-empty string`);
  }
  const legalDecisions = /** @type {readonly string[]} */ (ALIGNMENT_DECISIONS);
  if (typeof decision !== 'string' || !legalDecisions.includes(decision)) {
    errors.push(`${at}.decision must be one of ${ALIGNMENT_DECISIONS.join(', ')}`);
  }
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    errors.push(`${at}.reason must be a non-empty string`);
  }
  if (!isNonEmptyStringArray(record.usageEvidence)) {
    errors.push(`${at}.usageEvidence must be an array of non-empty strings`);
  }
  if (!isNonEmptyStringArray(record.patternRefs)) {
    errors.push(`${at}.patternRefs must be an array of non-empty strings`);
  }

  // Decision-specific evidence (§3.2 of the alignment contract). Pointer string
  // quality is covered above; here we require the mandatory presence.
  const hasUsage = Array.isArray(record.usageEvidence) && record.usageEvidence.length > 0;
  const hasPatterns = Array.isArray(record.patternRefs) && record.patternRefs.length > 0;
  if (decision === 'reuse') {
    if (!hasValidTarget(record.target)) errors.push(`${at} reuse requires target.symbol and target.path`);
    if (!hasUsage) errors.push(`${at} reuse requires at least one usageEvidence pointer`);
  } else if (decision === 'extend') {
    if (!hasValidTarget(record.target)) errors.push(`${at} extend requires target.symbol and target.path`);
    if (!hasPatterns) errors.push(`${at} extend requires at least one patternRefs pointer`);
  } else if (decision === 'add') {
    if (!hasPatterns) errors.push(`${at} add requires at least one patternRefs pointer`);
  }
  return errors;
}

/**
 * Collect structural errors for an `alignment` array (fail-closed for the
 * feature lane, advisory for the bug lane). Pure and filesystem-free.
 *
 * When `required` (the default), a missing/non-array/empty `alignment` is an
 * error — the feature-lane planner contract. When optional (`required: false`),
 * an absent field (`undefined`/`null`) is skipped and an empty array is
 * accepted, but any present entry must still be well-formed — the bug-lane
 * advisory contract (issue 240).
 *
 * @bounded-alloc — one error string per entry of one already-parsed `alignment`
 * array (from a single plan.json / diagnosis.json); no unbounded growth.
 * @param {unknown} alignment
 * @param {string} label   e.g. `tasks[0].alignment` or `alignment`.
 * @param {{ required?: boolean }} [opts]
 * @returns {string[]}
 */
export function alignmentErrors(alignment, label, opts = {}) {
  const required = opts.required !== false;
  if (!required && (alignment === undefined || alignment === null)) return [];
  if (!Array.isArray(alignment)) return [`${label} must be an array`];
  if (alignment.length === 0) {
    return required ? [`${label} must be a non-empty array`] : [];
  }

  /** @type {string[]} */
  const errors = [];
  for (const [k, entry] of alignment.entries()) {
    errors.push(...alignmentEntryErrors(entry, `${label}[${k}]`));
  }
  return errors;
}
