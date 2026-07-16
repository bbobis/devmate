// @ts-check
/**
 * E8-1: orchestrator-workers fanout.
 *
 * Runs independent worker thunks in parallel. By default all budget classes
 * are permitted; pass `opts.strict = true` to restore the legacy E8-1
 * `large`-only guard (calibrate after E8 evaluation phase).
 *
 * Every settled worker is validated against the E4-8 WorkerReturn contract.
 * Failures (rejection, timeout, or contract violation) become entries in
 * `violations` — never thrown — so one bad worker cannot abort the batch.
 *
 * TCM-10: only validated, typed WorkerReturn objects ever reach
 * `FanoutResult.results`. Raw transcripts are never pasted back.
 *
 * Background: Anthropic "Building effective agents"
 * (https://www.anthropic.com/engineering/building-effective-agents),
 * ws3-external-grounding.md:67-75.
 */

import { validateWorkerReturn, serializeWorkerReturn } from './worker-contract.mjs';
import { recordWorkerTelemetry } from './telemetry.mjs';

/** @typedef {import('../types.mjs').WorkerReturn} WorkerReturn */
/** @typedef {import('../types.mjs').FanoutOpts} FanoutOpts */
/** @typedef {import('../types.mjs').FanoutResult} FanoutResult */
/** @typedef {import('../types.mjs').WorkerTelemetry} WorkerTelemetry */

const DEFAULT_TIMEOUT_MS = 30000;

/** Sentinel distinguishing a timeout from a normal worker rejection. */
const TIMEOUT = Symbol('worker-timeout');

/**
 * Rough token estimate: ~4 chars per token. Pure heuristic for telemetry only.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Race a worker thunk against a per-worker timeout. Resolves to the worker's
 * value, or the TIMEOUT sentinel if the deadline fires first. Rejections from
 * the worker propagate (caught by the caller).
 * @param {(signal?: AbortSignal) => Promise<WorkerReturn>} worker
 * @param {number} timeoutMs
 * @returns {Promise<WorkerReturn | typeof TIMEOUT>}
 */
function withTimeout(worker, timeoutMs) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const workerPromise = Promise.resolve().then(() => worker(controller.signal));
  // The raced worker can reject after timeout; keep those late rejections handled.
  workerPromise.catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Resolve the TIMEOUT sentinel first so the deadline deterministically
      // wins Promise.race regardless of microtask ordering; abort is a
      // best-effort signal to the worker and is never awaited.
      resolve(TIMEOUT);
      controller.abort(new Error('worker timeout'));
    }, timeoutMs);
  });
  return Promise.race([
    workerPromise,
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Validate optional floor for minimum successful workers.
 * @param {number | undefined} minSuccessRate
 * @returns {number | undefined}
 */
function validateMinSuccessRate(minSuccessRate) {
  if (minSuccessRate === undefined) return undefined;
  if (!Number.isFinite(minSuccessRate) || minSuccessRate < 0 || minSuccessRate > 1) {
    throw new Error('fanout minSuccessRate must be a finite number between 0 and 1');
  }
  return minSuccessRate;
}

/**
 * Run workers in parallel.
 * When `opts.strict` is true, rejects non-`large` budgets (legacy E8-1 behaviour).
 * When `opts.strict` is false (default), all budget classes are permitted.
 * Workers that spawn processes or use abortable Node APIs MUST honor
 * `signal` (for example `execFile(cmd, args, { signal })`).
 * Pure-compute workers may ignore it.
 * @param {Array<(signal?: AbortSignal) => Promise<WorkerReturn>>} workers
 * @param {FanoutOpts} opts
 * @returns {Promise<FanoutResult>}
 */
export async function fanout(workers, opts) {
  // TODO: calibrate after E8 evals — strict mode is a provisional placeholder
  if (opts.strict === true && opts.budgetClass !== 'large') {
    throw new Error('fanout strict mode requires large budget');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minSuccessRate = validateMinSuccessRate(opts.minSuccessRate);
  const dryRun = opts.dryRun === true;
  const telemetryPath = opts.telemetryPath;

  if (dryRun) {
    // Plan only — do not invoke any worker.
    return { results: [], telemetry: [], violations: [], dryRun: true, planned: workers.length, succeeded: 0, insufficient: false };
  }

  /** @type {WorkerReturn[]} */
  const results = [];
  /** @type {WorkerTelemetry[]} */
  const telemetry = [];
  /** @type {string[]} */
  const violations = [];

  const settled = await Promise.allSettled(
    workers.map((w, i) => runOne(w, i, timeoutMs))
  );

  for (const s of settled) {
    // runOne never rejects; it always resolves a structured outcome.
    if (s.status !== 'fulfilled') continue;
    const { worker, telemetry: tel, valid } = s.value;
    telemetry.push(tel);
    await recordWorkerTelemetry(tel.workerId, tel, telemetryPath ? { ledgerPath: telemetryPath } : {});
    if (valid && worker) {
      results.push(worker);
    } else {
      violations.push(tel.workerId);
    }
  }

  const planned = workers.length;
  const succeeded = results.length;
  const insufficient = minSuccessRate !== undefined && planned > 0 && (succeeded / planned) < minSuccessRate;

  return { results, telemetry, violations, dryRun: false, planned, succeeded, insufficient };
}

/**
 * Run a single worker, never throwing. Returns a structured outcome the caller
 * folds into the aggregate result.
 * @param {(signal?: AbortSignal) => Promise<WorkerReturn>} worker
 * @param {number} index
 * @param {number} timeoutMs
 * @returns {Promise<{ worker: WorkerReturn | null, telemetry: WorkerTelemetry, valid: boolean }>}
 */
async function runOne(worker, index, timeoutMs) {
  const fallbackId = `worker-${index}`;
  const start = Date.now();

  /** @type {WorkerReturn | typeof TIMEOUT} */
  let outcome;
  try {
    outcome = await withTimeout(worker, timeoutMs);
  } catch {
    // Worker rejected — treat as a violation, never rethrow.
    const latencyMs = Date.now() - start;
    return {
      worker: null,
      valid: false,
      telemetry: { workerId: fallbackId, promptTokens: 0, completionTokens: 0, latencyMs, contractValid: false },
    };
  }

  const latencyMs = Date.now() - start;

  if (outcome === TIMEOUT) {
    return {
      worker: null,
      valid: false,
      telemetry: { workerId: fallbackId, promptTokens: 0, completionTokens: 0, latencyMs, contractValid: false },
    };
  }

  const ret = outcome;
  const { ok } = validateWorkerReturn(ret);
  const workerId = typeof ret?.workerId === 'string' && ret.workerId.trim() !== '' ? ret.workerId : fallbackId;
  const completionTokens = ok ? estimateTokens(serializeWorkerReturn(ret)) : estimateTokens(JSON.stringify(ret ?? {}));

  return {
    worker: ok ? ret : null,
    valid: ok,
    telemetry: { workerId, promptTokens: 0, completionTokens, latencyMs, contractValid: ok },
  };
}
