// @ts-check
// Pure check helpers for the DN-1 business-domain map (scripts/devmate-doctor.mjs
// is the thin I/O wrapper that calls these and prints the results). Every
// check here is a warning, never a hard failure — the loader already rejects
// structurally malformed `domains` entries (lib/config/devmate-config.mjs);
// these checks catch semantic drift a valid config can still have (a renamed
// or deleted contextFile, a relatedDomains id that no longer exists, an
// entryPoints path that moved) without blocking the doctor's exit code.
import { resolve } from 'node:path';
import { pathExists } from '../fs-safe.mjs';

/** @typedef {import('../types.mjs').DomainConfig} DomainConfig */

/**
 * Check a repo's declared business domains for cheap-to-detect drift.
 * Read-only — never mutates the config or the filesystem.
 *
 * @param {string} repoRoot  Absolute repo root domain-relative paths anchor against.
 * @param {DomainConfig[]} domains  Normalized domains array (e.g. from a loaded devmate.config.json).
 * @returns {string[]}  Human-readable warning lines. Empty when everything checks out.
 */
export function checkDomainConfig(repoRoot, domains) {
  /** @type {string[]} */
  const warnings = [];
  if (!Array.isArray(domains) || domains.length === 0) return warnings;

  const declaredIds = new Set(domains.map((d) => d.domain));
  /** @type {Set<string>} */
  const seenIds = new Set();

  for (const d of domains) {
    if (seenIds.has(d.domain)) {
      warnings.push(`domain '${d.domain}' is declared more than once — ids must be unique`);
    }
    seenIds.add(d.domain);

    if (!Array.isArray(d.globs) || d.globs.length === 0) {
      warnings.push(`domain '${d.domain}' has an empty globs array — it owns no files`);
    }

    if (typeof d.contextFile === 'string' && d.contextFile.trim() !== '') {
      if (!pathExists(resolve(repoRoot, d.contextFile))) {
        warnings.push(`domain '${d.domain}' contextFile not found: ${d.contextFile}`);
      }
    }

    for (const relatedId of d.relatedDomains ?? []) {
      if (!declaredIds.has(relatedId)) {
        warnings.push(`domain '${d.domain}' relatedDomains references unknown domain '${relatedId}'`);
      }
    }

    for (const entryPoint of d.entryPoints ?? []) {
      if (!pathExists(resolve(repoRoot, entryPoint))) {
        warnings.push(`domain '${d.domain}' entryPoints path not found: ${entryPoint}`);
      }
    }
  }

  return warnings;
}
