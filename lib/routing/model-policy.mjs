// @ts-check
/**
 * E8-4: model/budget policy routing.
 *
 * Routes each budget class ('tiny' | 'standard' | 'large') to a model ID read
 * from `config/model-policy.json`. No model IDs are hardcoded in committed
 * behavior — and an entry whose `verifiedAt` is null is treated as `[UNVERIFIED]`
 * and refuses to route in production unless the caller explicitly opts in.
 *
 * Background: external grounding recommends routing easy tasks to cheaper models,
 * but Version B model IDs are explicitly [UNVERIFIED] and must not drive
 * committed behavior — so they live in a verifiable config, not in code.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextFile } from '../fs-safe.mjs';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../types.mjs').ModelEntry} ModelEntry */
/** @typedef {import('../types.mjs').ModelPolicy} ModelPolicy */
/** @typedef {import('../types.mjs').PolicyRoute} PolicyRoute */
/** @typedef {import('../types.mjs').ModelRole} ModelRole */
/** @typedef {import('../types.mjs').RolePolicyRoute} RolePolicyRoute */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default policy config path: <repo>/config/model-policy.json. */
export const DEFAULT_POLICY_PATH = resolve(__dirname, '../../config/model-policy.json');

/** The three budget classes a policy must cover. */
const BUDGET_CLASSES = /** @type {BudgetClass[]} */ (['tiny', 'standard', 'large']);

/**
 * The per-worker roles a policy `roles` block may declare (FO-7). Unknown
 * role names are rejected by validation — a typo must fail loudly, not
 * silently route nothing.
 * @type {readonly ModelRole[]}
 */
export const KNOWN_MODEL_ROLES = Object.freeze(['discoveryWorker']);

/**
 * Load and parse the model policy config. Throws if the file is missing,
 * malformed JSON, or fails shape validation.
 * @param {{ policyPath?: string }} [opts]
 * @returns {Promise<ModelPolicy>}
 */
export async function loadModelPolicy(opts = {}) {
  const policyPath = opts.policyPath ?? DEFAULT_POLICY_PATH;
  const raw = await readTextFile(policyPath);

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    throw new Error(
      `Invalid JSON in model policy at ${policyPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const { ok, errors } = validateModelPolicy(parsed);
  if (!ok) {
    throw new Error(`Invalid model policy at ${policyPath}:\n  - ${errors.join('\n  - ')}`);
  }

  return /** @type {ModelPolicy} */ (parsed);
}

/**
 * Validate the policy shape. Returns a result rather than throwing so callers
 * (loader, CI script) can report all problems at once.
 * @param {unknown} policy
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateModelPolicy(policy) {
  /** @type {string[]} */
  const errors = [];

  if (typeof policy !== 'object' || policy === null) {
    return { ok: false, errors: ['policy must be an object'] };
  }

  const p = /** @type {Record<string, unknown>} */ (policy);

  if (typeof p.schemaVersion !== 'number') {
    errors.push('schemaVersion must be a number');
  }

  const byClass = p.byBudgetClass;
  if (typeof byClass !== 'object' || byClass === null) {
    errors.push('byBudgetClass must be an object');
    return { ok: errors.length === 0, errors };
  }

  const map = /** @type {Record<string, unknown>} */ (byClass);
  for (const cls of BUDGET_CLASSES) {
    const entry = getOwn(map, cls);
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`byBudgetClass.${cls} is missing or not an object`);
      continue;
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (typeof e.modelId !== 'string' || e.modelId.length === 0) {
      errors.push(`byBudgetClass.${cls}.modelId must be a non-empty string`);
    }
    if (!(typeof e.verifiedAt === 'string' || e.verifiedAt === null)) {
      errors.push(`byBudgetClass.${cls}.verifiedAt must be a string or null`);
    }
  }

  // FO-7: the roles block is optional; when present it must map KNOWN
  // role names to entries with the same field rules as class entries.
  if (p.roles !== undefined) {
    if (typeof p.roles !== 'object' || p.roles === null || Array.isArray(p.roles)) {
      errors.push('roles must be an object when present');
      return { ok: errors.length === 0, errors };
    }
    const roles = /** @type {Record<string, unknown>} */ (p.roles);
    for (const [role, entry] of Object.entries(roles)) {
      if (!KNOWN_MODEL_ROLES.includes(/** @type {ModelRole} */ (role))) {
        errors.push(`roles.${role} is not a known model role (known: ${KNOWN_MODEL_ROLES.join(', ')})`);
        continue;
      }
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`roles.${role} is missing or not an object`);
        continue;
      }
      const e = /** @type {Record<string, unknown>} */ (entry);
      if (typeof e.modelId !== 'string' || e.modelId.length === 0) {
        errors.push(`roles.${role}.modelId must be a non-empty string`);
      }
      if (!(typeof e.verifiedAt === 'string' || e.verifiedAt === null)) {
        errors.push(`roles.${role}.verifiedAt must be a string or null`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Route a budget class to its configured model. Throws when the entry is
 * unverified (`verifiedAt === null`) unless `opts.allowUnverified === true`.
 * @param {BudgetClass} budgetClass
 * @param {ModelPolicy} policy
 * @param {{ allowUnverified?: boolean }} [opts]
 * @returns {PolicyRoute}
 */
export function routeModel(budgetClass, policy, opts = {}) {
  const entry = getOwn(policy.byBudgetClass, budgetClass);
  if (!entry) {
    throw new Error(`No model policy entry for budget class '${budgetClass}'.`);
  }

  const verified = entry.verifiedAt !== null;
  if (!verified && opts.allowUnverified !== true) {
    throw new Error(
      `Model ID for ${budgetClass} is [UNVERIFIED]. Set verifiedAt before routing in production.`
    );
  }

  return { budgetClass, modelId: entry.modelId, verified };
}

/**
 * Route a worker role to its configured model (FO-7). Mirrors `routeModel`
 * exactly: throws when the entry is unverified (`verifiedAt === null`) unless
 * `opts.allowUnverified === true`, and throws when the policy declares no
 * entry for the role.
 * @param {ModelRole} role
 * @param {ModelPolicy} policy
 * @param {{ allowUnverified?: boolean }} [opts]
 * @returns {RolePolicyRoute}
 */
export function routeWorkerModel(role, policy, opts = {}) {
  const entry = policy.roles ? getOwn(policy.roles, role) : undefined;
  if (!entry) {
    throw new Error(`No model policy entry for role '${role}'.`);
  }

  const verified = entry.verifiedAt !== null;
  if (!verified && opts.allowUnverified !== true) {
    throw new Error(
      `Model ID for role ${role} is [UNVERIFIED]. Set verifiedAt before routing in production.`
    );
  }

  return { role, modelId: entry.modelId, verified };
}
