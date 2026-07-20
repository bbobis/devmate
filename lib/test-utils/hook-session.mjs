// @ts-check
/**
 * Test helper: run a spawned hook as if inside an active devmate session.
 *
 * devmate's hooks are inert outside a devmate session (see
 * lib/hooks/session-marker.mjs) — a spawned gate-guard with no session marker
 * allows every tool call. Enforcement tests, which assert denies, therefore need
 * the session marked first. This wraps that: inject a unique `session_id` into
 * the payload (unless it already carries one), mark it as devmate, run the
 * synchronous spawn, and clear the marker afterwards — race-free because the
 * mark/spawn/clear all happen within one synchronous call.
 */
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { markDevmateSession, clearDevmateSession } from '../hooks/session-marker.mjs';

/**
 * Mark a fixed `session_id` as devmate for the whole test file AND register an
 * `after()` hook to clear it — so a file that marks one session at module load
 * never leaks its marker into the OS temp dir (cross-test/process hygiene).
 * Call once at the top of a file whose payloads all carry the same session id.
 *
 * @param {string} sessionId
 * @param {string} [agentType]
 * @returns {string} the same sessionId, for `const ID = markSessionForFile(ID)` use.
 */
export function markSessionForFile(sessionId, agentType = 'router') {
  markDevmateSession(sessionId, agentType);
  after(() => clearDevmateSession(sessionId));
  return sessionId;
}

/**
 * @template T
 * @param {unknown} stdinObj  The hook payload (usually a plain object).
 * @param {(payload: unknown) => T} run  Spawns the hook with `payload` and returns its result.
 * @returns {T}
 */
export function withMarkedSession(stdinObj, run) {
  const { sid, payload } = injectSessionId(stdinObj);
  markDevmateSession(sid, 'router');
  try {
    return run(payload);
  } finally {
    clearDevmateSession(sid);
  }
}

/**
 * Async variant for direct-call handler tests (`await runWithIO(...)`). The
 * sync version's `finally` would clear the marker as soon as the promise is
 * CREATED — while the handler is still reading stdin — so async callers must
 * use this one, which clears only after the promise settles.
 *
 * @template T
 * @param {unknown} stdinObj
 * @param {(payload: unknown) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withMarkedSessionAsync(stdinObj, run) {
  const { sid, payload } = injectSessionId(stdinObj);
  markDevmateSession(sid, 'router');
  try {
    return await run(payload);
  } finally {
    clearDevmateSession(sid);
  }
}

/**
 * @param {unknown} stdinObj
 * @returns {{ sid: string, payload: unknown }}
 */
function injectSessionId(stdinObj) {
  const isObj = stdinObj !== null && typeof stdinObj === 'object' && !Array.isArray(stdinObj);
  const existing = isObj ? /** @type {Record<string, unknown>} */ (stdinObj)['session_id'] : undefined;
  const sid = typeof existing === 'string' && existing !== '' ? existing : randomUUID();
  // Spread first, then set session_id LAST so the computed sid always wins — a
  // falsy/non-string session_id already on stdinObj (e.g. '') must not clobber
  // it back and leave the payload unscoped while the marker was written for sid.
  const payload = isObj ? { .../** @type {object} */ (stdinObj), session_id: sid } : stdinObj;
  return { sid, payload };
}
