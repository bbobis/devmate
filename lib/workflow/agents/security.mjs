// @ts-check

import { dirname, resolve } from 'node:path';
import {
  ensureDirSync,
  pathExists,
  readTextFileSync,
  writeTextFileSync,
} from '../../fs-safe.mjs';
import { evaluateSecurityPolicy } from '../lanes/security-policy.mjs';

/** @typedef {'critical' | 'high' | 'medium' | 'low' | 'info'} SecuritySeverity */

/**
 * @typedef {{
 *   severity: SecuritySeverity,
 *   description: string,
 *   path: string
 * }} SecurityFinding
 */

/**
 * @typedef {{
 *   findings: SecurityFinding[],
 *   passed: boolean,
 *   unverified: string[]
 * }} SecurityFindingsArtifact
 */

/** @type {ReadonlySet<SecuritySeverity>} */
const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

/** @type {ReadonlySet<SecuritySeverity>} */
const FAIL_SEVERITIES = new Set(['critical', 'high']);

const SESSION_DIR = '.devmate/session';
const SECURITY_FILENAME = 'security.json';
const AGENT_FILE = 'agents/security.agent.md';

/**
 * Normalize one [UNVERIFIED] entry while preserving explicit marker.
 * @param {string} item
 * @returns {string}
 */
function normalizeUnverifiedItem(item) {
  const trimmed = item.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[UNVERIFIED]')) return trimmed;
  return `[UNVERIFIED] ${trimmed}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} finding
 * @returns {SecurityFinding | null}
 */
function normalizeFinding(finding) {
  if (!isRecord(finding)) return null;

  const severityRaw = typeof finding.severity === 'string' ? finding.severity.trim().toLowerCase() : '';
  const description = typeof finding.description === 'string' ? finding.description.trim() : '';
  const path = typeof finding.path === 'string' ? finding.path.trim() : '';

  if (!VALID_SEVERITIES.has(/** @type {SecuritySeverity} */ (severityRaw))) return null;
  if (description === '' || path === '') return null;

  return {
    severity: /** @type {SecuritySeverity} */ (severityRaw),
    description,
    path,
  };
}

/**
 * Creates a security findings artifact with evidence pointers.
 * @param {{ findings: Array<{ severity: string, description: string, path: string }> }} review
 * @returns {{ findings: object[], passed: boolean, unverified: string[] }}
 */
export function createSecurityFindingsArtifact(review) {
  const findingsRaw = Array.isArray(review?.findings) ? review.findings : [];

  /** @type {SecurityFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const unverified = [];

  for (const raw of findingsRaw) {
    const normalized = normalizeFinding(raw);
    if (!normalized) continue;
    findings.push(normalized);

    if (normalized.description.startsWith('[UNVERIFIED]')) {
      const marker = normalizeUnverifiedItem(normalized.description);
      if (marker !== '') unverified.push(marker);
    }
  }

  const passed = findings.every((finding) => !FAIL_SEVERITIES.has(finding.severity));

  return {
    findings,
    passed,
    unverified,
  };
}

/**
 * Validate security findings artifact structural integrity.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSecurityFindingsArtifact(artifact) {
  /** @type {string[]} */
  const errors = [];

  if (!isRecord(artifact)) {
    return { ok: false, errors: ['artifact must be an object'] };
  }

  const findings = artifact.findings;
  const passed = artifact.passed;
  const unverified = artifact.unverified;

  if (!Array.isArray(findings)) {
    errors.push('findings must be an array');
  }

  if (typeof passed !== 'boolean') {
    errors.push('passed must be a boolean');
  }

  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  }

  let shouldPass = true;
  if (Array.isArray(findings)) {
    for (const [index, finding] of findings.entries()) {
      if (!isRecord(finding)) {
        errors.push(`findings[${index}] must be an object`);
        shouldPass = false;
        continue;
      }

      const severity = finding.severity;
      const description = finding.description;
      const path = finding.path;

      const severityOk = typeof severity === 'string' && VALID_SEVERITIES.has(/** @type {SecuritySeverity} */ (severity));
      const descriptionOk = typeof description === 'string' && description.trim() !== '';
      const pathOk = typeof path === 'string' && path.trim() !== '';

      if (!severityOk) errors.push(`findings[${index}].severity must be one of critical/high/medium/low/info`);
      if (!descriptionOk) errors.push(`findings[${index}].description must be a non-empty string`);
      if (!pathOk) errors.push(`findings[${index}].path must be a non-empty string`);

      if (severityOk && FAIL_SEVERITIES.has(/** @type {SecuritySeverity} */ (severity))) {
        shouldPass = false;
      }
      if (!severityOk || !descriptionOk || !pathOk) {
        shouldPass = false;
      }
    }
  }

  if (Array.isArray(unverified)) {
    for (const [index, item] of unverified.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`unverified[${index}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`unverified[${index}] must start with [UNVERIFIED]`);
      }
    }
  }

  if (typeof passed === 'boolean' && passed !== shouldPass) {
    errors.push(`passed must equal ${shouldPass} for the provided findings`);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Resolve the security artifact path for one task.
 * @param {string} taskId
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveSecurityPath(taskId, repoRoot) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('taskId must be a non-empty string');
  }
  return resolve(repoRoot, SESSION_DIR, taskId, SECURITY_FILENAME);
}

/**
 * Writes a validated SecurityFindingsArtifact to .devmate/session/{taskId}/security.json.
 * @param {string} taskId
 * @param {SecurityFindingsArtifact} artifact
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ path: string }>}
 */
export async function writeSecurityArtifact(taskId, artifact, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveSecurityPath(taskId, repoRoot);

  const verdict = validateSecurityFindingsArtifact(artifact);
  if (!verdict.ok) {
    throw new Error(`invalid SecurityFindingsArtifact: ${verdict.errors.join('; ')}`);
  }

  ensureDirSync(dirname(path));
  writeTextFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path };
}

/**
 * Reads and parses the security artifact for a given task session.
 * @param {string} taskId
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<SecurityFindingsArtifact>}
 */
export async function readSecurityArtifact(taskId, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveSecurityPath(taskId, repoRoot);
  try {
    const content = readTextFileSync(path);
    return /** @type {SecurityFindingsArtifact} */ (JSON.parse(content));
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      /** @type {{ code?: unknown }} */ (err).code === 'ENOENT'
    ) {
      throw new Error(`security artifact not found at ${path}`);
    }
    throw err;
  }
}

/**
 * Create, validate, and persist a security artifact for one task.
 * @param {string} taskId
 * @param {{ findings: Array<{ severity: string, description: string, path: string }> }} review
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ artifact: SecurityFindingsArtifact, path: string }>}
 */
export async function persistSecurityFindingsArtifact(taskId, review, opts = {}) {
  const artifact = /** @type {SecurityFindingsArtifact} */ (createSecurityFindingsArtifact(review));
  const result = await writeSecurityArtifact(taskId, artifact, opts);
  return { artifact, path: result.path };
}

/**
 * True when policy requires a security pass for the given context.
 * @param {{ lane: 'feature' | 'bug' | 'chore', tags: string[], affectedPaths: string[] }} context
 * @returns {boolean}
 */
export function isSecurityRequired(context) {
  return evaluateSecurityPolicy(context).required;
}

/**
 * Ensure security agent file is present when review is mandatory.
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertSecurityAgentAvailable(repoRoot = process.cwd()) {
  const filePath = resolve(repoRoot, AGENT_FILE);
  if (!pathExists(filePath)) {
    return {
      ok: false,
      error: `security review required but missing agent file: ${filePath}`,
    };
  }
  return { ok: true };
}
