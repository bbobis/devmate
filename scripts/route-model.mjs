// @ts-check
/**
 * E9-11: route-model — budget-class → model recommendation at dispatch.
 *
 * Reads the persisted `token_budget_class` from the task's OutputContract
 * (E9-06), routes it through `routeModel` against `config/model-policy.json`,
 * and records the recommendation as a `model_route` trace event plus a
 * dispatch hint at `.devmate/state/model-route.json`.
 *
 * FO-7: when the policy declares a `roles` block, each known worker role
 * (today: discoveryWorker) is also resolved — always with
 * `allowUnverified: true` — and included in the hint file under `roles`
 * as `{ modelId, mode }`. The same refuse-without-baseline discipline
 * applies per role: a verified role route without its committed role
 * baseline is recorded as blocked and fails the run.
 *
 * While the policy ships `[UNVERIFIED]` placeholder IDs the route is
 * ADVISORY: the run never crashes, the hint is a recommendation only.
 * Once a class carries a real (verified) ID, honoring the route additionally
 * requires a committed eval baseline (E9-22) — `assertRouteAllowed` blocks
 * an unbaselined verified route with exit 1.
 *
 * Usage:
 *   node scripts/route-model.mjs [taskStatePath]
 *
 * Exit: 0 advisory or enforced-with-baseline; 1 verified route (class or
 *       role) without a committed baseline, or unreadable policy.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { readTextFile } from '../lib/fs-safe.mjs';
import { writeJsonFileAtomic } from '../lib/json-io.mjs';
import { getOwn } from '../lib/object-utils.mjs';
import { KNOWN_MODEL_ROLES, loadModelPolicy, routeModel, routeWorkerModel } from '../lib/routing/model-policy.mjs';
import { assertRoleRouteAllowed, assertRouteAllowed } from '../lib/routing/policy-guard.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';

/** @typedef {import('../lib/types.mjs').BudgetClass} BudgetClass */
/** @typedef {import('../lib/types.mjs').ModelRole} ModelRole */
/** @typedef {import('../lib/types.mjs').ModelRouteHint} ModelRouteHint */
/** @typedef {import('../lib/types.mjs').ModelRouteRoleHint} ModelRouteRoleHint */

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo-root evals directory holding the committed baselines (E9-22). */
const DEFAULT_EVALS_DIR = resolve(__dirname, '..', 'evals');

/** Default TaskState path when none is supplied. */
const DEFAULT_TASK_STATE = '.devmate/state/task.json';

/** @type {readonly string[]} */
const BUDGET_CLASSES = Object.freeze(['tiny', 'standard', 'large']);

/**
 * Read the persisted budget class + taskId from TaskState. Falls back to
 * `standard` with a distinct unclassified note (never crashes) when the state
 * or contract is absent — mirroring check-session-budget's stance.
 * @param {string} taskStatePath
 * @returns {Promise<{ budgetClass: BudgetClass, taskId: string|null, classified: boolean, reason: string }>}
 */
async function readBudgetClass(taskStatePath) {
  try {
    const state = JSON.parse(await readTextFile(taskStatePath));
    const cls = state?.outputContract?.token_budget_class;
    const taskId = typeof state?.taskId === 'string' && state.taskId !== '' ? state.taskId : null;
    if (typeof cls === 'string' && BUDGET_CLASSES.includes(cls)) {
      return { budgetClass: /** @type {BudgetClass} */ (cls), taskId, classified: true, reason: '' };
    }
    return { budgetClass: 'standard', taskId, classified: false, reason: 'no token_budget_class on the persisted OutputContract' };
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { budgetClass: 'standard', taskId: null, classified: false, reason: `task state unreadable (${msg})` };
  }
}

/**
 * Main entrypoint.
 * @param {string[]} args  CLI args (without node/script).
 * @param {{ policyPath?: string, evalsDir?: string, traceRoot?: string }} [opts]  Overrides for tests.
 * @returns {Promise<number>} exit code
 */
