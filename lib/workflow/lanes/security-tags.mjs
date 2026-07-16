// @ts-check

import {
  SECURITY_REQUIRED_TAGS,
  FEATURE_SENSITIVE_TAGS,
} from './security-policy.mjs';

/**
 * @typedef {{
 *   claims: Array<{ fact: string, path: string, confidence: 'high' | 'low' }>,
 *   unverified: string[]
 * }} DiscoveryArtifact
 */

/**
 * @typedef {{
 *   securityRisks: string[],
 *   [key: string]: unknown
 * }} GrillResult
 */

/**
 * Normalizes a string to lower-case trimmed form.
 * @param {string} s
 * @returns {string}
 */
function normalizeTag(s) {
  return s.trim().toLowerCase();
}

/**
 * Checks if a string contains a keyword match against a set of tags.
 * Used for free-text grill.securityRisks and discovery.claims[].fact.
 * Normalizes both text and tags by removing dashes/underscores and lowercasing.
 * @param {string} text
 * @param {ReadonlySet<string>} tagSet
 * @returns {string | null}
 */
function findKeywordMatch(text, tagSet) {
  const normalized = normalizeTag(text).replace(/[-_]/g, ' ');
  for (const tag of tagSet) {
    const normalizedTag = normalizeTag(tag).replace(/[-_]/g, ' ');
    // Whole-word match: search for the normalized tag as a substring
    if (normalized.includes(normalizedTag)) {
      return tag; // return original tag, not normalized
    }
  }
  return null;
}

/**
 * Derives security-relevant tags from grill output, discovery output, and labels.
 * Reuses `SECURITY_REQUIRED_TAGS` and `FEATURE_SENSITIVE_TAGS` from security-policy.
 * All inputs optional; missing or malformed inputs yield [] or are skipped.
 * Returns a de-duplicated, lower-cased string[] of matched tags.
 *
 * @param {{
 *   grill?: GrillResult | null,
 *   discovery?: DiscoveryArtifact | null,
 *   labels?: string[] | null,
 *   lane?: 'feature' | 'bug' | 'chore'
 * }} input
 * @returns {string[]}
 */
export function deriveSecurityTags(input = {}) {
  /** @type {Set<string>} */
  const matched = new Set();

  const grill = input.grill ?? null;
  const discovery = input.discovery ?? null;
  const labels = input.labels ?? null;
  const lane = input.lane ?? 'bug';

  // Signal 1: grill.securityRisks - free-text field, keyword-match against canonical tags
  if (
    grill &&
    typeof grill === 'object' &&
    Array.isArray(grill.securityRisks)
  ) {
    for (const risk of grill.securityRisks) {
      if (typeof risk !== 'string') continue;
      const tag = findKeywordMatch(risk, SECURITY_REQUIRED_TAGS);
      if (tag) matched.add(normalizeTag(tag));
    }
  }

  // Signal 2: discovery.claims[] - fact + path, keyword-match
  if (
    discovery &&
    typeof discovery === 'object' &&
    Array.isArray(discovery.claims)
  ) {
    for (const claim of discovery.claims) {
      if (!claim || typeof claim !== 'object') continue;
      const fact = claim.fact;
      const path = claim.path;

      if (typeof fact === 'string') {
        const tag = findKeywordMatch(fact, SECURITY_REQUIRED_TAGS);
        if (tag) matched.add(normalizeTag(tag));
      }

      if (typeof path === 'string') {
        const tag = findKeywordMatch(path, SECURITY_REQUIRED_TAGS);
        if (tag) matched.add(normalizeTag(tag));
      }
    }
  }

  // Signal 3: labels - direct membership in canonical tag sets, no keyword matching
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (typeof label !== 'string') continue;
      const normalized = normalizeTag(label);
      if (SECURITY_REQUIRED_TAGS.has(normalized)) {
        matched.add(normalized);
      }
    }
  }

  // Feature lane bonus: also check FEATURE_SENSITIVE_TAGS if lane === 'feature'
  if (lane === 'feature') {
    if (
      grill &&
      typeof grill === 'object' &&
      Array.isArray(grill.securityRisks)
    ) {
      for (const risk of grill.securityRisks) {
        if (typeof risk !== 'string') continue;
        const tag = findKeywordMatch(risk, FEATURE_SENSITIVE_TAGS);
        if (tag) matched.add(normalizeTag(tag));
      }
    }

    if (
      discovery &&
      typeof discovery === 'object' &&
      Array.isArray(discovery.claims)
    ) {
      for (const claim of discovery.claims) {
        if (!claim || typeof claim !== 'object') continue;
        const fact = claim.fact;
        const path = claim.path;

        if (typeof fact === 'string') {
          const tag = findKeywordMatch(fact, FEATURE_SENSITIVE_TAGS);
          if (tag) matched.add(normalizeTag(tag));
        }

        if (typeof path === 'string') {
          const tag = findKeywordMatch(path, FEATURE_SENSITIVE_TAGS);
          if (tag) matched.add(normalizeTag(tag));
        }
      }
    }

    if (Array.isArray(labels)) {
      for (const label of labels) {
        if (typeof label !== 'string') continue;
        const normalized = normalizeTag(label);
        if (FEATURE_SENSITIVE_TAGS.has(normalized)) {
          matched.add(normalized);
        }
      }
    }
  }

  return [...matched].sort();
}
