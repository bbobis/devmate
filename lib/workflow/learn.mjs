// @ts-check
// E5-6: split `/devmate-learn` into a read-only help path and a gated
// pattern-authoring path. This module owns routing + approval validation;
// the actual writes live in `pattern-author.mjs`.
//
// Anti-hallucination note: the spec assumed a read-only
// `agents/devmate-learn.agent.md` already existed. It does not in this
// codebase. The routing here is the single, doc-free heuristic — no external
// NLP — and a write can never happen from routing alone.

/** @typedef {import('../types.mjs').LearnRoute} LearnRoute */
/** @typedef {import('../types.mjs').Pattern} Pattern */
/** @typedef {import('../types.mjs').PatternApproval} PatternApproval */

/** Required prefix for any valid pattern approval phrase. */
export const PATTERN_APPROVAL_PREFIX = 'approve pattern:';

/** Phrases (case-insensitive) that route to pattern authoring. */
export const PATTERN_AUTHORING_PHRASES = Object.freeze([
  'author pattern',
  'create pattern',
  'add pattern',
  'write pattern',
  'update pattern',
  'approve pattern',
]);

/**
 * Route a learn invocation to help (read-only) or pattern-authoring (gated).
 * Only heuristic: substring match on known authoring phrases. No NLP.
 * @param {string} userInput
 * @returns {LearnRoute}
 */
export function routeLearnCommand(userInput) {
  const text = (userInput || '').toLowerCase();
  for (const phrase of PATTERN_AUTHORING_PHRASES) {
    if (text.includes(phrase)) return 'pattern-authoring';
  }
  return 'help';
}

/**
 * True when the input is a pattern-authoring request.
 * @param {string} userInput
 * @returns {boolean}
 */
export function isPatternAuthoringRequest(userInput) {
  switch (routeLearnCommand(userInput)) {
    case 'pattern-authoring':
      return true;
    default:
      return false;
  }
}

/**
 * Validate that a pending pattern has a matching approval before write.
 * @param {Pattern} pattern
 * @param {PatternApproval[]} approvals
 * @returns {string|null}  null when approved, else a block reason string.
 */
export function validatePatternApproval(pattern, approvals) {
  const list = Array.isArray(approvals) ? approvals : [];
  const match = list.find(
    (a) =>
      a.patternId === pattern.id &&
      typeof a.approvedBy === 'string' &&
      a.approvedBy.toLowerCase().startsWith(PATTERN_APPROVAL_PREFIX),
  );
  if (match) return null;
  return `No approval found for pattern '${pattern.id}'. Say "approve pattern: ${pattern.id}" first.`;
}
