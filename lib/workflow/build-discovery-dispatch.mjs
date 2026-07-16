// @ts-check

/**
 * FO-5: builder for the Phase-2 scoped `@discovery` worker dispatch prompts
 * of the two-phase discovery fan-out (scan → K scoped workers → merge).
 *
 * Mirrors the E10-06 poka-yoke of `lib/workflow/build-dispatch-payload.mjs`:
 * an under-specified dispatch is never built — every required field is
 * checked up front and the first missing one is named in the thrown error.
 *
 * The Boundaries section is partly structural: the disjoint candidate
 * partition is rendered as pointers (path + optional line anchor + one-line
 * why from the scan) and the non-negotiable worker rules (stay inside the
 * partition's directories, bounded file slices, evidence-backed claims,
 * no candidate-list echo) are appended by this builder itself — they can
 * not be forgotten by a caller (structural safety over prompt trust).
 */

import { getOwn } from '../object-utils.mjs';

/**
 * A candidate pointer handed to one scoped worker: the Phase-1 scan's
 * output reduced to a pointer (TCM-3) — never pasted file content.
 * @typedef {Object} DiscoveryCandidatePointer
 * @property {string} path                              Repo-relative file path.
 * @property {string} [why]                             One-line reason from the scan.
 * @property {{ start: number, end: number }} [lineAnchor] Optional 1-based line anchor.
 */

/**
 * FO-5: every scoped discovery dispatch must carry the full field set —
 * an under-specified discovery worker duplicates work or drifts out of its
 * partition. `taskStatement` is deliberately shared verbatim across all K
 * workers (the Cognition Principle-1 concession: every worker sees the same
 * task framing, only its partition differs).
 * @typedef {Object} BuildDiscoveryDispatchOptions
 * @property {string} angle          Short label for this worker's slice, e.g. "entry points & routing".
 * @property {string} objective      What this worker must find out (single statement).
 * @property {string} outputFormat   The discovery artifact JSON contract, restated.
 * @property {string} toolGuidance   e.g. "search then read minimal slices; issue multiple search tool calls per turn".
 * @property {string} boundaries     Caller-side boundary prose (the structural rules below are appended).
 * @property {'quick'|'medium'|'thorough'} thoroughness Effort hint (Claude Code Explore precedent).
 * @property {string} taskStatement  The shared task framing every worker receives verbatim.
 * @property {DiscoveryCandidatePointer[]} candidates  This worker's DISJOINT candidate partition.
 * @property {number} maxFileSlices  Hard cap on file slices this worker may read (>= 1).
 * @property {string} [modelHint]    FO-7: routed model for this worker, rendered as an ADVISORY
 *                                   line only — the builder never enforces a model.
 */

/**
 * The dispatch-completeness fields required on every scoped discovery
 * dispatch (FO-5 poka-yoke, mirroring E10-06 R6). Order matters only for
 * error reporting: the first missing field is the one named in the error.
 * @type {ReadonlyArray<'angle'|'objective'|'outputFormat'|'toolGuidance'|'boundaries'|'thoroughness'|'taskStatement'>}
 */
export const REQUIRED_DISCOVERY_DISPATCH_FIELDS = Object.freeze([
  'angle',
  'objective',
  'outputFormat',
  'toolGuidance',
  'boundaries',
  'thoroughness',
  'taskStatement',
]);

/** @type {ReadonlySet<string>} */
const THOROUGHNESS_VALUES = new Set(['quick', 'medium', 'thorough']);

/**
 * Reject under-specified discovery dispatches: each required field must be
 * a non-empty string, `thoroughness` must be one of quick|medium|thorough,
 * `candidates` must be a non-empty array of path-bearing pointers, and
 * `maxFileSlices` must be an integer >= 1. Throws naming the first problem.
 * @param {BuildDiscoveryDispatchOptions} opts
 * @returns {void}
 */
