// @ts-check

/**
 * E6-4: Audit a single agent action into the unified trace.
 *
 * `auditAction` turns a small, identity-only entry (taskId/stepId/actionType/
 * path) into a fully-formed TraceActionEvent and appends it through the one
 * shared append path (appendTraceEvent). It deliberately records only a
 * deterministic digest of (path + actionType) — never raw file content — so
 * the trace stays bounded and never leaks the contents of edited files.
 */

import { createHash } from 'node:crypto';
import { appendTraceEvent } from './append.mjs';

/** @typedef {import('../types.mjs').AuditActionEntry} AuditActionEntry */
/** @typedef {import('../types.mjs').TraceActionEvent} TraceActionEvent */

/** Trace schema version this module emits. */
const SCHEMA_VERSION = 1;

/** Length (hex chars) of the bounded action digest. */
const DIGEST_LEN = 16;

/**
 * Compute the bounded, content-free digest for an action.
 * Hashes only the action's identity (path + actionType), never file content,
 * and truncates to a fixed 16 hex characters.
 * @param {string} path
 * @param {string} actionType
 * @returns {string} 16 lowercase hex characters.
 */
export function actionDigest(path, actionType) {
  return createHash('sha256')
    .update(path + '|' + actionType)
    .digest('hex')
    .slice(0, DIGEST_LEN);
}

/**
 * Append one action event to the task trace.
 *
 * Builds a TraceActionEvent from the entry: copies taskId/stepId/actionType/
 * path, stamps `ts` with the current ISO time, sets schemaVersion, and
 * computes a 16-hex digest from (path + actionType). Delegates the actual
 * write (and validation) to appendTraceEvent.
 *
 * @param {AuditActionEntry} entry
 * @param {{ root: string }} opts  Absolute workspace root (resolveHookRoot) or a test tmp dir.
 * @returns {Promise<{ ok: boolean, lineNumber: number, errors?: string[] }>}
 */
export async function auditAction(entry, opts) {
  /** @type {TraceActionEvent} */
  const event = {
    type: 'action',
    taskId: entry.taskId,
    stepId: entry.stepId,
    ts: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    actionType: entry.actionType,
    path: entry.path,
    digest: actionDigest(entry.path, entry.actionType),
  };

  return appendTraceEvent(event, opts);
}
