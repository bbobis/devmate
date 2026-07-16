// @ts-check
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { ensureDirSync, writeTextFileSync } from '../../fs-safe.mjs';
import { recordArtifactHash } from '../../task-state.mjs';
import { validateCritiqueResult } from '../contracts.mjs';

/**
 * @typedef {{
 *   taskId: string,
 *   mode: 'grill',
 *   schemaVersion: number,
 *   returnedAt: string,
 *   assumptions: string[],
 *   missingRequirements: string[],
 *   edgeCases: string[],
 *   cornerCases: string[],
 *   securityRisks: string[],
 *   uxRisks: string[],
 *   blockingQuestions: string[],
 *   recommendedDecisions: string[],
 *   unverifiedItems: string[],
 *   risks: string[],
 *   revisionsRequested: number
 * }} GrillResult
 */

/**
 * @typedef {{
 *   taskId: string,
 *   mode: 'critique',
 *   schemaVersion: number,
 *   returnedAt: string,
 *   missingAcceptanceCriteria: string[],
 *   missingTests: string[],
 *   riskySequencing: string[],
 *   unlistedFiles: string[],
 *   backwardsCompatRisks: string[],
 *   rollbackRisk: string,
 *   verdict: 'APPROVE_PLAN' | `REQUEST_REVISION:${string}`,
 *   revisionsRequested: number
 * }} CritiqueResult
 */

const SESSION_DIR = '.devmate/session';
const CRITIQUE_FILENAME = 'critique.json';

/** @type {ReadonlySet<string>} */
const VALID_MODES = new Set(['grill', 'critique']);

/**
 * Resolve the on-disk path for one session artifact.
 * @param {string} taskId
 * @param {string} fileName
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveSessionArtifactPath(taskId, fileName, repoRoot) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('taskId must be a non-empty string');
  }
  return resolve(repoRoot, SESSION_DIR, taskId, fileName);
}

// TODO: promote to lib/workflow/agents/_normalize.mjs when a 3rd consumer appears
/**
 * Normalize one unverified item and ensure `[UNVERIFIED]` tagging.
 * @param {string} item
 * @returns {string}
 */
function normalizeUnverifiedItem(item) {
  const trimmed = item.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[UNVERIFIED]')) return trimmed;
  return `[UNVERIFIED] ${trimmed}`;
}

// TODO: promote to lib/workflow/agents/_normalize.mjs when a 3rd consumer appears
/**
 * Normalize one string list while removing empty entries.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Normalize a list and force `[UNVERIFIED]` prefix on every entry.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeUnverifiedList(value) {
  const items = normalizeStringList(value);
  /** @type {string[]} */
  const result = [];
  for (const item of items) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized !== '') result.push(normalized);
  }
  return result;
}

/**
 * Creates a typed GrillResult critique artifact.
 * @param {{
 *   assumptions?: string[],
 *   missingRequirements?: string[],
 *   edgeCases?: string[],
 *   cornerCases?: string[],
 *   securityRisks?: string[],
 *   uxRisks?: string[],
 *   blockingQuestions?: string[],
 *   recommendedDecisions?: string[],
 *   unverifiedItems?: string[]
 * }} critique
 * @param {{ taskId: string, iterationNumber?: number }} options
 * @returns {GrillResult}
 */
export function createGrillResult(critique, options) {
  const { taskId, iterationNumber = 0 } = options;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('createGrillResult: taskId must be a non-empty string');
  }

  const assumptions = normalizeStringList(critique?.assumptions);
  const missingRequirements = normalizeStringList(critique?.missingRequirements);
  const edgeCases = normalizeStringList(critique?.edgeCases);
  const cornerCases = normalizeStringList(critique?.cornerCases);
  const securityRisks = normalizeStringList(critique?.securityRisks);
  const uxRisks = normalizeStringList(critique?.uxRisks);
  const blockingQuestions = normalizeStringList(critique?.blockingQuestions);
  const recommendedDecisions = normalizeStringList(critique?.recommendedDecisions);
  const unverifiedItems = normalizeUnverifiedList(critique?.unverifiedItems);

  // Derived aggregate — @see securityRisks, uxRisks for per-category access
  const risks = [...securityRisks, ...uxRisks];

  return {
    taskId,
    mode: 'grill',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    assumptions,
    missingRequirements,
    edgeCases,
    cornerCases,
    securityRisks,
    uxRisks,
    blockingQuestions,
    recommendedDecisions,
    unverifiedItems,
    risks,
    revisionsRequested: typeof iterationNumber === 'number' ? iterationNumber : 0,
  };
}

/**
 * Creates a typed CritiqueResult artifact.
 *
 * Two-revision fold: when `iterationNumber >= 2` and the supplied verdict is
 * `REQUEST_REVISION:<reason>`, the revision reason is folded into
 * `backwardsCompatRisks` and the verdict is coerced to `APPROVE_PLAN`.
 * @param {{
 *   missingAcceptanceCriteria?: string[],
 *   missingTests?: string[],
 *   riskySequencing?: string[],
 *   unlistedFiles?: string[],
 *   backwardsCompatRisks?: string[],
 *   rollbackRisk?: string,
 *   verdict?: string
 * }} critique
 * @param {{ taskId: string, iterationNumber?: number }} options
 * @returns {CritiqueResult}
 */
