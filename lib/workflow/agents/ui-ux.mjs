// @ts-check
import { dirname, resolve } from 'node:path';
import {
  ensureDirSync,
  readTextFileSync,
  writeTextFileSync,
} from '../../fs-safe.mjs';

/**
 * @typedef {{
 *   screens: string[],
 *   interactions: string[],
 *   errorStates: string[],
 *   components: string[],
 *   unverified: string[]
 * }} UiBriefArtifact
 */

const SESSION_DIR = '.devmate/session';
const UI_BRIEF_FILENAME = 'ui-brief.json';

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
 * Build normalized list and collect speculative entries in unverified.
 * @param {unknown} value
 * @param {string[]} unverifiedSink
 * @returns {string[]}
 */
function normalizeUiList(value, unverifiedSink) {
  const normalizedItems = normalizeStringList(value);

  /** @type {string[]} */
  const output = [];
  for (const item of normalizedItems) {
    if (item.startsWith('[UNVERIFIED]')) {
      const normalized = normalizeUnverifiedItem(item);
      if (normalized !== '') {
        output.push(normalized);
        unverifiedSink.push(normalized);
      }
      continue;
    }
    output.push(item);
  }
  return output;
}

/**
 * Creates a UI brief artifact for frontend implementation.
 * @param {{ featureDescription: string, planArtifact?: object }} inputs
 * @returns {{ screens: string[], interactions: string[], errorStates: string[], components: string[], unverified: string[] }}
 */
export function createUiBriefArtifact(inputs) {
  const source = inputs?.planArtifact && typeof inputs.planArtifact === 'object'
    ? /** @type {Record<string, unknown>} */ (inputs.planArtifact)
    : {};

  /** @type {string[]} */
  const unverified = [];

  const screens = normalizeUiList(source.screens, unverified);
  const interactions = normalizeUiList(source.interactions, unverified);
  const errorStates = normalizeUiList(source.errorStates, unverified);
  const components = normalizeUiList(source.components, unverified);

  const explicitUnverified = normalizeStringList(source.unverified);
  for (const item of explicitUnverified) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized !== '') {
      unverified.push(normalized);
    }
  }

  const dedupedUnverified = Array.from(new Set(unverified));

  return {
    screens,
    interactions,
    errorStates,
    components,
    unverified: dedupedUnverified,
  };
}

/**
 * Validates a UI brief artifact has required sections.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateUiBriefArtifact(artifact) {
  /** @type {string[]} */
  const errors = [];

  if (artifact === null || typeof artifact !== 'object') {
    return { ok: false, errors: ['artifact must be an object'] };
  }

  const record = /** @type {Record<string, unknown>} */ (artifact);
  const screens = record.screens;
  const interactions = record.interactions;
  const errorStates = record.errorStates;
  const components = record.components;
  const unverified = record.unverified;

  if (!Array.isArray(screens)) {
    errors.push('screens must be an array');
  }
  if (!Array.isArray(interactions)) {
    errors.push('interactions must be an array');
  }
  if (!Array.isArray(errorStates)) {
    errors.push('errorStates must be an array');
  }
  if (!Array.isArray(components)) {
    errors.push('components must be an array');
  }
  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  }

  /**
   * @param {unknown} value
   * @param {string} field
   */
  function validateUiField(value, field) {
    if (!Array.isArray(value)) return;
    for (const [i, item] of value.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`${field}[${i}] must be a non-empty string`);
      }
    }
  }

  validateUiField(screens, 'screens');
  validateUiField(interactions, 'interactions');
  validateUiField(errorStates, 'errorStates');
  validateUiField(components, 'components');

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

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve UI brief artifact path for one task.
 * @param {string} taskId
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveUiBriefPath(taskId, repoRoot) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new TypeError('taskId must be a non-empty string');
  }
  return resolve(repoRoot, SESSION_DIR, taskId, UI_BRIEF_FILENAME);
}

/**
 * Writes a validated UiBriefArtifact to .devmate/session/{taskId}/ui-brief.json.
 * @param {string} taskId
 * @param {UiBriefArtifact} artifact
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ path: string }>}
 */
export async function writeUiBriefArtifact(taskId, artifact, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveUiBriefPath(taskId, repoRoot);

  const verdict = validateUiBriefArtifact(artifact);
  if (!verdict.ok) {
    throw new Error(`invalid UiBriefArtifact: ${verdict.errors.join('; ')}`);
  }

  ensureDirSync(dirname(path));
  writeTextFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path };
}

/**
 * Reads and parses the UI brief artifact for a given task session.
 * @param {string} taskId
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<UiBriefArtifact>}
 */
export async function readUiBriefArtifact(taskId, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveUiBriefPath(taskId, repoRoot);
  try {
    const content = readTextFileSync(path);
    return /** @type {UiBriefArtifact} */ (JSON.parse(content));
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      /** @type {{ code?: unknown }} */ (err).code === 'ENOENT'
    ) {
      throw new Error(`ui-ux artifact not found at ${path}`);
    }
    throw err;
  }
}

/**
 * Create, validate, and persist a UI brief artifact for one task.
 * @param {string} taskId
 * @param {{ featureDescription: string, planArtifact?: object }} inputs
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ artifact: UiBriefArtifact, path: string }>}
 */
export async function persistUiBriefArtifact(taskId, inputs, opts = {}) {
  const artifact = createUiBriefArtifact(inputs);
  const result = await writeUiBriefArtifact(taskId, artifact, opts);
  return { artifact, path: result.path };
}
