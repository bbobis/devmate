// @ts-check
/**
 * E8-4: policy guard.
 *
 * Blocks changing a budget class's default model unless an eval baseline exists
 * for that class. This enforces the rule that no default flips without a measured
 * comparison: cheaper/smaller models may only become the default once an eval
 * baseline proves they hold up for that class of work.
 */

import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';
import { getOwn } from '../object-utils.mjs';

/** @typedef {import('../types.mjs').BudgetClass} BudgetClass */

/**
 * Assert an eval baseline file exists for the given budget class before a default
 * change proceeds. Looks for `<evalsDir>/model-routing/baseline-<class>.json`.
 * @param {BudgetClass} budgetClass
 * @param {string} evalsDir  Absolute path to the evals directory.
 * @returns {Promise<void>}  Resolves if present; throws if absent.
 */
export async function assertEvalBaselineExists(budgetClass, evalsDir) {
  const baselinePath = resolve(evalsDir, 'model-routing', `baseline-${budgetClass}.json`);
  try {
    await fsp.access(baselinePath);
  } catch {
    throw new Error(
      `No eval baseline for ${budgetClass}. Run eval comparison before changing the default.`
    );
  }
}

/** @typedef {import('../types.mjs').PolicyRoute} PolicyRoute */

/**
 * E9-11: guard a route before it is honored. Advisory (unverified) routes
 * pass through — they are recommendations only. A verified route (real model
 * ID) must additionally have a committed eval baseline for its class
 * (E9-22), otherwise this throws and the route must not be honored.
 * @param {PolicyRoute} route
 * @param {string} evalsDir  Absolute path to the evals directory.
 * @returns {Promise<void>}
 */
export async function assertRouteAllowed(route, evalsDir) {
  if (route.verified !== true) return;
  await assertEvalBaselineExists(
    /** @type {import('../types.mjs').BudgetClass} */ (route.budgetClass),
    evalsDir
  );
}

/** @typedef {import('../types.mjs').ModelRole} ModelRole */
/** @typedef {import('../types.mjs').RolePolicyRoute} RolePolicyRoute */

/**
 * FO-7: baseline file slug per worker role. Fail closed: a role missing
 * here can never prove a baseline, so its verified route is never honored.
 * @type {Readonly<Record<ModelRole, string>>}
 */
const ROLE_BASELINE_SLUGS = Object.freeze({ discoveryWorker: 'discovery-worker' });

/**
 * FO-7: assert an eval baseline file exists for the given worker role before
 * its verified route is honored. Looks for
 * `<evalsDir>/model-routing/baseline-<role-slug>.json`
 * (e.g. `baseline-discovery-worker.json`). Throws for a role with no
 * registered baseline slug — fail closed, never guess a filename.
 * @param {ModelRole} role
 * @param {string} evalsDir  Absolute path to the evals directory.
 * @returns {Promise<void>}  Resolves if present; throws if absent.
 */
export async function assertRoleEvalBaselineExists(role, evalsDir) {
  const slug = getOwn(ROLE_BASELINE_SLUGS, role);
  if (slug === undefined) {
    throw new Error(`No baseline slug registered for role ${role}. Unknown roles cannot be honored.`);
  }
  const baselinePath = resolve(evalsDir, 'model-routing', `baseline-${slug}.json`);
  try {
    await fsp.access(baselinePath);
  } catch {
    throw new Error(
      `No eval baseline for role ${role}. Run eval comparison before changing the default.`
    );
  }
}

/**
 * FO-7: `assertRouteAllowed` equivalent for role routes. Advisory
 * (unverified) role routes pass through — recommendations only. A verified
 * role route must additionally have a committed role eval baseline,
 * otherwise this throws and the route must not be honored. The class-route
 * discipline is extended, never weakened.
 * @param {RolePolicyRoute} route
 * @param {string} evalsDir  Absolute path to the evals directory.
 * @returns {Promise<void>}
 */
export async function assertRoleRouteAllowed(route, evalsDir) {
  if (route.verified !== true) return;
  await assertRoleEvalBaselineExists(/** @type {ModelRole} */ (route.role), evalsDir);
}
