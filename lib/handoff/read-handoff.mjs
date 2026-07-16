// @ts-check

/**
 * E6-3: Read + validate a task's handoff artifact.
 *
 * Reads `.devmate/state/handoff/<taskId>/handoff.json`, validates required
 * fields and `schemaVersion`, and returns a typed `HandoffArtifact`. Throws a
 * descriptive `Error` (never a raw stack) on a missing or malformed file, and
 * never modifies the file.
 */

import path from "node:path";
import { readTextFile } from "../fs-safe.mjs";
import {
  HANDOFF_SCHEMA_VERSION,
  handoffTaskDir,
  validateHandoffInput,
} from "./write-handoff.mjs";

/** @typedef {import('../types.mjs').HandoffArtifact} HandoffArtifact */

/**
 * Read and validate a handoff artifact.
 * @param {string} taskId
 * @param {{ handoffDir?: string }} [opts]
 * @returns {Promise<HandoffArtifact>}
 */
export async function readHandoff(taskId, opts = {}) {
  const jsonPath = path.join(
    handoffTaskDir(taskId, opts.handoffDir),
    "handoff.json",
  );

  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(jsonPath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`handoff not found for task "${taskId}" at ${jsonPath}`);
    }
    throw new Error(
      `failed to read handoff for task "${taskId}": ${err && err.message}`,
    );
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `malformed handoff JSON for task "${taskId}" at ${jsonPath}`,
    );
  }

  // Reuse input validation for the logical fields.
  const { ok, errors } = validateHandoffInput(parsed);
  if (!ok) {
    throw new Error(
      `invalid handoff for task "${taskId}": ${errors.join("; ")}`,
    );
  }

  const a = /** @type {Record<string, unknown>} */ (parsed);
  if (typeof a.ts !== "string" || a.ts.length === 0) {
    throw new Error(`invalid handoff for task "${taskId}": missing ts`);
  }
  if (a.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    throw new Error(
      `handoff schemaVersion mismatch for task "${taskId}": expected ${HANDOFF_SCHEMA_VERSION}, got ${a.schemaVersion}`,
    );
  }

  return /** @type {HandoffArtifact} */ (parsed);
}