function assertDiscoveryDispatchCompleteness(opts) {
  for (const field of REQUIRED_DISCOVERY_DISPATCH_FIELDS) {
    const value = getOwn(opts, field);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `buildDiscoveryDispatch: missing required dispatch field '${field}' — ` +
        'every scoped discovery dispatch must carry angle, objective, outputFormat, ' +
        'toolGuidance, boundaries, thoroughness, and the shared taskStatement',
      );
    }
  }
  if (!THOROUGHNESS_VALUES.has(opts.thoroughness)) {
    throw new Error(
      `buildDiscoveryDispatch: thoroughness must be one of quick|medium|thorough, got '${opts.thoroughness}'`,
    );
  }
  if (!Array.isArray(opts.candidates) || opts.candidates.length === 0) {
    throw new Error(
      "buildDiscoveryDispatch: missing required dispatch field 'candidates' — " +
      'a scoped worker needs its disjoint candidate partition (non-empty array)',
    );
  }
  for (const [index, candidate] of opts.candidates.entries()) {
    if (candidate === null || typeof candidate !== 'object' ||
        typeof candidate.path !== 'string' || candidate.path.trim() === '') {
      throw new Error(
        `buildDiscoveryDispatch: candidates[${index}] must carry a non-empty string path`,
      );
    }
    const anchor = candidate.lineAnchor;
    if (anchor !== undefined) {
      const anchorValid =
        anchor !== null && typeof anchor === 'object' &&
        Number.isInteger(anchor.start) && Number.isInteger(anchor.end) &&
        anchor.start >= 1 && anchor.end >= anchor.start;
      if (!anchorValid) {
        throw new Error(
          `buildDiscoveryDispatch: candidates[${index}].lineAnchor must be ` +
          '{ start, end } integers with start >= 1 and end >= start when present — ' +
          'a malformed anchor would render an invalid pointer',
        );
      }
    }
  }
  if (typeof opts.maxFileSlices !== 'number' || !Number.isInteger(opts.maxFileSlices) || opts.maxFileSlices < 1) {
    throw new Error(
      "buildDiscoveryDispatch: missing required dispatch field 'maxFileSlices' — " +
      'the file-slice cap must be an integer >= 1',
    );
  }
  if (opts.modelHint !== undefined &&
      (typeof opts.modelHint !== 'string' || opts.modelHint.trim() === '')) {
    throw new Error(
      "buildDiscoveryDispatch: optional field 'modelHint' must be a non-empty string when present — " +
      'a blank model hint would render a meaningless advisory line',
    );
  }
}

/**
 * Render one candidate as a pointer line: path (+ optional line anchor) and
 * the scan's one-line why. Pointers only — never file content (TCM-3).
 * @param {DiscoveryCandidatePointer} candidate
 * @returns {string}
 */
function renderCandidatePointer(candidate) {
  const anchor = candidate.lineAnchor
    ? `#L${candidate.lineAnchor.start}-L${candidate.lineAnchor.end}`
    : '';
  const why = typeof candidate.why === 'string' && candidate.why.trim() !== ''
    ? ` — ${candidate.why.trim()}`
    : '';
  return `- ${candidate.path}${anchor}${why}`;
}

/**
 * Build the prompt for one scoped Phase-2 `@discovery` worker, rejecting
 * under-specified dispatches (FO-5 poka-yoke). The rendered Boundaries
 * section always contains the worker's disjoint candidate partition as
 * pointers plus the structural worker rules, regardless of the caller's
 * own boundary prose.
 * @param {BuildDiscoveryDispatchOptions} opts
 * @returns {string}
 * @throws When any required field is missing/empty, `thoroughness` is not
 *         quick|medium|thorough, `candidates` is empty, `maxFileSlices`
 *         is not an integer >= 1, or a present `modelHint` is blank.
 */
export function buildDiscoveryDispatch(opts) {
  assertDiscoveryDispatchCompleteness(opts);

  return [
    '## Task statement',
    '',
    opts.taskStatement,
    '',
    `## Angle: ${opts.angle}`,
    '',
    '## Objective',
    '',
    opts.objective,
    '',
    '## Output format',
    '',
    opts.outputFormat,
    '',
    '## Tool guidance',
    '',
    opts.toolGuidance,
    '',
    `## Thoroughness: ${opts.thoroughness}`,
    '',
    ...(opts.modelHint !== undefined
      ? [`Preferred model for this worker: ${opts.modelHint.trim()} (advisory)`, '']
      : []),
    '## Boundaries',
    '',
    opts.boundaries,
    '',
    '### Your candidate partition (pointers — disjoint from every other worker)',
    '',
    ...opts.candidates.map(renderCandidatePointer),
    '',
    '### Hard rules',
    '',
    "- Do not read outside your candidate partition's directories.",
    `- Read at most ${opts.maxFileSlices} file slices.`,
    '- Return claims with evidence paths; anything uncertain goes to unverified; do NOT echo the candidate list back.',
    '',
  ].join('\n');
}
