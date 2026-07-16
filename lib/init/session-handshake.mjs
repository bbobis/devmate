// @ts-check
import { join } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';

/**
 * The devmate handshake block the extension writes into `.devmate/session.json`.
 * @typedef {Object} SessionHandshake
 * @property {'multi-root'} mode
 * @property {string}       primary     Repo name of the orchestrator entry point.
 * @property {string}       configPath  Merged config path, relative to the workspace root.
 */

/**
 * The session.json schema version this consumer understands — the pin for the
 * shared session-handshake contract (`handshakeVersion` in the corpus manifest
 * at test/fixtures/session-handshake, vendored schema at
 * docs/session-handshake.schema.json). Mirrors the producer's
 * SESSION_SCHEMA_VERSION in monoroot.
 * @type {number}
 */
export const SESSION_SCHEMA_VERSION = 2;

/**
 * Pure structural parse of an already-parsed `.devmate/session.json` value.
 * Returns the `{ mode, primary, configPath }` handshake block, or `null` when
 * the value is not a schemaVersion-2 multi-root session with a well-formed
 * devmate block. Never throws. This is the consumer's half of the shared
 * session-handshake contract — the fixtures corpus runs through it directly,
 * so the two hand validators (this and monoroot's isValidSession) can never
 * silently drift.
 *
 * @param {unknown} parsed  A parsed session.json value.
 * @returns {SessionHandshake|null}
 */
export function parseSessionHandshake(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  if (obj['schemaVersion'] !== SESSION_SCHEMA_VERSION) {
    return null;
  }
  const devmate = obj['devmate'];
  if (devmate === null || typeof devmate !== 'object' || Array.isArray(devmate)) {
    return null;
  }
  const d = /** @type {Record<string, unknown>} */ (devmate);
  if (
    d['mode'] !== 'multi-root' ||
    typeof d['primary'] !== 'string' ||
    typeof d['configPath'] !== 'string'
  ) {
    return null;
  }
  return {
    mode: 'multi-root',
    primary: d['primary'],
    configPath: d['configPath'],
  };
}

/**
 * B10: Read the extension's `.devmate/session.json` handshake, when present and
 * valid.
 *
 * monoroot writes this alongside the merged config as a
 * direct pointer to the primary repo and config path, so the plugin does not
 * have to re-derive them. Returns the `{ mode, primary, configPath }` block, or
 * `null` when the file is absent, unreadable, malformed, or not a
 * schemaVersion-2 multi-root session. Never throws — callers fall back to the
 * config-derived resolution (`resolveRepoRoot` step 0 + `dirname` derivation),
 * so this strictly enriches and never becomes a new hard dependency.
 *
 * @param {string} repoRoot  Absolute path to the resolved workspace root.
 * @returns {Promise<SessionHandshake|null>}
 */
export async function readSessionHandshake(repoRoot) {
  const sessionPath = join(repoRoot, '.devmate', 'session.json');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readTextFile(sessionPath));
  } catch {
    return null;
  }
  return parseSessionHandshake(parsed);
}
