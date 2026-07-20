// @ts-check
/**
 * Per-session "this is a devmate workflow" marker.
 *
 * ## Why this exists
 *
 * devmate registers its hooks plugin-level (`.plugin/plugin.json` →
 * `hooks/hooks.json`), which is the only registration form VS Code actually
 * honours for a distributed plugin — agent-scoped frontmatter hooks cannot
 * resolve a plugin-shipped script's path (proven: `${PLUGIN_ROOT}` is not
 * expanded in frontmatter, and a relative command resolves against the
 * workspace cwd, not the agent file). The cost of plugin-level registration is
 * that every hook fires in EVERY session, so a fail-closed guard like
 * gate-guard could block a user who never invoked devmate at all.
 *
 * This marker is the runtime scope. A devmate session is one in which a devmate
 * agent has been dispatched — the host announces that via
 * `SubagentStart.agent_type` (the ONLY payload field that carries agent
 * identity; PreToolUse/PostToolUse/etc. carry none). On the first devmate
 * `SubagentStart` we drop a marker keyed by `session_id`; every blocking or
 * state-writing handler checks for it first and stays fully inert when it is
 * absent. No marker ⇒ no deny, no `.devmate` write, no context injection —
 * regardless of what any stray `task.json` on disk happens to say.
 *
 * ## Fail-open by construction
 *
 * The guarantee the user cares about is "never blocked outside a devmate
 * session." So {@link isDevmateSession} treats *every* uncertainty as
 * not-devmate: a missing/blank `session_id`, an unreadable temp dir, any thrown
 * error → `false` → the caller bails inert → the tool call is allowed. Marking
 * and clearing are equally best-effort; losing the marker degrades to inert,
 * never to a crash or a spurious block.
 *
 * ## Location
 *
 * The marker lives in the OS temp dir, never the workspace — a non-devmate repo
 * (or a devmate repo driven by a non-devmate session) gets zero files written
 * into it. Temp is self-clearing, so a marker that outlives its session is
 * eventually reaped by the OS even if `clearDevmateSession` never runs; and
 * `session_id`s are host UUIDs, so cross-session collision is not a concern.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureDirSync,
  pathExists,
  statPathSync,
  writeTextFileSync,
  removeFileSync,
} from '../fs-safe.mjs';

/** Sub-directory of `os.tmpdir()` that holds the per-session markers. */
const MARKER_DIR = join(tmpdir(), 'devmate', 'sessions');

/**
 * How long a marker stays valid after its last refresh.
 *
 * Why expiry at all: VS Code REUSES a chat session's `session_id` across window
 * reloads (verified from two captured logs hours apart carrying the same id),
 * and `Stop` fires at the end of every TURN — while a devmate workflow is
 * inherently multi-turn (the human spec-approval gate is answered in a later
 * turn). So there is no reliable "session over" event to clear on: clearing on
 * `Stop` would unmark a workflow between its own turns, and Windows never
 * reaps `%TEMP%` on its own.
 *
 * Expiry is activity-based instead: every devmate SubagentStart re-writes the
 * marker (refreshing its mtime), so an ACTIVE workflow never ages out, while an
 * abandoned chat thread stops being treated as devmate after the TTL. If a
 * workflow resumes after a longer pause, its first dispatch re-marks the
 * session — the same accepted bootstrap gap a brand-new session has.
 */
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reduce a host `session_id` to a filesystem-safe basename, or `null` when it
 * yields nothing usable. Mirrors the slug discipline in
 * `lib/workflow/bootstrap-task-state.mjs` so a session id maps to one stable
 * name across handlers.
 *
 * @param {unknown} sessionId
 * @returns {string|null}
 */
function slug(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const cleaned = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return cleaned === '' ? null : cleaned;
}

/**
 * Absolute path of the marker file for a session, or `null` when the session id
 * is unusable (in which case there is no marker to read or write and callers
 * treat the session as not-devmate).
 *
 * @param {unknown} sessionId
 * @returns {string|null}
 */
export function sessionMarkerPath(sessionId) {
  const name = slug(sessionId);
  return name === null ? null : join(MARKER_DIR, `${name}.json`);
}

/**
 * Mark a session as an active devmate workflow. Best-effort: any failure is
 * swallowed, because a session that cannot be marked simply degrades to inert
 * enforcement — never to a crash that would take down the subagent start.
 *
 * @param {unknown} sessionId  The host `session_id` from the hook payload.
 * @param {string} [agentType] The dispatched `agent_type`, recorded for
 *   debugging only; presence of the file, not its content, is what counts.
 * @returns {void}
 */
export function markDevmateSession(sessionId, agentType) {
  const markerPath = sessionMarkerPath(sessionId);
  if (markerPath === null) return;
  try {
    ensureDirSync(MARKER_DIR);
    writeTextFileSync(
      markerPath,
      JSON.stringify({ sessionId, agentType: agentType ?? null, ts: new Date().toISOString() }),
    );
  } catch {
    // Inert-on-failure: an unmarkable session is treated as not-devmate.
  }
}

/**
 * Is this session an active devmate workflow?
 *
 * Fail-open: returns `false` for a blank/invalid `session_id`, for a marker
 * older than {@link MARKER_TTL_MS} (an abandoned thread must not stay enforced
 * forever — see the TTL rationale above), or on ANY error, so a caller that
 * gates its blocking/writing behavior on this can never block or write in a
 * session it cannot positively identify as devmate.
 *
 * @param {unknown} sessionId  The host `session_id` from the hook payload.
 * @param {number} [now]  Injected clock for tests; defaults to Date.now().
 * @returns {boolean}
 */
export function isDevmateSession(sessionId, now = Date.now()) {
  const markerPath = sessionMarkerPath(sessionId);
  if (markerPath === null) return false;
  try {
    // statPathSync throws on a missing marker — caught below as not-devmate.
    const stat = statPathSync(markerPath);
    return now - stat.mtimeMs <= MARKER_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Convenience for hook entrypoints: read `session_id` out of a freshly parsed
 * stdin payload and check the marker. Anything that is not a plain object (or
 * carries no usable id) is not a devmate session — same fail-open contract as
 * {@link isDevmateSession}.
 *
 * @param {unknown} payload  The JSON.parse'd hook payload.
 * @returns {boolean}
 */
export function isDevmatePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return isDevmateSession(/** @type {Record<string, unknown>} */ (payload)['session_id']);
}

/**
 * Remove a session's marker (best-effort). Called on session end so a long-lived
 * temp dir does not accumulate markers; a no-op when the marker is already gone.
 *
 * @param {unknown} sessionId
 * @returns {void}
 */
export function clearDevmateSession(sessionId) {
  const markerPath = sessionMarkerPath(sessionId);
  if (markerPath === null) return;
  try {
    if (pathExists(markerPath)) removeFileSync(markerPath);
  } catch {
    // Best-effort: a marker we cannot delete is reaped by the OS temp sweep.
  }
}
