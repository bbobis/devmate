// @ts-check
// E4-8: worker return contracts (TCM-10). Sub-agents (workers) run in isolated
// contexts and hand results back to the orchestrator. If a worker returns its
// full transcript or raw tool log, the orchestrator's context bloats with noise
// proportional to the worker's entire run — not just its result. This module
// defines the canonical WorkerReturn contract (finding + source pointer +
// confidence + artifact written + next step + token notes), a validator that
// rejects raw transcripts, and a builder that assembles compliant returns.
//
// The debugMode escape hatch is intentionally narrow: rawTranscriptPath may be
// set ONLY when debugMode === true, and is always null in production paths.

import { isNonEmptyString } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').EvidencePointer} EvidencePointer */
/** @typedef {import('../types.mjs').WorkerReturn} WorkerReturn */

/** Max length of the `finding` field. */
const FINDING_MAX = 500;
/** Max length of the `nextRecommendedStep` field. */
const NEXT_STEP_MAX = 200;

/**
 * Error thrown when a WorkerReturn fails validation. Carries every violation.
 */
export class WorkerContractError extends Error {
  /** @param {string[]} violations */
  constructor(violations) {
    super(`WorkerReturn contract violated: ${violations.join('; ')}`);
    this.name = 'WorkerContractError';
    this.code = 'WORKER_CONTRACT_VIOLATION';
    /** @type {string[]} */
    this.violations = violations;
  }
}

/**
 * Validate the sourcePointer sub-object, returning a list of field-level errors.
 * @param {unknown} ptr
 * @returns {string[]}
 */
function validateSourcePointer(ptr) {
  /** @type {string[]} */
  const errors = [];
  if (ptr === null || typeof ptr !== 'object') {
    errors.push('sourcePointer must be an object');
    return errors;
  }
  const p = /** @type {Record<string, unknown>} */ (ptr);
  if (typeof p['path'] !== 'string' || p['path'].trim() === '') {
    errors.push('sourcePointer.path must be a non-empty string');
  }
  if (typeof p['reason'] !== 'string' || p['reason'].trim() === '') {
    errors.push('sourcePointer.reason must be a non-empty string');
  }
  if (typeof p['confidence'] !== 'number' || p['confidence'] < 0 || p['confidence'] > 1) {
    errors.push('sourcePointer.confidence must be a number in [0.0, 1.0]');
  }
  if (typeof p['freshness'] !== 'string' || p['freshness'].trim() === '') {
    errors.push('sourcePointer.freshness must be a non-empty string');
  }
  return errors;
}

/**
 * Validate a WorkerReturn. Collects every violation (no short-circuit).
 * @param {unknown} ret
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorkerReturn(ret) {
  /** @type {string[]} */
  const errors = [];

  if (ret === null || typeof ret !== 'object') {
    return { ok: false, errors: ['WorkerReturn must be an object'] };
  }
  const r = /** @type {Record<string, unknown>} */ (ret);

  if (typeof r['workerId'] !== 'string' || r['workerId'].trim() === '') {
    errors.push('workerId must be a non-empty string');
  }

  if (typeof r['finding'] !== 'string') {
    errors.push('finding must be a string');
  } else if (r['finding'].length > FINDING_MAX) {
    errors.push(`finding exceeds ${FINDING_MAX} chars (got ${r['finding'].length})`);
  }

  if (typeof r['nextRecommendedStep'] !== 'string') {
    errors.push('nextRecommendedStep must be a string');
  } else if (r['nextRecommendedStep'].length > NEXT_STEP_MAX) {
    errors.push(`nextRecommendedStep exceeds ${NEXT_STEP_MAX} chars (got ${r['nextRecommendedStep'].length})`);
  }

  if (typeof r['confidence'] !== 'number' || r['confidence'] < 0 || r['confidence'] > 1) {
    errors.push('confidence must be a number in [0.0, 1.0]');
  }

  if (!isNonEmptyString(r['tokenNotes'])) {
    errors.push('tokenNotes must be a non-empty string');
  }

  if (!(r['artifactWritten'] === null || typeof r['artifactWritten'] === 'string')) {
    errors.push('artifactWritten must be a string or null');
  }

  if (typeof r['debugMode'] !== 'boolean') {
    errors.push('debugMode must be a boolean');
  }

  // Hard rule: rawTranscriptPath MUST be null when debugMode is false.
  if (r['debugMode'] === false && r['rawTranscriptPath'] !== null) {
    errors.push('rawTranscriptPath must be null when debugMode=false');
  }

  if (typeof r['returnedAt'] !== 'string' || r['returnedAt'].trim() === '') {
    errors.push('returnedAt must be a non-empty string');
  }

  errors.push(...validateSourcePointer(r['sourcePointer']));

  return { ok: errors.length === 0, errors };
}

