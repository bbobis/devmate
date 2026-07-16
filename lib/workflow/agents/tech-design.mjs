// @ts-check
import { dirname, resolve } from 'node:path';
import {
  ensureDirSync,
  readTextFileSync,
  writeTextFileSync,
} from '../../fs-safe.mjs';

/**
 * @typedef {{
 *   name: string,
 *   method: string,
 *   path: string,
 *   purpose: string,
 *   confidence: 'high' | 'low'
 * }} TechDesignApi
 */

/**
 * @typedef {{
 *   dataModel: Record<string, unknown>,
 *   apiContracts: TechDesignApi[],
 *   layerBoundaries: string[],
 *   assumptions: string[],
 *   risks: string[],
 *   unverified: string[]
 * }} TechDesignArtifact
 */

/** @type {ReadonlySet<string>} */
const VALID_CONFIDENCE = new Set(['high', 'low']);

/** @type {ReadonlyMap<string, 'high' | 'low'>} */
const CONFIDENCE_LOOKUP = new Map([
  ['high', 'high'],
  ['low', 'low'],
]);

const SESSION_DIR = '.devmate/session';
const DESIGN_FILENAME = 'design.json';

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
 * Build normalized API contracts with deterministic defaults.
 * @param {unknown} apis
 * @returns {TechDesignApi[]}
 */
function normalizeApiContracts(apis) {
  if (!Array.isArray(apis)) return [];

  /** @type {TechDesignApi[]} */
  const normalized = [];
  for (const api of apis) {
    if (api === null || typeof api !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (api);

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const method = typeof record.method === 'string' ? record.method.trim() : '';
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
    const confidenceRaw = typeof record.confidence === 'string' ? record.confidence.toLowerCase().trim() : 'high';
    const confidence = CONFIDENCE_LOOKUP.get(confidenceRaw) ?? 'high';

    normalized.push({ name, method, path, purpose, confidence });
  }
  return normalized;
}

/**
 * Check whether a value is a non-array object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (!value) return false;
  if (Array.isArray(value)) return false;
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Create a typed tech-design artifact with API contracts and layer boundaries.
 * At least one of `dataModel` or `apiContracts` should be non-empty so
 * `assertDispatchResult('tech-design', { status: 'ok', payload })` can pass.
 * @param {{
 *   dataModel?: Record<string, unknown>,
 *   apiContracts?: object[],
 *   layerBoundaries?: string[],
 *   assumptions?: string[],
 *   risks?: string[]
 * }} design
 * @returns {TechDesignArtifact}
 */
export function createTechDesignArtifact(design) {
  const rawDataModel = design?.dataModel;
  const dataModelValue = isPlainObject(rawDataModel) ? /** @type {Record<string, unknown>} */ (rawDataModel) : {};

  const apiContracts = normalizeApiContracts(design?.apiContracts);
  const layerBoundaries = normalizeStringList(design?.layerBoundaries);
  const assumptionsRaw = normalizeStringList(design?.assumptions);
  const risksRaw = normalizeStringList(design?.risks);

  /** @type {string[]} */
  const assumptions = [];
  /** @type {string[]} */
  const risks = [];
  /** @type {string[]} */
  const unverified = [];

  for (const item of assumptionsRaw) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized === '') continue;
    assumptions.push(normalized);
    unverified.push(normalized);
  }

  for (const item of risksRaw) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized === '') continue;
    risks.push(normalized);
    unverified.push(normalized);
  }

  return {
    dataModel: dataModelValue,
    apiContracts,
    layerBoundaries,
    assumptions,
    risks,
    unverified,
  };
}