export async function main(args, opts = {}) {
  const taskStatePath = args[0] || DEFAULT_TASK_STATE;
  const evalsDir = opts.evalsDir ?? DEFAULT_EVALS_DIR;

  const { budgetClass, taskId, classified, reason } = await readBudgetClass(taskStatePath);
  if (!classified) {
    process.stdout.write(
      `[route-model] unclassified session at ${taskStatePath} — ${reason}; ` +
        `assuming standard. Run init-task-state (E9-06) to classify.\n`
    );
  }

  /** @type {import('../lib/types.mjs').ModelPolicy} */
  let policy;
  try {
    policy = await loadModelPolicy(opts.policyPath !== undefined ? { policyPath: opts.policyPath } : {});
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[route-model] FAIL — cannot load model policy: ${msg}\n`);
    return 1;
  }

  // Advisory while IDs remain placeholders: allowUnverified surfaces the
  // "policy unverified" outcome ({ verified: false }) instead of crashing.
  const route = routeModel(/** @type {BudgetClass} */ (budgetClass), policy, { allowUnverified: true });
  const mode = route.verified ? 'enforced' : 'advisory';

  // FO-7: per-worker role hints ride along in the same hint file; each role
  // obeys the same refuse-without-baseline discipline as the class route.
  const { roleHints, blockedRoles } = await resolveRoleHints(policy, evalsDir);

  if (route.verified) {
    // A real (verified) ID may only be honored with a committed baseline.
    try {
      await assertRouteAllowed(route, evalsDir);
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[route-model] BLOCKED — verified route not honored: ${msg}\n`);
      // Record the block durably: overwrite any stale hint so a previous
      // run's valid-looking recommendation cannot survive a blocked run,
      // and trace the blocked attempt.
      await writeHint(taskStatePath, {
        budgetClass: route.budgetClass,
        modelId: route.modelId,
        verified: route.verified,
        mode: 'blocked',
        recommendedAt: new Date().toISOString(),
        ...(roleHints !== undefined ? { roles: roleHints } : {}),
      });
      await traceRoute(taskId, taskStatePath, route, 'blocked', opts);
      return 1;
    }
  }

  // TODO: advisory only until verified model IDs land (see docs/model-policy.md + E9-22)
  /** @type {ModelRouteHint} */
  const hint = {
    budgetClass: route.budgetClass,
    modelId: route.modelId,
    verified: route.verified,
    mode,
    recommendedAt: new Date().toISOString(),
    ...(roleHints !== undefined ? { roles: roleHints } : {}),
  };
  await writeHint(taskStatePath, hint);
  await traceRoute(taskId, taskStatePath, route, mode, opts);

  if (blockedRoles.length > 0) {
    // The blocked role hint is already durable (mode 'blocked' in the hint
    // file); fail the run so a verified-but-unbaselined role route can
    // never be honored silently.
    return 1;
  }

  process.stdout.write(JSON.stringify({ ok: true, ...hint }) + '\n');
  return 0;
}

/**
 * FO-7: resolve every known worker role declared by the policy's `roles`
 * block into a per-role dispatch hint. Roles always resolve with
 * `allowUnverified: true` (advisory-first); a verified role route is marked
 * enforced only with its committed role baseline and recorded as blocked
 * otherwise. Returns `roleHints: undefined` when the policy has no roles
 * block, so older policies produce a byte-identical hint file.
 * @param {import('../lib/types.mjs').ModelPolicy} policy
 * @param {string} evalsDir
 * @returns {Promise<{ roleHints: Partial<Record<ModelRole, ModelRouteRoleHint>>|undefined, blockedRoles: ModelRole[] }>}
 */
async function resolveRoleHints(policy, evalsDir) {
  if (!policy.roles) return { roleHints: undefined, blockedRoles: [] };
  /** @type {[ModelRole, ModelRouteRoleHint][]} */
  const hintEntries = [];
  /** @type {ModelRole[]} */
  const blockedRoles = [];
  for (const role of KNOWN_MODEL_ROLES) {
    if (!getOwn(policy.roles, role)) continue;
    const roleRoute = routeWorkerModel(role, policy, { allowUnverified: true });
    /** @type {ModelRouteRoleHint['mode']} */
    let roleMode = roleRoute.verified ? 'enforced' : 'advisory';
    if (roleRoute.verified) {
      try {
        await assertRoleRouteAllowed(roleRoute, evalsDir);
      } catch (/** @type {unknown} */ err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[route-model] BLOCKED — verified role route not honored: ${msg}\n`);
        roleMode = 'blocked';
        blockedRoles.push(role);
      }
    }
    hintEntries.push([role, { modelId: roleRoute.modelId, mode: roleMode }]);
  }
  return { roleHints: Object.fromEntries(hintEntries), blockedRoles };
}

/**
 * Atomically persist the dispatch hint next to the task state (best-effort).
 * @param {string} taskStatePath
 * @param {ModelRouteHint} hint
 * @returns {Promise<void>}
 */
async function writeHint(taskStatePath, hint) {
  const hintPath = join(dirname(taskStatePath), 'model-route.json');
  try {
    await writeJsonFileAtomic(hintPath, hint);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[route-model] hint write failed (non-fatal): ${msg}\n`);
  }
}

/**
 * Append a model_route trace event (best-effort; needs a taskId to satisfy
 * the trace schema).
 * @param {string|null} taskId
 * @param {string} taskStatePath
 * @param {import('../lib/types.mjs').PolicyRoute} route
 * @param {string} mode
 * @param {{ traceRoot?: string }} opts
 * @returns {Promise<void>}
 */
async function traceRoute(taskId, taskStatePath, route, mode, opts) {
  if (taskId === null) {
    process.stderr.write(`[route-model] no taskId in ${taskStatePath}; model_route not traced\n`);
    return;
  }
  try {
    await appendTraceEvent(
      {
        type: 'model_route',
        taskId,
        stepId: 'route-model',
        ts: new Date().toISOString(),
        schemaVersion: 1,
        budgetClass: route.budgetClass,
        modelId: route.modelId,
        mode,
      },
      { root: opts.traceRoot ?? resolveHookRoot() }
    );
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[route-model] trace append failed (non-fatal): ${msg}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