/**
 * Serialize a WorkerReturn to a compact JSON string (no whitespace) so it can
 * be embedded in a trace entry without inflating context.
 * @param {WorkerReturn} ret
 * @returns {string}
 */
export function serializeWorkerReturn(ret) {
  return JSON.stringify(ret);
}

/**
 * Builder for constructing WorkerReturn objects with inline + final validation.
 */
export class WorkerReturnBuilder {
  /** @param {string} workerId */
  constructor(workerId) {
    /** @type {string} */
    this.workerId = workerId;
    /** @type {string|undefined} */
    this.finding = undefined;
    /** @type {EvidencePointer|undefined} */
    this.sourcePointer = undefined;
    /** @type {number|undefined} */
    this.confidence = undefined;
    /** @type {string|null} */
    this.artifactWritten = null;
    /** @type {string|undefined} */
    this.nextRecommendedStep = undefined;
    /** @type {string|undefined} */
    this.tokenNotes = undefined;
    /** @type {boolean} */
    this.debugMode = false;
    /** @type {string|null} */
    this.rawTranscriptPath = null;
    /** @type {string} */
    this.returnedAt = new Date().toISOString();
  }

  /** @param {string} finding @returns {this} */
  setFinding(finding) {
    this.finding = finding;
    return this;
  }

  /** @param {EvidencePointer} ptr @returns {this} */
  setSourcePointer(ptr) {
    this.sourcePointer = ptr;
    return this;
  }

  /** @param {number} confidence @returns {this} */
  setConfidence(confidence) {
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw new TypeError('confidence must be a number in [0.0, 1.0]');
    }
    this.confidence = confidence;
    return this;
  }

  /** @param {string|null} path @returns {this} */
  setArtifactWritten(path) {
    this.artifactWritten = path;
    return this;
  }

  /** @param {string} step @returns {this} */
  setNextStep(step) {
    this.nextRecommendedStep = step;
    return this;
  }

  /** @param {string} notes @returns {this} */
  setTokenNotes(notes) {
    this.tokenNotes = notes;
    return this;
  }

  /**
   * Set debug mode. When debug is false, rawTranscriptPath is forced to null
   * regardless of the supplied path.
   * @param {boolean} debug
   * @param {string|null} [transcriptPath]
   * @returns {this}
   */
  setDebugMode(debug, transcriptPath = null) {
    this.debugMode = debug;
    this.rawTranscriptPath = debug ? transcriptPath : null;
    return this;
  }

  /**
   * Build and validate. Throws WorkerContractError listing all violations.
   * @returns {WorkerReturn}
   */
  build() {
    /** @type {WorkerReturn} */
    const ret = {
      workerId: this.workerId,
      finding: /** @type {string} */ (this.finding),
      sourcePointer: /** @type {EvidencePointer} */ (this.sourcePointer),
      confidence: /** @type {number} */ (this.confidence),
      artifactWritten: this.artifactWritten,
      nextRecommendedStep: /** @type {string} */ (this.nextRecommendedStep),
      tokenNotes: /** @type {string} */ (this.tokenNotes),
      debugMode: this.debugMode,
      rawTranscriptPath: this.rawTranscriptPath,
      returnedAt: this.returnedAt,
    };
    const { ok, errors } = validateWorkerReturn(ret);
    if (!ok) throw new WorkerContractError(errors);
    return ret;
  }
}