/**
 * Validate tech-design artifact structural integrity.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTechDesignArtifact(artifact) {
  /** @type {string[]} */
  const errors = [];

  if (artifact === null || typeof artifact !== 'object') {
    return { ok: false, errors: ['artifact must be an object'] };
  }

  const record = /** @type {Record<string, unknown>} */ (artifact);
  const dataModel = record.dataModel;
  const apiContracts = record.apiContracts;
  const layerBoundaries = record.layerBoundaries;
  const assumptions = record.assumptions;
  const risks = record.risks;
  const unverified = record.unverified;

  const hasObjectDataModel = isPlainObject(dataModel);
  if (!hasObjectDataModel) {
    errors.push('dataModel must be an object');
  }

  if (!Array.isArray(apiContracts)) {
    errors.push('apiContracts must be an array');
  }

  if (!Array.isArray(layerBoundaries)) {
    errors.push('layerBoundaries must be an array');
  }

  if (!Array.isArray(assumptions)) {
    errors.push('assumptions must be an array');
  }

  if (!Array.isArray(risks)) {
    errors.push('risks must be an array');
  }

  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  }

  let validApiContracts = 0;
  if (Array.isArray(apiContracts)) {
    for (const [i, api] of apiContracts.entries()) {
      if (api === null || typeof api !== 'object') {
        errors.push(`apiContracts[${i}] must be an object`);
        continue;
      }

      const apiRecord = /** @type {Record<string, unknown>} */ (api);
      const name = apiRecord.name;
      const method = apiRecord.method;
      const path = apiRecord.path;
      const purpose = apiRecord.purpose;
      const confidence = apiRecord.confidence;

      const validName = typeof name === 'string' && name.trim() !== '';
      const validMethod = typeof method === 'string' && method.trim() !== '';
      const validPath = typeof path === 'string' && path.trim() !== '';
      const validPurpose = typeof purpose === 'string' && purpose.trim() !== '';
      const validConfidence = typeof confidence === 'string' && VALID_CONFIDENCE.has(confidence);

      if (!validName) {
        errors.push(`apiContracts[${i}].name must be a non-empty string`);
      }
      if (!validMethod) {
        errors.push(`apiContracts[${i}].method must be a non-empty string`);
      }
      if (!validPath) {
        errors.push(`apiContracts[${i}].path must be a non-empty string`);
      }
      if (!validPurpose) {
        errors.push(`apiContracts[${i}].purpose must be a non-empty string`);
      }
      if (!validConfidence) {
        errors.push(`apiContracts[${i}].confidence must be 'high' or 'low'`);
      }

      if (validName && validMethod && validPath && validPurpose && validConfidence) {
        validApiContracts += 1;
      }
    }
  }

  if (Array.isArray(layerBoundaries)) {
    for (const [i, item] of layerBoundaries.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`layerBoundaries[${i}] must be a non-empty string`);
      }
    }
  }

  if (Array.isArray(assumptions)) {
    for (const [i, item] of assumptions.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`assumptions[${i}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`assumptions[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  if (Array.isArray(risks)) {
    for (const [i, item] of risks.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`risks[${i}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`risks[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  if (Array.isArray(unverified)) {
    for (const [i, item] of unverified.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`unverified[${i}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`unverified[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  const dataModelRecord = hasObjectDataModel ? /** @type {Record<string, unknown>} */ (dataModel) : {};
  const hasDataModel = Object.keys(dataModelRecord).length > 0;
  const hasApiContracts = validApiContracts > 0;
  if (!hasDataModel && !hasApiContracts) {
    errors.push('at least one of dataModel or apiContracts must be present');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve design artifact path for one task.
 * @param {string} taskId
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveDesignPath(taskId, repoRoot) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('taskId must be a non-empty string');
  }
  return resolve(repoRoot, SESSION_DIR, taskId, DESIGN_FILENAME);
}

/**
 * Writes a validated TechDesignArtifact to .devmate/session/{taskId}/design.json.
 * @param {string} taskId - The current task session ID.
 * @param {TechDesignArtifact} artifact - Candidate tech-design artifact.
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ path: string }>} Resolved path of the written file.
 */
export async function writeDesignArtifact(taskId, artifact, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveDesignPath(taskId, repoRoot);

  const verdict = validateTechDesignArtifact(artifact);
  if (!verdict.ok) {
    throw new Error(`invalid TechDesignArtifact: ${verdict.errors.join('; ')}`);
  }

  ensureDirSync(dirname(path));
  writeTextFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path };
}

/**
 * Reads and parses the design artifact for a given task session.
 * @param {string} taskId
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<TechDesignArtifact>}
 */
export async function readDesignArtifact(taskId, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveDesignPath(taskId, repoRoot);
  try {
    const content = readTextFileSync(path);
    return /** @type {TechDesignArtifact} */ (JSON.parse(content));
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      /** @type {{ code?: unknown }} */ (err).code === 'ENOENT'
    ) {
      throw new Error(`design artifact not found at ${path}`);
    }
    throw err;
  }
}

/**
 * Create, validate, and persist a tech-design artifact for one task.
 * @param {string} taskId
 * @param {{
 *   dataModel?: Record<string, unknown>,
 *   apiContracts?: object[],
 *   layerBoundaries?: string[],
 *   assumptions?: string[],
 *   risks?: string[]
 * }} design
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ artifact: TechDesignArtifact, path: string }>}
 */
export async function persistTechDesignArtifact(taskId, design, opts = {}) {
  const artifact = createTechDesignArtifact(design);
  const result = await writeDesignArtifact(taskId, artifact, opts);
  return { artifact, path: result.path };
}