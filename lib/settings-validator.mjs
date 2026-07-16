// @ts-check
import { fileURLToPath } from 'node:url';
import { readTextFile, readTextFileSync } from './fs-safe.mjs';

/**
 * @typedef {Object} VerifiedSetting
 * @property {string} key           Full VS Code setting key (e.g. 'github.copilot.enable').
 * @property {string} evidenceUrl   Official docs URL confirming this key exists.
 * @property {string} [description] Short human-readable description.
 */

/**
 * @typedef {Object} SettingsValidationResult
 * @property {boolean} ok
 * @property {string[]} unknownKeys   Keys found in file not in the verified set.
 * @property {string[]} validKeys     Keys found and confirmed.
 */

/**
 * @typedef {Object} VerifiedSettingsFile
 * @property {number} schemaVersion
 * @property {string} evidenceUrl
 * @property {VerifiedSetting[]} settings
 */

/**
 * Default path to the verified-settings allowlist (relative to this module).
 * fileURLToPath, never URL.pathname: pathname is /C:/... on Windows (breaks
 * as a filesystem path) and keeps percent-encoding on every platform.
 */
const DEFAULT_ALLOWLIST = fileURLToPath(new URL('../docs/verified-settings.json', import.meta.url));

/**
 * Load the verified settings allowlist from `docs/verified-settings.json`.
 * Throws on malformed JSON — does NOT overwrite the file.
 * @param {string} [allowlistPath]  Override for tests.
 * @returns {VerifiedSetting[]}
 */
export function loadKnownSettings(allowlistPath) {
  const p = allowlistPath ?? DEFAULT_ALLOWLIST;
  let raw;
  try {
    raw = readTextFileSync(p);
  } catch (err) {
    throw new Error(`settings-validator: cannot read allowlist at ${p}: ${/** @type {Error} */ (err).message}`);
  }
  /** @type {VerifiedSettingsFile} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`settings-validator: malformed JSON in allowlist ${p}: ${/** @type {Error} */ (err).message}`);
  }
  if (!Array.isArray(parsed.settings)) {
    throw new Error(`settings-validator: allowlist ${p} must have a "settings" array`);
  }
  return parsed.settings;
}

/**
 * Strip single-line `//` comments from a JSONC string.
 * Only strips `//` that appear outside string literals.
 * @param {string} text
 * @returns {string}
 */
function stripJsoncComments(text) {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        result += ch + text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      result += ch;
      i++;
    } else {
      if (ch === '"') {
        inString = true;
        result += ch;
        i++;
      } else if (ch === '/' && text.charAt(i + 1) === '/') {
        while (i < text.length && text[i] !== '\n') {
          i++;
        }
      } else {
        result += ch;
        i++;
      }
    }
  }
  return result;
}

/**
 * Extract VS Code setting keys from a JSON or JSONC settings file.
 * Returns the top-level keys (which are dot-separated VS Code setting names).
 * @param {string} filePath
 * @returns {Promise<string[]>}
 */
export async function extractSettingKeys(filePath) {
  const raw = await readTextFile(filePath);
  const stripped = stripJsoncComments(raw);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`settings-validator: cannot parse ${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  return Object.keys(/** @type {Record<string, unknown>} */ (parsed));
}

/**
 * Validate extracted keys against the known-settings allowlist.
 * @param {string[]} keys
 * @param {VerifiedSetting[]} knownSettings
 * @returns {SettingsValidationResult}
 */
export function validateSettingKeys(keys, knownSettings) {
  const knownSet = new Set(knownSettings.map((s) => s.key));
  /** @type {string[]} */
  const validKeys = [];
  /** @type {string[]} */
  const unknownKeys = [];
  for (const k of keys) {
    if (knownSet.has(k)) {
      validKeys.push(k);
    } else {
      unknownKeys.push(k);
    }
  }
  return { ok: unknownKeys.length === 0, unknownKeys, validKeys };
}
