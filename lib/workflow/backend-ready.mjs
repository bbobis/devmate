// @ts-check
import { readTextFileSync } from "../fs-safe.mjs";
import http from "node:http";
import https from "node:https";
import { loadDevmateConfig } from "../config/devmate-config.mjs";
import { appendJsonl } from "../memory/append-jsonl.mjs";
import { writeTaskState } from "../task-state.mjs";

/** @typedef {import('../types.mjs').HealthPredicate} HealthPredicate */
/** @typedef {import('../types.mjs').BackendReadyResult} BackendReadyResult */
/** @typedef {import('../types.mjs').TaskState} TaskState */

/** Default trace ledger; override with DEVMATE_TRANSITIONS_PATH. */
const DEFAULT_TRANSITIONS_PATH = ".devmate/state/transitions.jsonl";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Probe a single URL. Never throws — network/timeout errors are returned as
 * `{ ok: false, detail }`.
 *
 * @param {HealthPredicate} p
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function probe(p) {
  return new Promise((resolve) => {
    const expectedStatus = p.statusCode ?? 200;
    const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {typeof http | typeof https} */
    let lib;
    try {
      lib = new URL(p.url).protocol === "https:" ? https : http;
    } catch {
      resolve({ ok: false, detail: `${p.url}: invalid URL` });
      return;
    }
    const req = lib.get(p.url, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status !== expectedStatus) {
          resolve({
            ok: false,
            detail: `${p.url}: status ${status} != ${expectedStatus}`,
          });
          return;
        }
        if (p.bodyContains) {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!body.includes(p.bodyContains)) {
            resolve({
              ok: false,
              detail: `${p.url}: body missing "${p.bodyContains}"`,
            });
            return;
          }
        }
        resolve({ ok: true, detail: `${p.url}: ok` });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, detail: `${p.url}: timeout after ${timeoutMs}ms` });
    });
    req.on("error", (err) => {
      resolve({ ok: false, detail: `${p.url}: ${err.message}` });
    });
  });
}

/**
 * Run all configured health predicates and return a BackendReadyResult.
 * Empty predicate list = no backend declared = ready (skip).
 *
 * @param {HealthPredicate[]} predicates
 * @returns {Promise<BackendReadyResult>}
 */
export async function checkBackendReady(predicates) {
  const checkedAt = new Date().toISOString();
  if (!Array.isArray(predicates) || predicates.length === 0) {
    return {
      ready: true,
      reason: "No backend health predicates configured (skip).",
      checkedAt,
      failedPredicates: [],
    };
  }
  const results = await Promise.all(predicates.map((p) => probe(p)));
  const failed = [];
  let firstFailDetail = "";
  for (let i = 0; i < results.length; i++) {
    if (!results[i].ok) {
      failed.push(predicates[i].url);
      if (firstFailDetail === "") firstFailDetail = results[i].detail;
    }
  }
  return {
    ready: failed.length === 0,
    reason:
      failed.length === 0 ? "All health predicates passed." : firstFailDetail,
    checkedAt,
    failedPredicates: failed,
  };
}

/**
 * Load HealthPredicate[] from devmate.config.json `healthPredicates` (primary
 * source, E10), or a `.devmate/health-predicates.json` fallback file.
 *
 * E10 overlay: there is NO hardcoded Spring/actuator default. No config means
 * no predicates → caller treats "no backend declared" as ready/skip.
 *
 * @param {string} [configPath]  Optional explicit predicate file (JSON array).
 * @returns {Promise<HealthPredicate[]>}
 */
export async function loadHealthPredicates(configPath) {
  // 1. Explicit predicate file wins.
  if (configPath) {
    const raw = readTextFileSync(configPath);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Health predicates file must be a JSON array: ${configPath}`,
      );
    }
    return /** @type {HealthPredicate[]} */ (parsed);
  }

  // 2. Primary source: devmate.config.json healthPredicates key.
  const cfg = loadDevmateConfig();
  if (cfg.ok) {
    const hp = /** @type {Record<string, unknown>} */ (cfg.config)[
      "healthPredicates"
    ];
    if (Array.isArray(hp)) return /** @type {HealthPredicate[]} */ (hp);
  }

  // 3. Optional fallback file.
  try {
    const raw = readTextFileSync(".devmate/health-predicates.json");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return /** @type {HealthPredicate[]} */ (parsed);
  } catch {
    // no fallback file — fine
  }

  // 4. No config → no predicates (no phantom Spring probe).
  return [];
}

/**
 * Mark the backend-ready gate stale in TaskState and append a `gate_stale` trace.
 *
 * @param {TaskState} state
 * @param {string} reason
 * @param {{ statePath?: string, transitionsPath?: string }} [opts]
 * @returns {Promise<TaskState>}
 */
export async function markBackendReadyStale(state, reason, opts = {}) {
  const next = { ...state, backendReadyStaleSince: new Date().toISOString() };
  await writeTaskState(next, opts.statePath);

  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "gate_stale",
    gate: "backend-ready",
    reason,
    ts: Date.now(),
  }).catch(() => {});

  return next;
}

/**
 * Append a structured `e2e_blocked` trace event with the gate reason. Awaited
 * before the E2E subprocess launches so the trace cannot lose the race.
 *
 * @param {{ reason: string, gate: string, tier: number }} info
 * @param {{ transitionsPath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function traceE2EBlock(info, opts = {}) {
  const transitionsPath =
    opts.transitionsPath ||
    process.env.DEVMATE_TRANSITIONS_PATH ||
    DEFAULT_TRANSITIONS_PATH;
  await appendJsonl(transitionsPath, {
    event: "e2e_blocked",
    reason: info.reason,
    gate: info.gate,
    tier: info.tier,
    blockedAt: new Date().toISOString(),
  }).catch(() => {});
}

/**
 * Assert backend is ready immediately before Tier 5 E2E. Re-runs the health
 * check; a stale gate throws immediately without probing. On failure, marks the
 * gate stale, traces the block, and throws.
 *
 * @param {TaskState} state
 * @param {HealthPredicate[]} predicates
 * @param {{ statePath?: string, transitionsPath?: string }} [opts]
 * @returns {Promise<BackendReadyResult>}
 */
export async function assertBackendReadyBeforeTier5(
  state,
  predicates,
  opts = {},
) {
  if (
    typeof state.backendReadyStaleSince === "string" &&
    state.backendReadyStaleSince !== ""
  ) {
    const reason = `backend-ready gate is stale since ${state.backendReadyStaleSince}`;
    await traceE2EBlock({ reason, gate: "backend-ready", tier: 5 }, opts);
    throw new Error(`assertBackendReadyBeforeTier5: ${reason}`);
  }

  const result = await checkBackendReady(predicates);
  if (!result.ready) {
    await markBackendReadyStale(state, result.reason, opts);
    await traceE2EBlock(
      { reason: result.reason, gate: "backend-ready", tier: 5 },
      opts,
    );
    throw new Error(
      `assertBackendReadyBeforeTier5: backend not ready — ${result.reason}`,
    );
  }
  return result;
}
