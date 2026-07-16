// @ts-check
import { isString } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').LoopEventType} LoopEventType */
/** @typedef {import('../types.mjs').AnyLoopEvent} AnyLoopEvent */
/** @typedef {import('../types.mjs').LoopAttemptEvent} LoopAttemptEvent */
/** @typedef {import('../types.mjs').LoopHaltEvent} LoopHaltEvent */
/** @typedef {import('../types.mjs').LoopStepCompleteEvent} LoopStepCompleteEvent */
/** @typedef {import('../types.mjs').TraceFileResult} TraceFileResult */
/** @typedef {import('../types.mjs').CorruptedLine} CorruptedLine */

import { pathExists, readTextFileSync } from '../fs-safe.mjs';

/**
 * Current schema version. Increment on breaking changes.
 * @type {number}
 */
export const SCHEMA_VERSION = 1;

/** @type {readonly LoopEventType[]} */
const KNOWN_TYPES = ['loop_attempt', 'loop_halt', 'step_complete'];

/**
 * Validate a raw parsed object against the loop trace schema.
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTraceEvent(obj) {
  const errors = [];

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['Event must be a non-null object'] };
  }

  const e = /** @type {Record<string, unknown>} */ (obj);

  if (e['schemaVersion'] !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal ${SCHEMA_VERSION} (got: ${JSON.stringify(e['schemaVersion'])})`);
  }

  if (!KNOWN_TYPES.includes(/** @type {LoopEventType} */ (e['type']))) {
    errors.push(`type must be one of: ${KNOWN_TYPES.join(', ')} (got: ${JSON.stringify(e['type'])})`);
  }

  if (typeof e['attemptId'] !== 'string' || e['attemptId'].trim() === '') {
    errors.push('attemptId must be a non-empty string');
  }

  if (typeof e['taskId'] !== 'string' || e['taskId'].trim() === '') {
    errors.push('taskId must be a non-empty string');
  }

  if (typeof e['ts'] !== 'string' || e['ts'].trim() === '') {
    errors.push('ts must be a non-empty string (ISO-8601)');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const type = /** @type {LoopEventType} */ (e['type']);

  if (type === 'loop_attempt') {
    const typeErrors = _validateLoopAttempt(e);
    if (typeErrors.length > 0) return { ok: false, errors: typeErrors };
  } else if (type === 'loop_halt') {
    const typeErrors = _validateLoopHalt(e);
    if (typeErrors.length > 0) return { ok: false, errors: typeErrors };
  } else if (type === 'step_complete') {
    const typeErrors = _validateStepComplete(e);
    if (typeErrors.length > 0) return { ok: false, errors: typeErrors };
  }

  return { ok: true, errors: [] };
}

/**
 * @param {Record<string, unknown>} e
 * @returns {string[]}
 */
function _validateLoopAttempt(e) {
  const errors = [];
  if (typeof e['tier'] !== 'number') errors.push('loop_attempt: tier must be a number');
  if (!Array.isArray(e['command']) || !e['command'].every((v) => typeof v === 'string')) {
    errors.push('loop_attempt: command must be a string[]');
  }
  if (typeof e['exitCode'] !== 'number') errors.push('loop_attempt: exitCode must be a number');
  if (!isString(e['outputDigest'])) errors.push('loop_attempt: outputDigest must be a string');
  if (typeof e['fullOutputPath'] !== 'string') errors.push('loop_attempt: fullOutputPath must be a string');
  return errors;
}

/**
 * @param {Record<string, unknown>} e
 * @returns {string[]}
 */
function _validateLoopHalt(e) {
  const errors = [];
  if (typeof e['reason'] !== 'string') errors.push('loop_halt: reason must be a string');
  if (typeof e['lastError'] !== 'string') errors.push('loop_halt: lastError must be a string');
  if (e['priorAttemptId'] !== null && typeof e['priorAttemptId'] !== 'string') {
    errors.push('loop_halt: priorAttemptId must be a string or null');
  }
  return errors;
}

/**
 * @param {Record<string, unknown>} e
 * @returns {string[]}
 */
function _validateStepComplete(e) {
  const errors = [];
  if (typeof e['stepLabel'] !== 'string') errors.push('step_complete: stepLabel must be a string');
  if (!Array.isArray(e['artifactPaths']) || !e['artifactPaths'].every((v) => typeof v === 'string')) {
    errors.push('step_complete: artifactPaths must be a string[]');
  }
  return errors;
}

/**
 * Return a JSON Schema (draft-07) object describing AnyLoopEvent.
 * @returns {object}
 */
export function generateJsonSchema() {
  /** @type {Record<string, object>} */
  const baseProps = {
    schemaVersion: { type: 'number', const: SCHEMA_VERSION },
    type: { type: 'string', enum: KNOWN_TYPES },
    attemptId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    ts: { type: 'string', minLength: 1 },
  };
  const baseRequired = ['schemaVersion', 'type', 'attemptId', 'taskId', 'ts'];

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'AnyLoopEvent',
    description: 'A single line in a loop trace JSONL file.',
    oneOf: [
      {
        description: 'LoopAttemptEvent',
        type: 'object',
        required: [...baseRequired, 'tier', 'command', 'exitCode', 'outputDigest', 'fullOutputPath'],
        properties: {
          ...baseProps,
          type: { type: 'string', const: 'loop_attempt' },
          tier: { type: 'number' },
          command: { type: 'array', items: { type: 'string' } },
          exitCode: { type: 'number' },
          outputDigest: { type: 'string' },
          fullOutputPath: { type: 'string' },
        },
        additionalProperties: true,
      },
      {
        description: 'LoopHaltEvent',
        type: 'object',
        required: [...baseRequired, 'reason', 'lastError', 'priorAttemptId'],
        properties: {
          ...baseProps,
          type: { type: 'string', const: 'loop_halt' },
          reason: { type: 'string' },
          lastError: { type: 'string' },
          priorAttemptId: { type: ['string', 'null'] },
        },
        additionalProperties: true,
      },
      {
        description: 'LoopStepCompleteEvent',
        type: 'object',
        required: [...baseRequired, 'stepLabel', 'artifactPaths'],
        properties: {
          ...baseProps,
          type: { type: 'string', const: 'step_complete' },
          stepLabel: { type: 'string' },
          artifactPaths: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
    ],
  };
}

/**
 * Read and parse a JSONL trace file. Corrupted lines are reported, not thrown.
 * @param {string} filePath
 * @returns {TraceFileResult}
 */
export function readTraceFile(filePath) {
  /** @type {AnyLoopEvent[]} */
  const events = [];
  /** @type {CorruptedLine[]} */
  const corruptedLines = [];

  if (!pathExists(filePath)) {
    return { events, corruptedLines };
  }

  const raw = readTextFileSync(filePath);
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      corruptedLines.push({ lineNum: i + 1, raw: lines[i], error: `JSON parse error: ${msg}` });
      continue;
    }

    const result = validateTraceEvent(parsed);
    if (!result.ok) {
      corruptedLines.push({ lineNum: i + 1, raw: lines[i], error: result.errors.join('; ') });
      continue;
    }

    events.push(/** @type {AnyLoopEvent} */ (parsed));
  }

  return { events, corruptedLines };
}
