// @ts-check
import { resolve, dirname } from 'node:path';
import { readTextFileSync } from '../fs-safe.mjs';
import { fileURLToPath } from 'node:url';

/** @typedef {import('../types.mjs').CapabilityType} CapabilityType */
/** @typedef {import('../types.mjs').CapabilityEntry} CapabilityEntry */
/** @typedef {import('../types.mjs').CapabilityRegistry} CapabilityRegistry */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = resolve(__dirname, '../../docs/capability-registry.json');

/** @type {readonly CapabilityType[]} */
const VALID_TYPES = /** @type {const} */ (['agent', 'command', 'skill', 'hook', 'script']);

/** @type {readonly string[]} */
const VALID_INVOCATIONS = /** @type {const} */ (['auto-registered', 'agent-invoked', 'user-invoked']);

/**
 * Load and parse `docs/capability-registry.json`.
 * Throws on file-read failure or malformed JSON without modifying the file.
 * @param {string} [registryPath]  Override for tests.
 * @returns {CapabilityRegistry}
 */
export function loadRegistry(registryPath) {
  const filePath = registryPath ?? DEFAULT_REGISTRY_PATH;
  let raw;
  try {
    raw = readTextFileSync(filePath);
  } catch (/** @type {any} */ err) {
    throw new Error(`Failed to read capability registry at ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (/** @type {any} */ err) {
    throw new Error(
      `Malformed JSON in capability registry at ${filePath}: ${err.message}. ` +
      'The file has not been modified — fix it manually.'
    );
  }
}

/**
 * Validate a registry object against required fields and known types.
 * @param {unknown} registry
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRegistry(registry) {
  /** @type {string[]} */
  const errors = [];

  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return { ok: false, errors: ['Registry must be a plain object.'] };
  }

  const r = /** @type {Record<string, unknown>} */ (registry);

  if (typeof r['schemaVersion'] !== 'number') {
    errors.push('Missing or invalid `schemaVersion` (must be a number).');
  }

  if (!Array.isArray(r['capabilities'])) {
    errors.push('`capabilities` must be an array.');
    return { ok: errors.length === 0, errors };
  }

  const capabilities = /** @type {unknown[]} */ (r['capabilities']);
  capabilities.forEach((entry, idx) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`capabilities[${idx}]: must be a plain object.`);
      return;
    }
    const e = /** @type {Record<string, unknown>} */ (entry);

    if (typeof e['id'] !== 'string' || e['id'].trim() === '') {
      errors.push(`capabilities[${idx}]: \`id\` must be a non-empty string.`);
    }

    if (!VALID_TYPES.includes(/** @type {CapabilityType} */ (e['type']))) {
      errors.push(
        `capabilities[${idx}]: unknown \`type\` "${e['type']}". ` +
        `Allowed: ${VALID_TYPES.join(', ')}.`
      );
    }

    if (typeof e['name'] !== 'string' || e['name'].trim() === '') {
      errors.push(`capabilities[${idx}]: \`name\` must be a non-empty string.`);
    }

    if (typeof e['description'] !== 'string' || e['description'].trim() === '') {
      errors.push(`capabilities[${idx}]: \`description\` must be a non-empty string.`);
    }

    if (typeof e['invocationPath'] !== 'string' || e['invocationPath'].trim() === '') {
      errors.push(`capabilities[${idx}]: \`invocationPath\` must be a non-empty string.`);
    }

    if (!VALID_INVOCATIONS.includes(/** @type {string} */ (e['invocation']))) {
      errors.push(
        `capabilities[${idx}]: unknown \`invocation\` "${e['invocation']}". ` +
        `Allowed: ${VALID_INVOCATIONS.join(', ')}.`
      );
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Render a markdown table of capabilities filtered by type.
 * Columns: | ID | Type | Name | Description | Invocation |
 * @param {CapabilityEntry[]} entries
 * @param {CapabilityType} [filterType]  Omit to include all types.
 * @returns {string}  Markdown table string.
 */
export function renderCapabilityTable(entries, filterType) {
  const rows = filterType ? entries.filter((e) => e.type === filterType) : entries;
  const header = '| ID | Type | Name | Description | Invocation |';
  const separator = '|---|---|---|---|---|';
  const body = rows
    .map((e) => `| ${e.id} | ${e.type} | ${e.name} | ${e.description} | ${e.invocation} |`)
    .join('\n');
  if (rows.length === 0) {
    return `${header}\n${separator}\n`;
  }
  return `${header}\n${separator}\n${body}\n`;
}
