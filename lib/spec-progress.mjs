// @ts-check

/**
 * Per-acceptance-criterion implementation progress: parse the `## Acceptance
 * criteria` section of `spec.md`, check off completed criteria, and summarize
 * how many are done from the canonical trace.
 *
 * This module is pure (no I/O, no clock). The trace remains the single source
 * of truth for completion: each completed AC is an `impl-AC{n}` `step_complete`
 * event (see `lib/trace/append.mjs`), and the `spec.md` checkboxes are a
 * rendered view synced from that truth. `TaskState.acceptanceCriteria` supplies
 * the stable id -> label map (index+1 is the id, equal to the `TC-00{n}` test
 * row assigned by the spec-writer).
 */

/** @typedef {import('./types.mjs').TraceStep} TraceStep */
/** @typedef {import('./types.mjs').ImplProgress} ImplProgress */

/**
 * @typedef {Object} AcceptanceCriterion
 * @property {number} id      1-based global acceptance-criterion index.
 * @property {string} stepId  Stable trace step id for this AC (`impl-AC{id}`).
 * @property {string} text    Criterion text (without the `AC{n}:` prefix).
 */

/** Prefix stamped on every per-AC trace `stepId`. */
export const AC_STEP_ID_PREFIX = "impl-AC";

/** Matches a per-AC trace `stepId` (`impl-AC{n}`), capturing the 1-based id. */
const AC_STEP_ID_RE = /^impl-AC(\d+)$/;

/**
 * Build the stable trace `stepId` for a 1-based acceptance-criterion id.
 * @param {number} id
 * @returns {string}
 */
export function acStepId(id) {
  return `${AC_STEP_ID_PREFIX}${id}`;
}

/** Heading that opens the acceptance-criteria section. */
const AC_HEADING_RE = /^##\s+Acceptance criteria\s*$/i;

/** Any level-2 heading — used to detect the end of the section. */
const SECTION_HEADING_RE = /^##\s+/;

/**
 * One acceptance-criterion checkbox line, split so the checkbox mark can be
 * swapped without disturbing the surrounding text. Mirrors the format written
 * by `lib/spec-writer.mjs`: `- [ ] AC1: <criterion>`.
 * Groups: 1 = `- [`, 2 = mark, 3 = `] AC`, 4 = digits, 5 = `: `, 6 = text.
 */
const AC_LINE_RE = /^(\s*-\s\[)([ xX])(\]\sAC)(\d+)(:\s?)(.*)$/;

/**
 * Parse the `## Acceptance criteria` section of a spec markdown document.
 * Returns criteria in document order; an empty array when the section is
 * absent or contains no `AC{n}:` checkbox lines.
 * @param {string} markdown
 * @returns {AcceptanceCriterion[]}
 */
export function parseAcceptanceCriteria(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return [];

  /** @type {AcceptanceCriterion[]} */
  const criteria = [];
  let inSection = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (!inSection) {
      if (AC_HEADING_RE.test(line.trim())) inSection = true;
      continue;
    }
    if (SECTION_HEADING_RE.test(line.trim())) break;

    const match = AC_LINE_RE.exec(line);
    if (!match) continue;
    const id = Number(match[4]);
    if (!Number.isInteger(id) || id < 1) continue;
    criteria.push({ id, stepId: acStepId(id), text: match[6].trim() });
  }

  return criteria;
}

/**
 * Return a copy of the spec markdown with the checkbox of every completed
 * acceptance criterion flipped to `- [x]`. Only ever checks — a criterion that
 * is not in `completedIds` is left exactly as-is (never unchecked), so the
 * function is idempotent and safe to re-run. Only lines inside the
 * `## Acceptance criteria` section are touched.
 * @param {string} markdown
 * @param {ReadonlySet<number>} completedIds  1-based ids known to be complete.
 * @returns {string}
 */
export function renderCheckedSpec(markdown, completedIds) {
  if (typeof markdown !== "string" || markdown.length === 0) return markdown;
  if (!completedIds || completedIds.size === 0) return markdown;

  const lines = markdown.split(/\r?\n/);
  let inSection = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inSection) {
      if (AC_HEADING_RE.test(line.trim())) inSection = true;
      continue;
    }
    if (SECTION_HEADING_RE.test(line.trim())) {
      inSection = false;
      continue;
    }

    const match = AC_LINE_RE.exec(line);
    if (!match) continue;
    const id = Number(match[4]);
    if (!completedIds.has(id)) continue;
    // Swap only the checkbox mark; preserve everything else verbatim.
    lines[i] = `${match[1]}x${match[3]}${match[4]}${match[5]}${match[6]}`;
  }

  return lines.join("\n");
}

