// @ts-check
/**
 * #8 — a TEST-ONLY fault seam for the gate-advance hook.
 *
 * The failure-injection E2E suite has to prove two things the happy path never
 * exercises: that a hook which CRASHES mid-advance leaves the gate where it was
 * (never half-moved), and that the next invocation catches up. Neither can be
 * observed without making the hook fail on demand — and the one honest way to do
 * that from a black-box replay is a seam the host arms through the environment,
 * exactly as it arms everything else it hands a hook.
 *
 * The seam is inert unless {@link ENV_VAR} names a site this module knows. It is
 * therefore:
 *   - impossible for a production config to trip by accident — the value must be
 *     literally `"<site>:<mode>"` for a site in {@link FAULT_SITES} and a mode in
 *     {@link FAULT_MODES}; anything else is a silent no-op;
 *   - guarded by a test (`test/lib/testing/no-production-fault.test.mjs`) that the
 *     production tree never SETS this variable, so nothing but a test can arm it.
 *
 * It writes nothing, reads only the injected environment, and throws only its own
 * {@link InjectedFaultError} — so a caller can tell an injected fault apart from a
 * real one, and a reviewer can see at the call site that the only effect in
 * production (unarmed) is a single Set lookup.
 */

/** The environment variable that arms the seam. Test-only. */
export const ENV_VAR = 'DEVMATE_FAULT';

/**
 * The call sites that may be faulted. A value naming any other site is ignored,
 * so a typo cannot silently fault a different site.
 * @type {ReadonlySet<string>}
 */
export const FAULT_SITES = new Set(['gate-advance']);

/**
 * The fault modes the seam can emulate.
 *   - `crash`   — throw synchronously, as an unhandled hook exception would.
 *   - `timeout` — block long enough that the host's hook timeout fires and kills
 *                 the process. HARNESS-EMULATED: real hosts kill a hung hook; the
 *                 seam only supplies the hang, and the test's short spawn timeout
 *                 stands in for the host's kill.
 * @type {ReadonlySet<string>}
 */
export const FAULT_MODES = new Set(['crash', 'timeout']);

/** How long the `timeout` mode blocks, ms. Longer than any test's spawn timeout. */
const TIMEOUT_BLOCK_MS = 60_000;

/**
 * Thrown by {@link injectFaultIfArmed} for a `crash` fault. A distinct type so a
 * handler (or a test) can tell an injected fault from a genuine bug.
 */
export class InjectedFaultError extends Error {
  /** @param {string} site */
  constructor(site) {
    super(`[fault-injection] injected crash at "${site}" (DEVMATE_FAULT)`);
    this.name = 'InjectedFaultError';
    /** @type {string} */
    this.site = site;
  }
}

/**
 * The fault mode armed for `site`, or null when the seam is inert for it.
 *
 * Parses the strict grammar `"<site>:<mode>"` (a single colon). The asking site
 * must itself be a known {@link FAULT_SITES} member, the spec must target THAT
 * site, and the mode must be known — otherwise the seam does nothing. Validating
 * the asking site (rather than re-checking the parsed site, which is redundant
 * once it must equal the asking site) makes an unknown site impossible to arm at
 * all. No dynamic `RegExp`, no table indexed by a runtime string: only
 * `String.prototype` ops and frozen-Set membership, so the security lint has
 * nothing to flag.
 *
 * @param {string} site   The call site asking whether it is armed.
 * @param {NodeJS.ProcessEnv} [env]  Injected environment (defaults to the process env).
 * @returns {'crash'|'timeout'|null}
 */
export function armedFaultFor(site, env = process.env) {
  if (!FAULT_SITES.has(site)) return null;

  const raw = env[ENV_VAR];
  if (typeof raw !== 'string' || raw === '') return null;

  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return null;

  const specSite = raw.slice(0, colon);
  const specMode = raw.slice(colon + 1);
  if (specSite !== site) return null;
  if (!FAULT_MODES.has(specMode)) return null;

  return /** @type {'crash'|'timeout'} */ (specMode);
}

/**
 * Block the current thread for `ms` without a timer, so the process appears hung
 * to the host exactly as a wedged synchronous hook would. `Atomics.wait` on a
 * never-notified location is the deterministic way to do this; a SIGTERM from the
 * host's timeout still terminates the process.
 * @param {number} ms
 * @returns {void}
 */
function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * If a fault is armed for `site`, enact it; otherwise return immediately.
 *
 * In production this is one `Set` lookup that returns null and falls through.
 *
 * @param {string} site
 * @param {{ env?: NodeJS.ProcessEnv, sleepMs?: number }} [opts]
 * @returns {void}
 */
export function injectFaultIfArmed(site, opts = {}) {
  const mode = armedFaultFor(site, opts.env ?? process.env);
  if (mode === null) return;
  if (mode === 'crash') throw new InjectedFaultError(site);
  // mode === 'timeout'
  blockingSleep(opts.sleepMs ?? TIMEOUT_BLOCK_MS);
}
