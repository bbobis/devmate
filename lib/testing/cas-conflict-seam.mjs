// @ts-check
/**
 * #202 — a TEST-ONLY seam that makes a versioned CAS conflict DETERMINISTIC.
 *
 * The two versioned CAS loops (gate-advance's lane walk, approval-listener's
 * APPROVE_PLAN) retry on a version conflict: they read the fresh state + version,
 * compute the next state, and commit it with `expectedVersion`; if a concurrent
 * write landed in between, the commit conflicts and the loop re-reads and retries.
 * That `conflict → continue` branch — and the retries-exhausted path — cannot be
 * exercised by a bare `Promise.all` race, because nothing guarantees the competing
 * write lands in the narrow window between the loop's read and its commit.
 *
 * This seam closes that window on demand: armed for a site, it bumps the on-disk
 * `stateVersion` exactly once per loop attempt (up to N), so the pending
 * `expectedVersion` commit is guaranteed to conflict. It mirrors the fault-seam
 * ({@link file://./fault-injection.mjs}) contract:
 *   - inert unless {@link CAS_CONFLICT_ENV} names a known site — in production it
 *     is one env read that returns 0 and falls through;
 *   - guarded by `test/lib/testing/no-production-fault.test.mjs`, which fails if
 *     any production file even NAMES the env var (only this module may);
 *   - the only thing a test arms is "conflict the next N commits at <site>".
 */
import { mutateTaskStateUnderLock } from '../task-state.mjs';

/** The environment variable that arms the seam. Test-only. */
export const CAS_CONFLICT_ENV = 'DEVMATE_CAS_CONFLICT';

/**
 * The CAS loops that may be forced to conflict. A value naming any other site is
 * ignored, so a typo cannot silently target a different loop.
 * @type {ReadonlySet<string>}
 */
export const CAS_CONFLICT_SITES = new Set(['gate-advance', 'approve-plan']);

/**
 * Bumps already applied this process, per site. Lets a single armed run conflict
 * the first N attempts and then let the (N+1)th land — process-local, so a spawned
 * hook resets naturally; in-process callers reset via {@link resetCasConflictSeam}.
 * @type {Map<string, number>}
 */
const consumed = new Map();

/**
 * The number of attempts to force-conflict for `site`, from the strict grammar
 * `"<site>:<n>"` (a single colon, `n` a positive integer). Returns 0 — inert —
 * for any other value, an unknown site, or a spec targeting a different site.
 * @param {string} site
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function armedConflictCount(site, env) {
  if (!CAS_CONFLICT_SITES.has(site)) return 0;
  const raw = env[CAS_CONFLICT_ENV];
  if (typeof raw !== 'string' || raw === '') return 0;

  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return 0;
  if (raw.slice(0, colon) !== site) return 0;

  const nStr = raw.slice(colon + 1);
  if (!/^[1-9][0-9]*$/.test(nStr)) return 0;
  return Number(nStr);
}

/**
 * Clear the per-process bump counters. In-process tests call this between cases
 * so an earlier arming never bleeds into the next.
 * @returns {void}
 */
export function resetCasConflictSeam() {
  consumed.clear();
}

/**
 * Default version bump: an identity read-modify-write through the canonical API,
 * which stamps `stateVersion = fresh + 1` on every committed write (#112) — so it
 * lands a real concurrent version bump without changing any semantic field.
 * @param {string} statePath
 * @returns {Promise<void>}
 */
async function defaultBumpVersion(statePath) {
  await mutateTaskStateUnderLock((state) => ({ ...state }), statePath, {
    event: 'cas-conflict-seam',
  });
}

/**
 * If a conflict is armed for `site` and its budget is not spent, bump the on-disk
 * `stateVersion` so the caller's pending `expectedVersion` commit conflicts. Call
 * it once per loop attempt, AFTER reading the fresh version and BEFORE committing.
 *
 * In production (env unset) this is one env read + parse that returns 0 and does
 * nothing — no I/O, no write.
 *
 * @param {string} site
 * @param {string} statePath
 * @param {{ env?: NodeJS.ProcessEnv, bumpVersion?: (statePath: string) => Promise<void> }} [opts]
 * @returns {Promise<void>}
 */
export async function forceConflictIfArmed(site, statePath, opts = {}) {
  const env = opts.env ?? process.env;
  const budget = armedConflictCount(site, env);
  if (budget <= 0) return;

  const done = consumed.get(site) ?? 0;
  if (done >= budget) return;
  consumed.set(site, done + 1);

  const bump = opts.bumpVersion ?? defaultBumpVersion;
  await bump(statePath);
}