export function createCritiqueResult(critique, options) {
  const { taskId, iterationNumber = 0 } = options;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('createCritiqueResult: taskId must be a non-empty string');
  }

  const missingAcceptanceCriteria = normalizeStringList(critique?.missingAcceptanceCriteria);
  const missingTests = normalizeStringList(critique?.missingTests);
  const riskySequencing = normalizeStringList(critique?.riskySequencing);
  const unlistedFiles = normalizeStringList(critique?.unlistedFiles);
  // Default to 'unknown' so a builder-produced artifact always satisfies the
  // wired validator (contracts.mjs requires a non-empty rollbackRisk).
  const rawRollbackRisk = typeof critique?.rollbackRisk === 'string' ? critique.rollbackRisk.trim() : '';
  const rollbackRisk = rawRollbackRisk === '' ? 'unknown' : rawRollbackRisk;
  const rawVerdict = typeof critique?.verdict === 'string' ? critique.verdict.trim() : 'APPROVE_PLAN';

  /** @type {string[]} */
  const backwardsCompatRisks = normalizeStringList(critique?.backwardsCompatRisks);

  const effectiveIterationNumber = typeof iterationNumber === 'number' ? iterationNumber : 0;

  /** @type {'APPROVE_PLAN' | `REQUEST_REVISION:${string}`} */
  let verdict;

  if (effectiveIterationNumber >= 2 && rawVerdict.startsWith('REQUEST_REVISION:')) {
    // Two-revision fold: fold the blocking reason into backwardsCompatRisks and proceed.
    const reason = rawVerdict.slice('REQUEST_REVISION:'.length).trim();
    if (reason !== '') {
      backwardsCompatRisks.push(`[FOLDED] ${reason}`);
    }
    verdict = 'APPROVE_PLAN';
  } else if (rawVerdict === 'APPROVE_PLAN' || rawVerdict.startsWith('REQUEST_REVISION:')) {
    verdict = /** @type {'APPROVE_PLAN' | `REQUEST_REVISION:${string}`} */ (rawVerdict);
  } else {
    verdict = 'APPROVE_PLAN';
  }

  return {
    taskId,
    mode: 'critique',
    schemaVersion: 1,
    returnedAt: new Date().toISOString(),
    missingAcceptanceCriteria,
    missingTests,
    riskySequencing,
    unlistedFiles,
    backwardsCompatRisks,
    rollbackRisk,
    verdict,
    revisionsRequested: effectiveIterationNumber,
  };
}

/**
 * Asserts that a rubber-duck dispatch input has all required fields.
 * Throws a `TypeError` if validation fails.
 * @param {unknown} input
 * @returns {void}
 */
export function assertRubberDuckDispatchInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('rubber-duck dispatch input must be an object');
  }

  const record = /** @type {Record<string, unknown>} */ (input);

  if (!VALID_MODES.has(String(record.mode))) {
    throw new TypeError(
      `rubber-duck dispatch input: mode must be "grill" or "critique", got "${String(record.mode)}"`,
    );
  }
  if (typeof record.taskId !== 'string' || record.taskId.trim() === '') {
    throw new TypeError('rubber-duck dispatch input: taskId must be a non-empty string');
  }

  if (record.mode === 'grill') {
    const hasRequest = typeof record.request === 'string' && record.request.trim() !== '';
    const hasPointer = typeof record.discoveryPointer === 'string' && record.discoveryPointer.trim() !== '';
    if (!hasRequest && !hasPointer) {
      throw new TypeError(
        'rubber-duck dispatch input (grill): request or discoveryPointer is required',
      );
    }
  }

  if (record.mode === 'critique') {
    if (typeof record.planPointer !== 'string' || record.planPointer.trim() === '') {
      throw new TypeError('rubber-duck dispatch input (critique): planPointer is required');
    }
  }
}

/**
 * Persists a CritiqueResult artifact to disk and records its hash in task.json.
 * @param {CritiqueResult} artifact
 * @param {{ taskId: string, repoRoot?: string, statePath?: string }} options
 * @returns {Promise<{ path: string, artifact: CritiqueResult }>}
 */
export async function writeCritiqueArtifact(artifact, options) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const path = resolveSessionArtifactPath(options.taskId, CRITIQUE_FILENAME, repoRoot);

  const verdict = validateCritiqueResult(artifact);
  if (!verdict.ok) {
    throw new Error(`rubber-duck: invalid critique artifact: ${verdict.errors.join('; ')}`);
  }

  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  ensureDirSync(dirname(path));
  writeTextFileSync(path, content);

  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  await recordArtifactHash('critique', digest, path, { statePath: options.statePath });

  return { path, artifact };
}
