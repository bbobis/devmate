// @ts-check
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  ensureDirSync,
  readTextFileSync,
  writeTextFileSync,
} from '../../fs-safe.mjs';
import { recordArtifactHash } from '../../task-state.mjs';
import { readDesignArtifact, validateTechDesignArtifact } from './tech-design.mjs';

/**
 * @typedef {{
 *   description: string,
 *   ac: string[],
 *   tddApproach: string,
 *   persona: string,
 *   files: string[]
 * }} PlannerTask
 */

/**
 * @typedef {{
 *   tasks: PlannerTask[],
 *   assumptions: string[],
 *   openRisks: string[],
 *   unverified: string[]
 * }} PlannerArtifact
 */

const SESSION_DIR = '.devmate/session';
const DESIGN_FILENAME = 'design.json';
const PLAN_FILENAME = 'plan.json';

/**
 * Resolve one session artifact path for one task.
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

/**
 * Reads the validated design artifact and records its digest in task.json.
 * @param {string} taskId
 * @param {{ repoRoot?: string, statePath?: string }} [opts]
 * @returns {Promise<{ artifact: import('./tech-design.mjs').TechDesignArtifact, path: string, designDigest: string }>}
 */
export async function readAndRecordDesign(taskId, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const path = resolveSessionArtifactPath(taskId, DESIGN_FILENAME, repoRoot);

  let artifact;
  try {
    artifact = await readDesignArtifact(taskId, { repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`planner: unable to read design artifact: ${message}`);
  }

  const verdict = validateTechDesignArtifact(artifact);
  if (!verdict.ok) {
    throw new Error(`planner: design artifact failed validation: ${verdict.errors.join('; ')}`);
  }

  const designContent = readTextFileSync(path);
  const designDigest = createHash('sha256').update(designContent, 'utf8').digest('hex');
  await recordArtifactHash('design', designDigest, path, { statePath: opts.statePath });

  return { artifact, path, designDigest };
}

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
 * Build normalized tasks with deterministic defaults.
 * @param {unknown} taskList
 * @returns {PlannerTask[]}
 */
function normalizeTasks(taskList) {
  if (!Array.isArray(taskList)) return [];

  /** @type {PlannerTask[]} */
  const normalized = [];
  for (const task of taskList) {
    if (task === null || typeof task !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (task);

    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const tddApproach = typeof record.tddApproach === 'string' ? record.tddApproach.trim() : '';
    const persona = typeof record.persona === 'string' ? record.persona.trim() : '';
    const ac = normalizeStringList(record.ac);
    const files = normalizeStringList(record.files);

    normalized.push({ description, ac, tddApproach, persona, files });
  }
  return normalized;
}

/**
 * Create a typed planner artifact with tasks, assumptions, and open risks.
 * Each task includes acceptance criteria and TDD approach mapping.
 * @param {{
 *   tasks?: object[],
 *   assumptions?: string[],
 *   openRisks?: string[]
 * }} plan
 * @returns {PlannerArtifact}
 */
export function createPlannerArtifact(plan) {
  const tasks = normalizeTasks(plan?.tasks);
  const assumptionsRaw = normalizeStringList(plan?.assumptions);
  const openRisksRaw = normalizeStringList(plan?.openRisks);

  /** @type {string[]} */
  const assumptions = [];
  /** @type {string[]} */
  const openRisks = [];
  /** @type {string[]} */
  const unverified = [];

  for (const item of assumptionsRaw) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized === '') continue;
    assumptions.push(normalized);
    unverified.push(normalized);
  }

  for (const item of openRisksRaw) {
    const normalized = normalizeUnverifiedItem(item);
    if (normalized === '') continue;
    openRisks.push(normalized);
    unverified.push(normalized);
  }

  return {
    tasks,
    assumptions,
    openRisks,
    unverified,
  };
}

