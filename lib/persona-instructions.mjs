// @ts-check
import { resolve, isAbsolute } from 'node:path';
import { readTextFile } from './fs-safe.mjs';

/** @typedef {import('./types.mjs').PersonaEntry} PersonaEntry */

/**
 * Load the persona instruction file content for dispatch-time context injection.
 *
 * Returns an empty string when:
 *   - `persona.instructionFile` is null, undefined, or an empty string
 *   - the resolved file does not exist or cannot be read
 *
 * This helper never throws. File-absence is treated as a non-fatal condition so
 * dispatch always proceeds; missing instructions simply mean no prefix is injected.
 *
 * Relative `instructionFile` paths are resolved against `repoRoot`. Absolute
 * paths are honored as-is.
 *
 * @param {string} repoRoot   Absolute path to the repo root.
 * @param {PersonaEntry} persona  Persona config entry to load instructions for.
 * @returns {Promise<string>} The file content, or '' when nothing to inject.
 */
export async function loadPersonaInstructions(repoRoot, persona) {
  const rel = persona?.instructionFile;
  if (typeof rel !== 'string' || rel.trim() === '') {
    return '';
  }
  const fullPath = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
  try {
    const content = await readTextFile(fullPath);
    return content;
  } catch (/** @type {unknown} */ _err) {
    return '';
  }
}

/**
 * Result of validating persona instruction file references at session start.
 * @typedef {Object} PersonaInstructionValidationResult
 * @property {string[]} missing  Personas whose instructionFile is declared but missing on disk.
 * @property {string[]} present  Personas whose instructionFile was declared and resolved.
 */

/**
 * Synchronously check whether each persona's declared `instructionFile` exists on disk.
 * Personas with a null or omitted `instructionFile` are skipped entirely.
 * Used by `session-start.mjs` to emit a non-blocking warning when a referenced file is absent.
 *
 * @param {string} repoRoot     Absolute path to the repo root.
 * @param {PersonaEntry[]} personas
 * @param {(path: string) => boolean} existsFn  Injectable existence check (defaults wired by caller).
 * @returns {PersonaInstructionValidationResult}
 */
export function checkPersonaInstructionFiles(repoRoot, personas, existsFn) {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const present = [];
  for (const persona of personas) {
    const rel = persona?.instructionFile;
    if (typeof rel !== 'string' || rel.trim() === '') {
      continue;
    }
    const fullPath = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
    if (existsFn(fullPath)) {
      present.push(persona.persona);
    } else {
      missing.push(persona.persona);
    }
  }
  return { missing, present };
}
