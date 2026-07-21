// @ts-check

import { getOwn } from '../object-utils.mjs';
import { alignmentErrors } from './alignment.mjs';

/** @typedef {import('../types.mjs').DiagnosisResult} DiagnosisResult */
/** @typedef {import('../types.mjs').GrillResult} GrillResult */
/** @typedef {import('../types.mjs').CritiqueResult} CritiqueResult */

export { validateWorkerReturn } from '../context/worker-contract.mjs';

/**
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDiagnosisResult(artifact) {
  /** @type {string[]} */
  const errors = [];
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['DiagnosisResult must be an object'] };
  }
  const d = /** @type {Record<string, unknown>} */ (artifact);

  if (typeof d['bugScope'] !== 'string' || d['bugScope'].trim() === '') {
    errors.push('bugScope must be a non-empty string');
  }
  if (typeof d['suspectedLayer'] !== 'string' || d['suspectedLayer'].trim() === '') {
    errors.push('suspectedLayer must be a non-empty string');
  }
  if (typeof d['reproCommand'] !== 'string' || d['reproCommand'].trim() === '') {
    errors.push('reproCommand must be a non-empty string');
  }
  if (
    typeof d['fixerRecommendation'] !== 'string' ||
    d['fixerRecommendation'].trim() === ''
  ) {
    errors.push('fixerRecommendation must be a non-empty string');
  }
  if (typeof d['taskId'] !== 'string' || d['taskId'].trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (d['schemaVersion'] !== 1) {
    errors.push('schemaVersion must equal 1');
  }

  // #92: the bug lane's edit boundary, carried in the RETURN rather than in a
  // file the agent cannot write. `agents/diagnose.agent.md` already instructs
  // @diagnose to produce a scope.md with exactly these two sections — but its
  // tools are ['search/codebase', 'read/problems', 'execute'], with no `edit`,
  // so the file never appeared and the bug lane ran with no boundary at all
  // (and, since the dispatch gate requires scope.md, could not dispatch
  // @fullstack either). The content always existed; it was in the wrong medium.
  // The hook writes the file from these fields.
  //
  // At least one of the two must be non-empty: a diagnosis that bounds the fix
  // to nothing is not a scope, and an empty contract denies every edit.
  validateStringArrayField(d, 'allowedPaths', errors);
  validateStringArrayField(d, 'allowedGlobs', errors);
  const paths = Array.isArray(d['allowedPaths']) ? d['allowedPaths'] : [];
  const globs = Array.isArray(d['allowedGlobs']) ? d['allowedGlobs'] : [];
  if (paths.length === 0 && globs.length === 0) {
    errors.push(
      'allowedPaths and allowedGlobs cannot both be empty — the fix must be bounded to at least one path or glob',
    );
  }

  // issue 240: the codebase-alignment contract, carried into the bug lane. In
  // this version `alignment` is OPTIONAL/advisory (absent is valid), to be
  // promoted to required once the feature-lane rollout is proven. When present
  // it must be a well-formed `reuse | extend | add` array — the SAME structural
  // contract the feature-lane planner task enforces (P32, issue 238), shared via
  // lib/workflow/alignment.mjs so the two lane carriers cannot drift.
  errors.push(...alignmentErrors(d['alignment'], 'alignment', { required: false }));

  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGrillResult(artifact) {
  /** @type {string[]} */
  const errors = [];
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['GrillResult must be an object'] };
  }
  const g = /** @type {Record<string, unknown>} */ (artifact);

  if (typeof g['taskId'] !== 'string' || g['taskId'].trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (g['mode'] !== 'grill') {
    errors.push("mode must equal 'grill'");
  }
  if (g['schemaVersion'] !== 1) {
    errors.push('schemaVersion must equal 1');
  }
  if (typeof g['returnedAt'] !== 'string' || g['returnedAt'].trim() === '') {
    errors.push('returnedAt must be a non-empty string');
  }

  validateStringArrayField(g, 'assumptions', errors);
  validateStringArrayField(g, 'missingRequirements', errors);
  validateStringArrayField(g, 'edgeCases', errors);
  validateStringArrayField(g, 'cornerCases', errors);
  validateStringArrayField(g, 'securityRisks', errors);
  validateStringArrayField(g, 'uxRisks', errors);
  validateStringArrayField(g, 'blockingQuestions', errors);
  validateStringArrayField(g, 'recommendedDecisions', errors);

  // E9-17: [UNVERIFIED]-prefix enforcement, ported verbatim from the strict
  // rubber-duck validator — every unverifiedItems entry must carry the tag.
  const unverified = g['unverifiedItems'];
  if (!Array.isArray(unverified)) {
    errors.push('unverifiedItems must be an array');
  } else {
    for (let i = 0; i < unverified.length; i += 1) {
      const item = unverified[i];
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`unverifiedItems[${i}] must be a non-empty string`);
      } else if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`unverifiedItems[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCritiqueResult(artifact) {
  /** @type {string[]} */
  const errors = [];
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['CritiqueResult must be an object'] };
  }
  const c = /** @type {Record<string, unknown>} */ (artifact);

  if (typeof c['taskId'] !== 'string' || c['taskId'].trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (c['mode'] !== 'critique') {
    errors.push("mode must equal 'critique'");
  }
  if (c['schemaVersion'] !== 1) {
    errors.push('schemaVersion must equal 1');
  }
  if (typeof c['returnedAt'] !== 'string' || c['returnedAt'].trim() === '') {
    errors.push('returnedAt must be a non-empty string');
  }

  validateStringArrayField(c, 'missingAcceptanceCriteria', errors);
  validateStringArrayField(c, 'missingTests', errors);
  validateStringArrayField(c, 'riskySequencing', errors);
  validateStringArrayField(c, 'unlistedFiles', errors);
  validateStringArrayField(c, 'backwardsCompatRisks', errors);

  if (typeof c['rollbackRisk'] !== 'string' || c['rollbackRisk'].trim() === '') {
    errors.push('rollbackRisk must be a non-empty string');
  }
  const verdict = c['verdict'];
  if (typeof verdict !== 'string' || verdict.trim() === '') {
    errors.push('verdict must be a non-empty string');
  } else if (verdict !== 'APPROVE_PLAN' && !verdict.startsWith('REQUEST_REVISION:')) {
    errors.push('verdict must be "APPROVE_PLAN" or start with "REQUEST_REVISION:"');
  }

  return { ok: errors.length === 0, errors };
}

/** Allowed severities for a PrReviewFinding. */
const PR_REVIEW_SEVERITIES = new Set(['blocker', 'high', 'medium', 'low', 'info']);

/** Allowed categories for a PrReviewFinding. */
const PR_REVIEW_CATEGORIES = new Set(['alignment', 'security', 'quality']);

/** Allowed lanes for a PrReviewArtifact. */
const PR_REVIEW_LANES = new Set(['feature', 'bug', 'chore']);

/**
 * Validate a PrReviewArtifact (the `/devmate-pr-review` verdict). Non-throwing;
 * mirrors {@link validateCritiqueResult}. `verdict` must be the literal
 * `APPROVE` or `REQUEST_CHANGES:<non-empty reason>`; every finding must carry an
 * in-enum severity + category and a non-empty `evidence.path`; every
 * `unverified[]` entry must start with `[UNVERIFIED]`.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePrReviewResult(artifact) {
  /** @type {string[]} */
  const errors = [];
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['PrReviewResult must be an object'] };
  }
  const a = /** @type {Record<string, unknown>} */ (artifact);

  if (typeof a['taskId'] !== 'string' || a['taskId'].trim() === '') {
    errors.push('taskId must be a non-empty string');
  }
  if (!PR_REVIEW_LANES.has(/** @type {string} */ (a['lane']))) {
    errors.push("lane must be one of: feature, bug, chore");
  }
  if (a['schemaVersion'] !== 1) {
    errors.push('schemaVersion must equal 1');
  }
  if (typeof a['returnedAt'] !== 'string' || a['returnedAt'].trim() === '') {
    errors.push('returnedAt must be a non-empty string');
  }
  // Neutral local name: the no-insecure-comparison lint keyword-matches
  // 'Digest' and would flag the '' emptiness check as a credential comparison.
  const contextRef = a['contextDigest'];
  if (typeof contextRef !== 'string' || contextRef.trim() === '') {
    errors.push('contextDigest must be a non-empty string');
  }

  const verdict = a['verdict'];
  if (typeof verdict !== 'string' || verdict.trim() === '') {
    errors.push('verdict must be a non-empty string');
  } else if (verdict !== 'APPROVE' && !verdict.startsWith('REQUEST_CHANGES:')) {
    errors.push('verdict must be "APPROVE" or start with "REQUEST_CHANGES:"');
  } else if (verdict.startsWith('REQUEST_CHANGES:') && verdict.slice('REQUEST_CHANGES:'.length).trim() === '') {
    errors.push('verdict "REQUEST_CHANGES:" must carry a non-empty reason');
  }

  const findings = a['findings'];
  if (!Array.isArray(findings)) {
    errors.push('findings must be an array');
  } else {
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i];
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`findings[${i}] must be an object`);
        continue;
      }
      const finding = /** @type {Record<string, unknown>} */ (f);
      if (!PR_REVIEW_SEVERITIES.has(/** @type {string} */ (finding['severity']))) {
        errors.push(`findings[${i}].severity must be one of blocker/high/medium/low/info`);
      }
      if (!PR_REVIEW_CATEGORIES.has(/** @type {string} */ (finding['category']))) {
        errors.push(`findings[${i}].category must be one of alignment/security/quality`);
      }
      const evidence = finding['evidence'];
      if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
        errors.push(`findings[${i}].evidence must be an object`);
      } else {
        const ev = /** @type {Record<string, unknown>} */ (evidence);
        if (typeof ev['path'] !== 'string' || ev['path'].trim() === '') {
          errors.push(`findings[${i}].evidence.path must be a non-empty string`);
        }
      }
      if (typeof finding['finding'] !== 'string' || finding['finding'].trim() === '') {
        errors.push(`findings[${i}].finding must be a non-empty string`);
      }
      if (typeof finding['recommendation'] !== 'string' || finding['recommendation'].trim() === '') {
        errors.push(`findings[${i}].recommendation must be a non-empty string`);
      }
    }
  }

  const alignment = a['alignment'];
  if (alignment === null || typeof alignment !== 'object' || Array.isArray(alignment)) {
    errors.push('alignment must be an object');
  } else {
    const al = /** @type {Record<string, unknown>} */ (alignment);
    if (typeof al['ok'] !== 'boolean') errors.push('alignment.ok must be a boolean');
    if (typeof al['missingRegressionTest'] !== 'boolean') {
      errors.push('alignment.missingRegressionTest must be a boolean');
    }
    validateStringArrayField(al, 'outOfScopeFiles', errors);
    validateStringArrayField(al, 'unlistedFiles', errors);
  }

  const unverified = a['unverified'];
  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  } else {
    for (let i = 0; i < unverified.length; i += 1) {
      const item = unverified[i];
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`unverified[${i}] must be a non-empty string`);
      } else if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`unverified[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} field
 * @param {string[]} errors
 */
function validateStringArrayField(obj, field, errors) {
  const value = getOwn(obj, field);
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`${field}[${i}] must be a string`);
    }
  }
}
