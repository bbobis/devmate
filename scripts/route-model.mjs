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
import { chooseModelTier, deriveDifficulty } from '../lib/routing/model-route.mjs';
import { createPassThroughGateway } from '../lib/routing/model-gateway.mjs';
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
 * Read the persisted budget class, lane, taskId, and spec-AC count (the #217
 * fallback difficulty signal) from TaskState. Falls back to `standard` with a
 * distinct unclassified note (never crashes) when the state or contract is
 * absent — mirroring check-session-budget's stance.
 * @param {string} taskStatePath
 * @returns {Promise<{ budgetClass: BudgetClass, lane: string, stateAcCount: number, taskId: string|null, classified: boolean, reason: string }>}
 */
async function readBudgetClass(taskStatePath) {
  try {
    const state = JSON.parse(await readTextFile(taskStatePath));
    const cls = state?.outputContract?.token_budget_class;
    const taskId = typeof state?.taskId === 'string' && state.taskId !== '' ? state.taskId : null;
    const lane = typeof state?.lane === 'string' && state.lane !== '' ? state.lane : 'unknown';
    // #217: the spec's acceptance criteria (persisted by spec-writer) are a real
    // difficulty signal — but they only exist AFTER route-model runs, so this is
    // the FALLBACK; the primary signal is the approved plan's AC count (see
    // readPlanAcCount), which is present at route-model's plan-approved invocation.
    const stateAcCount = Array.isArray(state?.acceptanceCriteria) ? state.acceptanceCriteria.length : 0;
    if (typeof cls === 'string' && BUDGET_CLASSES.includes(cls)) {
      return { budgetClass: /** @type {BudgetClass} */ (cls), lane, stateAcCount, taskId, classified: true, reason: '' };
    }
    return { budgetClass: 'standard', lane, stateAcCount, taskId, classified: false, reason: 'no token_budget_class on the persisted OutputContract' };
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { budgetClass: 'standard', lane: 'unknown', stateAcCount: 0, taskId: null, classified: false, reason: `task state unreadable (${msg})` };
  }
}

/**
 * Count acceptance criteria from the APPROVED PLAN — the real difficulty signal
 * present at route-model's actual invocation point (`plan-approved`), where the
 * spec's `state.acceptanceCriteria` does not exist yet. Reads
 * `.devmate/session/<taskId>/plan.json` (a sibling of the state dir) and sums
 * `tasks[].ac`. Returns 0 when the plan is absent/unreadable/malformed, so the
 * caller degrades to the state fallback and then the budget-class proxy.
 * @param {string} taskStatePath
 * @param {string|null} taskId
 * @returns {Promise<number>}
 */
async function readPlanAcCount(taskStatePath, taskId) {
  if (taskId === null) return 0;
  // state and session dirs are both children of `.devmate`.
  const planPath = join(dirname(dirname(taskStatePath)), 'session', taskId, 'plan.json');
  try {
    const plan = JSON.parse(await readTextFile(planPath));
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    let count = 0;
    for (const task of tasks) {
      if (Array.isArray(task?.ac)) count += task.ac.length;
    }
    return count;
  } catch {
    return 0;
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

  const { budgetClass, lane, stateAcCount, taskId, classified, reason } = await readBudgetClass(taskStatePath);
  // #217: the real difficulty signal is the acceptance-criterion count. At
  // route-model's plan-approved invocation the approved plan carries it (primary);
  // the spec's state.acceptanceCriteria is a fallback for any later invocation;
  // 0 → the budget-class proxy inside deriveDifficulty.
  const planAcCount = await readPlanAcCount(taskStatePath, taskId);
  const acCount = planAcCount > 0 ? planAcCount : stateAcCount;
  // #27/#217: derive the advisory cost tier (cheap-vs-powerful) from the
  // classified budget class + that difficulty signal, and route the decision
  // through the model-gateway seam — the single place a future failover/cost-cap
  // impl replaces. The gateway's record sink is the telemetry log (the tier rides
  // the model_route event). Advisory metadata only.
  let recordedTier = '';
  let recordedTierReason = '';
  const gateway = createPassThroughGateway({
    record: (entry) => {
      recordedTier = entry.tier;
      recordedTierReason = entry.reason;
    },
  });
  const decidedTier = chooseModelTier({
    budgetClass,
    difficulty: deriveDifficulty(budgetClass, acCount),
    lane,
  });
  const { tier, reason: tierReason } = gateway.route(decidedTier, () => decidedTier);
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
        tier,
        tierReason,
        ...(roleHints !== undefined ? { roles: roleHints } : {}),
      });
      await traceRoute(taskId, taskStatePath, route, 'blocked', {
        ...opts,
        tier: recordedTier,
        tierReason: recordedTierReason,
      });
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
    tier,
    tierReason,
    ...(roleHints !== undefined ? { roles: roleHints } : {}),
  };
  await writeHint(taskStatePath, hint);
  await traceRoute(taskId, taskStatePath, route, mode, {
    ...opts,
    tier: recordedTier,
    tierReason: recordedTierReason,
  });

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
 * @param {{ traceRoot?: string, tier?: string, tierReason?: string }} opts
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
        // #27: the tier logged here comes from the gateway's record sink — the
        // telemetry path a future gateway impl reuses without call-site changes.
        ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
        ...(opts.tierReason !== undefined ? { tierReason: opts.tierReason } : {}),
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