/**
 * Validate planner artifact structural integrity.
 * @param {unknown} artifact
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePlannerArtifact(artifact) {
  /** @type {string[]} */
  const errors = [];

  if (artifact === null || typeof artifact !== 'object') {
    return { ok: false, errors: ['artifact must be an object'] };
  }

  const record = /** @type {Record<string, unknown>} */ (artifact);
  const tasks = record.tasks;
  const assumptions = record.assumptions;
  const openRisks = record.openRisks;
  const unverified = record.unverified;

  if (!Array.isArray(tasks)) {
    errors.push('tasks must be an array');
  } else if (tasks.length === 0) {
    errors.push('tasks must be a non-empty array');
  } else {
    for (const [i, task] of tasks.entries()) {
      if (task === null || typeof task !== 'object') {
        errors.push(`tasks[${i}] must be an object`);
        continue;
      }

      const taskRecord = /** @type {Record<string, unknown>} */ (task);
      const description = taskRecord.description;
      const ac = taskRecord.ac;
      const tddApproach = taskRecord.tddApproach;
      const persona = taskRecord.persona;
      const files = taskRecord.files;

      const validDescription = typeof description === 'string' && description.trim() !== '';
      const validTddApproach = typeof tddApproach === 'string' && tddApproach.trim() !== '';
      const validPersona = typeof persona === 'string' && persona.trim() !== '';
      const validFiles = Array.isArray(files);

      if (!validDescription) {
        errors.push(`tasks[${i}].description must be a non-empty string`);
      }
      if (!validTddApproach) {
        errors.push(`tasks[${i}].tddApproach must be a non-empty string`);
      }
      if (!validPersona) {
        errors.push(`tasks[${i}].persona must be a non-empty string`);
      }
      if (!validFiles) {
        errors.push(`tasks[${i}].files must be an array`);
      }

      if (!Array.isArray(ac)) {
        errors.push(`tasks[${i}].ac must be an array`);
      } else if (ac.length === 0) {
        errors.push(`tasks[${i}].ac must be a non-empty array`);
      } else {
        for (const [j, criterion] of ac.entries()) {
          if (typeof criterion !== 'string' || criterion.trim() === '') {
            errors.push(`tasks[${i}].ac[${j}] must be a non-empty string`);
          }
        }
      }

      if (Array.isArray(files)) {
        for (const [j, file] of files.entries()) {
          if (typeof file !== 'string' || file.trim() === '') {
            errors.push(`tasks[${i}].files[${j}] must be a non-empty string`);
          }
        }
      }
    }
  }

  if (!Array.isArray(assumptions)) {
    errors.push('assumptions must be an array');
  } else {
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

  if (!Array.isArray(openRisks)) {
    errors.push('openRisks must be an array');
  } else {
    for (const [i, item] of openRisks.entries()) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`openRisks[${i}] must be a non-empty string`);
        continue;
      }
      if (!item.trim().startsWith('[UNVERIFIED]')) {
        errors.push(`openRisks[${i}] must start with [UNVERIFIED]`);
      }
    }
  }

  if (!Array.isArray(unverified)) {
    errors.push('unverified must be an array');
  } else {
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
 * Persists a plan artifact to disk and records its hash in task.json.
 * @param {PlannerArtifact} artifact
 * @param {{ taskId: string, repoRoot?: string, statePath?: string }} options
 * @returns {Promise<{ path: string, artifact: PlannerArtifact }>}
 */
export async function persistPlanArtifact(artifact, options) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const path = resolveSessionArtifactPath(options.taskId, PLAN_FILENAME, repoRoot);

  const verdict = validatePlannerArtifact(artifact);
  if (!verdict.ok) {
    throw new Error(`planner: invalid plan artifact: ${verdict.errors.join('; ')}`);
  }

  const planContent = `${JSON.stringify(artifact, null, 2)}\n`;
  ensureDirSync(dirname(path));
  writeTextFileSync(path, planContent);

  const planDigest = createHash('sha256').update(planContent, 'utf8').digest('hex');
  await recordArtifactHash('plan', planDigest, path, { statePath: options.statePath });

  return { path, artifact };
}
