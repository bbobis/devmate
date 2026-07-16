// @ts-check
/**
 * The `model:` frontmatter field of an agent is consumed by the VS Code Copilot
 * host, never by devmate — so nothing in this repo used to read it, and nothing
 * checked it. A typo (`Claude Sonet 4.6 (copilot)`) shipped green: VS Code fails
 * to resolve the name and silently falls back to whatever model the picker is on,
 * which means the agent's model becomes unknown at exactly the point the file
 * claims to fix it. That is the inert-layer bug class (docs/PATTERNS.md).
 *
 * This module is the ground truth that makes the field checkable:
 *   - `models`        — the allowlist of qualified names verified against GitHub's docs.
 *   - `inheritPicker` — the agents deliberately shipped with NO `model:` key.
 *
 * Why an agent may legitimately have no `model:` — VS Code: "If not specified,
 * the currently selected model in model picker is used." With the picker on
 * Auto, that agent inherits GitHub's auto model selection (complexity routing +
 * a 10% discount). Omitting the key is the ONLY documented route to Auto;
 * `model: Auto (copilot)` is not a documented value and resolves to nothing.
 * Requiring those agents to be named in `inheritPicker` is what keeps an absent
 * `model:` a reviewed decision rather than an oversight.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextFileSync } from './fs-safe.mjs';
import { getOwn, isPlainRecord, isNonEmptyString } from './object-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the catalog, resolved from this module (never cwd). */
export const DEFAULT_CATALOG_PATH = resolve(__dirname, '..', 'config', 'model-catalog.json');

/**
 * @typedef {Object} ModelCatalogEntry
 * @property {number} input    USD per 1M input tokens.
 * @property {number} output   USD per 1M output tokens.
 * @property {string} bestFor  The task class GitHub's model comparison assigns it.
 */

/**
 * @typedef {Object} ModelCatalog
 * @property {number} schemaVersion
 * @property {string} verifiedAt                        ISO date the names were confirmed.
 * @property {string} source                            URL of the official docs confirming them.
 * @property {Record<string, ModelCatalogEntry>} models Allowlisted qualified model names.
 * @property {string[]} inheritPicker                   Agent basenames intentionally left unpinned.
 */

/**
 * @typedef {Object} ModelRuleViolation
 * @property {string} message
 */

/**
 * Load and shape-check the catalog. Throws on a malformed or unverified catalog:
 * names that were never confirmed against a source are exactly what this file
 * exists to prevent, so an unsourced catalog is a hard failure, not a warning.
 * @param {{ catalogPath?: string }} [options]
 * @returns {ModelCatalog}
 */
export function loadModelCatalog(options = {}) {
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const raw = JSON.parse(readTextFileSync(catalogPath));

  if (!isPlainRecord(raw)) throw new Error(`${catalogPath}: catalog must be an object`);
  if (typeof raw.schemaVersion !== 'number') throw new Error(`${catalogPath}: schemaVersion must be a number`);
  if (!isNonEmptyString(raw.verifiedAt)) throw new Error(`${catalogPath}: verifiedAt must be an ISO date string`);
  if (!isNonEmptyString(raw.source)) throw new Error(`${catalogPath}: source must be a URL to the official docs confirming these model names (a verifiedAt date without a source proves nothing)`);
  if (!isPlainRecord(raw.models)) throw new Error(`${catalogPath}: models must be an object`);
  if (!Array.isArray(raw.inheritPicker)) throw new Error(`${catalogPath}: inheritPicker must be an array`);

  for (const [name, entry] of Object.entries(raw.models)) {
    if (!isPlainRecord(entry)) throw new Error(`${catalogPath}: models["${name}"] must be an object`);
    if (typeof entry.input !== 'number' || typeof entry.output !== 'number') {
      throw new Error(`${catalogPath}: models["${name}"] needs numeric input and output prices`);
    }
    if (!isNonEmptyString(entry.bestFor)) {
      throw new Error(`${catalogPath}: models["${name}"] needs a bestFor rationale`);
    }
  }
  for (const agent of raw.inheritPicker) {
    if (!isNonEmptyString(agent)) throw new Error(`${catalogPath}: inheritPicker entries must be agent basenames`);
  }

  return /** @type {ModelCatalog} */ (raw);
}

/**
 * Check one agent's `model:` declaration against the catalog.
 *
 * An agent is either *pinned* (declares `model:`, every entry allowlisted) or
 * *inherit-picker* (declares no `model:` and is named in `inheritPicker`).
 * Anything else — an unlisted agent with no model, a pinned agent that is also
 * listed as inherit-picker, an unknown name — is a violation.
 *
 * @param {import('./agent-validator.mjs').AgentFrontmatter} frontmatter
 * @param {string} agentBasename  File basename without `.agent.md` (the identity validate-agents keys on).
 * @param {ModelCatalog} catalog
 * @returns {ModelRuleViolation[]}
 */
export function checkModelRule(frontmatter, agentBasename, catalog) {
  /** @type {ModelRuleViolation[]} */
  const violations = [];
  const declared = frontmatter.model;
  const inherits = catalog.inheritPicker.includes(agentBasename);

  if (declared === undefined || declared.length === 0) {
    if (!inherits) {
      violations.push({
        message:
          `Agent '${agentBasename}' declares no 'model:'. It will silently run on whatever the ` +
          `VS Code model picker is set to. Either pin a model from config/model-catalog.json, or — ` +
          `if inheriting Auto is intended — add '${agentBasename}' to that file's inheritPicker list.`,
      });
    }
    return violations;
  }

  if (inherits) {
    violations.push({
      message:
        `Agent '${agentBasename}' is listed in config/model-catalog.json inheritPicker (meaning: no ` +
        `'model:' key, inherit Auto from the picker) but also pins model '${declared.join(', ')}'. ` +
        `Pick one.`,
    });
  }

  for (const name of declared) {
    if (getOwn(catalog.models, name) !== undefined) continue;
    // `Auto` is the value most likely to be reached for, and the one that looks
    // most like it works. It is not a documented frontmatter value — VS Code
    // resolves `model:` against qualified model names only — so it silently
    // does nothing. Say so, rather than emitting a bare "unknown model".
    const hint = name.toLowerCase().startsWith('auto')
      ? ` 'Auto' is not a valid 'model:' value — it is a model-picker entry. To inherit Auto, omit ` +
        `the 'model:' key entirely and add '${agentBasename}' to inheritPicker.`
      : ` Add it to config/model-catalog.json (with a source) if it is a real model.`;
    violations.push({
      message: `Agent '${agentBasename}' pins model '${name}', which is not in config/model-catalog.json.${hint}`,
    });
  }

  return violations;
}
