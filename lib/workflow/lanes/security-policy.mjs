// @ts-check

import { matchGlob } from '../../workstream-partitioner.mjs';

/** @typedef {'feature' | 'bug' | 'chore'} SecurityLane */

/** @type {ReadonlySet<SecurityLane>} */
const VALID_LANES = new Set(['feature', 'bug', 'chore']);

/** @type {ReadonlySet<string>} */
export const SECURITY_REQUIRED_TAGS = new Set([
  'security',
  'auth',
  'secrets',
  'crypto',
  'sensitive-api',
]);

/** @type {ReadonlySet<string>} */
export const FEATURE_SENSITIVE_TAGS = new Set(['external-api', 'data-exposure']);

/** @type {readonly string[]} */
export const SECURITY_REQUIRED_PATH_GLOBS = [
  '**/auth/**',
  '**/login/**',
  '**/*password*',
  '**/*token*',
  '**/*credential*',
  '**/.env*',
  '**/secrets/**',
  '**/crypto/**',
];

/**
 * @typedef {object} SecurityPolicyContext
 * @property {SecurityLane} lane
 * @property {string[]} tags
 * @property {string[]} affectedPaths
 */

/**
 * @typedef {object} SecurityPolicyResult
 * @property {boolean} required
 * @property {string} reason
 * @property {string[]} triggeringPaths
 * @property {string[]} triggeringTags
 */

/**
 * Normalize input strings into lower-case trimmed values.
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string[]}
 */
function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new TypeError(`evaluateSecurityPolicy: ${fieldName} must be an array`);
  }

  /** @type {string[]} */
  const output = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new TypeError(`evaluateSecurityPolicy: ${fieldName} items must be strings`);
    }
    const normalized = item.trim().toLowerCase();
    if (normalized !== '') output.push(normalized);
  }
  return output;
}

/**
 * Validate and normalize security policy context.
 * @param {SecurityPolicyContext} context
 * @returns {{ lane: SecurityLane, tags: string[], affectedPaths: string[] }}
 */
function normalizeContext(context) {
  if (!context || typeof context !== 'object') {
    throw new TypeError('evaluateSecurityPolicy: context must be an object');
  }

  const lane = context.lane;
  if (typeof lane !== 'string' || !VALID_LANES.has(/** @type {SecurityLane} */ (lane))) {
    throw new TypeError("evaluateSecurityPolicy: lane must be 'feature', 'bug', or 'chore'");
  }

  const tags = normalizeStringArray(context.tags, 'tags');
  const affectedPaths = normalizeStringArray(context.affectedPaths, 'affectedPaths');
  return {
    lane: /** @type {SecurityLane} */ (lane),
    tags,
    affectedPaths,
  };
}

/**
 * Evaluates whether security review is required for this lane and change type.
 * @param {{ lane: 'feature' | 'bug' | 'chore', tags: string[], affectedPaths: string[] }} context
 * @returns {{ required: boolean, reason: string, triggeringPaths: string[], triggeringTags: string[] }}
 */
export function evaluateSecurityPolicy(context) {
  const normalized = normalizeContext(context);

  /** @type {string[]} */
  const triggeringTags = [];
  for (const tag of normalized.tags) {
    if (SECURITY_REQUIRED_TAGS.has(tag)) {
      triggeringTags.push(tag);
    }
  }

  if (normalized.lane === 'feature') {
    for (const tag of normalized.tags) {
      if (FEATURE_SENSITIVE_TAGS.has(tag)) {
        triggeringTags.push(tag);
      }
    }
  }

  /** @type {string[]} */
  const triggeringPaths = [];
  for (const changedPath of normalized.affectedPaths) {
    for (const glob of SECURITY_REQUIRED_PATH_GLOBS) {
      if (matchGlob(glob, changedPath)) {
        triggeringPaths.push(changedPath);
        break;
      }
    }
  }

  const uniqueTags = [...new Set(triggeringTags)];
  const uniquePaths = [...new Set(triggeringPaths)];

  if (uniqueTags.length > 0 || uniquePaths.length > 0) {
    if (uniqueTags.length > 0) {
      return {
        required: true,
        reason: `required:tag:${uniqueTags[0]}`,
        triggeringPaths: uniquePaths,
        triggeringTags: uniqueTags,
      };
    }
    return {
      required: true,
      reason: `required:path:${uniquePaths[0]}`,
      triggeringPaths: uniquePaths,
      triggeringTags: uniqueTags,
    };
  }

  return {
    required: false,
    reason: 'optional:default-low-risk',
    triggeringPaths: [],
    triggeringTags: [],
  };
}