/**
 * Extract the sorted, de-duplicated 1-based ids of completed acceptance
 * criteria from trace steps. A step counts only when it is `completed` and its
 * `stepId` matches `impl-AC{n}`.
 * @param {ReadonlyArray<TraceStep>} steps
 * @returns {number[]}
 */
export function completedAcNumbers(steps) {
  if (!Array.isArray(steps)) return [];
  /** @type {Set<number>} */
  const ids = new Set();
  for (const step of steps) {
    if (!step || step.completed !== true) continue;
    const m = AC_STEP_ID_RE.exec(step.stepId);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Smallest 1-based id in `[1..total]` that is not yet complete, or null when
 * every criterion is complete (or `total` is 0).
 * @param {ReadonlySet<number>} completedIds
 * @param {number} total
 * @returns {number|null}
 */
export function nextAcNumber(completedIds, total) {
  for (let n = 1; n <= total; n += 1) {
    if (!completedIds.has(n)) return n;
  }
  return null;
}

/**
 * Coverage of a spec's acceptance criteria against recorded completions.
 * @typedef {Object} AcCoverageResult
 * @property {boolean} ok            True when every parsed AC has a completion.
 * @property {number}  total         Count of ACs parsed from spec.md (unique ids).
 * @property {number}  completed     Count with a recorded impl-AC{n} step_complete event.
 * @property {number}  coveragePercent  Math.floor(completed / total * 100); 100 when total is 0.
 * @property {{ id: number, text: string }[]} missing  Parsed ACs with no completion, in id order.
 */

/**
 * Compute AC coverage from parsed criteria and the set of completed ids. Pure:
 * no I/O, no clock. Vacuously ok (100%) when `criteria` is empty — the caller
 * (script) applies any lane-specific fail-closed policy on top of this.
 *
 * Criteria are de-duplicated by id (first occurrence wins) and reported in id
 * order, so gapped or accidentally-repeated `AC{n}:` numbering never throws.
 * `completedIds` entries with no matching criterion id are ignored — they
 * cannot inflate coverage beyond what was actually parsed.
 * @param {ReadonlyArray<AcceptanceCriterion>} criteria  From parseAcceptanceCriteria.
 * @param {ReadonlyArray<number>} completedIds  From completedAcNumbers (any order).
 * @returns {AcCoverageResult}
 */
export function computeAcCoverage(criteria, completedIds) {
  const completedSet = new Set(
    Array.isArray(completedIds) ? completedIds : [],
  );

  /** @type {Map<number, AcceptanceCriterion>} */
  const byId = new Map();
  for (const c of Array.isArray(criteria) ? criteria : []) {
    if (!c || !Number.isInteger(c.id)) continue;
    if (!byId.has(c.id)) byId.set(c.id, c);
  }

  const ordered = [...byId.values()].sort((a, b) => a.id - b.id);
  const total = ordered.length;
  const missing = ordered
    .filter((c) => !completedSet.has(c.id))
    .map((c) => ({ id: c.id, text: c.text }));
  const completed = total - missing.length;
  const coveragePercent =
    total === 0 ? 100 : Math.floor((completed / total) * 100);

  return {
    ok: missing.length === 0,
    total,
    completed,
    coveragePercent,
    missing,
  };
}

/**
 * Summarize per-AC progress from completed ids and the persisted ordered
 * acceptance-criteria labels. When the label list is unknown (`undefined`),
 * `total` is 0 and `nextId`/`nextLabel` are null — done still reflects the
 * recorded completions.
 * @param {ReadonlyArray<number>} completedIds  Sorted 1-based completed ids.
 * @param {ReadonlyArray<string>} [acceptanceCriteria]  Ordered AC labels.
 * @returns {ImplProgress}
 */
export function summarizeImplProgress(completedIds, acceptanceCriteria) {
  const ids = [...completedIds].sort((a, b) => a - b);
  const total = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.length : 0;
  const completedSet = new Set(ids);
  const done =
    total > 0 ? ids.filter((n) => n >= 1 && n <= total).length : ids.length;
  const nextId = total > 0 ? nextAcNumber(completedSet, total) : null;
  const nextLabel =
    nextId !== null && acceptanceCriteria ? acceptanceCriteria[nextId - 1] : null;
  return { done, total, completedIds: ids, nextId, nextLabel };
}
