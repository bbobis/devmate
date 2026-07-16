// @ts-check
/**
 * Turn what an agent SENDS into what an artifact must BE.
 *
 * Two transforms, and each one exists because a real lane died without it:
 *
 *  1. {@link unwrapEnvelope} — `agents/rubber-duck.agent.md` documents a return whose
 *     body is nested under `report`; `validateGrillResult` reads its fields at the
 *     TOP level. An agent that obeyed its own card therefore failed validation on
 *     ~11 fields, `grill-result.json` was never written, and the bug lane — whose
 *     only pre-implementation transition is gated on that file — wedged forever.
 *     Rewriting the card alone would fix today's drift and nothing else: a model
 *     that wraps its answer one level deep is a permanent fact of the medium, so
 *     the boundary absorbs it. Be liberal in what you accept, strict in what you
 *     write to disk.
 *
 *  2. {@link stampMachineFields} — `taskId`, `schemaVersion` and `returnedAt` are
 *     facts the HOST holds: task state, a constant, and the hook's own clock. The
 *     agent holds none of them. Requiring a language model to emit all three made
 *     every artifact a coin-flip, and a single forgotten field voided the whole
 *     return silently. The host knows them, so the host writes them, and the agent
 *     is left to supply only its analysis — the one thing it is actually for.
 *
 * `now` is injected, never read here: these values get snapshotted and replayed, and
 * a wall-clock read inside the transform would make the same input produce a
 * different artifact on every run.
 */
import { getOwn } from '../object-utils.mjs';

/** The schema version every projected artifact carries. */
export const SCHEMA_VERSION = 1;

/**
 * Fields hoisted from the envelope onto the body when the body does not already
 * carry them. `mode` is the discriminator that tells a grill from a critique, so
 * losing it in the unwrap would make the return unattributable to a contract.
 * @type {readonly string[]}
 */
const CARRIED_KEYS = Object.freeze(['agentName', 'mode', 'taskId']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Hoist a `report`-nested body to the top level, carrying the envelope's
 * discriminating fields with it. A flat return passes through untouched, so this is
 * safe to apply to every agent whether or not it wraps.
 *
 * @param {unknown} result  The parsed return, as the worker sent it.
 * @returns {unknown}  The body, at the top level.
 */
export function unwrapEnvelope(result) {
  if (!isRecord(result)) return result;

  const report = getOwn(result, 'report');
  if (!isRecord(report)) return result;

  // A Map, not an object literal keyed by a runtime string: assigning `obj[name]`
  // from a value the MODEL chose is the prototype-pollution surface the security lint
  // rejects, and a worker's return is exactly model-chosen input.
  /** @type {Map<string, unknown>} */
  const carried = new Map();

  for (const field of CARRIED_KEYS) {
    const value = getOwn(result, field);
    // The body wins: if the agent set the field in both places, the one next to the
    // analysis is the one it meant.
    if (value !== undefined && getOwn(report, field) === undefined) carried.set(field, value);
  }

  return { ...report, ...Object.fromEntries(carried) };
}

/**
 * Write the host-owned fields onto a return body.
 *
 * `taskId` is taken from task state and OVERRIDES whatever the agent claimed. That
 * is deliberate: the artifact must be bound to the task the host is actually
 * running, or a stale artifact from an earlier task keeps satisfying this task's
 * gate — which is exactly how a superseded `diagnosis.json` went on authorizing a
 * fix nobody had re-diagnosed.
 *
 * `returnedAt` is stamped from the injected clock — but an EMPTY clock stamps
 * nothing rather than an empty string. The host may only overwrite a field when it
 * has something better to write; a caller that passed no clock has not given it
 * anything better, and blanking a timestamp the agent did supply would turn a valid
 * artifact into an invalid one. Absent both, the field stays missing and the
 * validator says so out loud — which is the honest failure.
 *
 * @param {unknown} body
 * @param {{ taskId: string, now: string }} host
 * @returns {Record<string, unknown>}
 */
export function stampMachineFields(body, host) {
  const base = isRecord(body) ? body : {};

  const existing = getOwn(base, 'returnedAt');
  const carried = typeof existing === 'string' && existing.trim() !== '' ? existing : undefined;
  const returnedAt = host.now.trim() !== '' ? host.now : carried;

  /** @type {Record<string, unknown>} */
  const stamped = {
    ...base,
    taskId: host.taskId,
    schemaVersion: SCHEMA_VERSION,
  };
  if (returnedAt !== undefined) stamped['returnedAt'] = returnedAt;
  return stamped;
}

/**
 * The full boundary transform: unwrap, then stamp.
 *
 * @param {unknown} result
 * @param {{ taskId: string, now: string }} host
 * @returns {Record<string, unknown>}
 */
export function normalizeAgentReturn(result, host) {
  return stampMachineFields(unwrapEnvelope(result), host);
}
