// @ts-check
import { resolve } from 'node:path';
import { pathExists } from '../fs-safe.mjs';

/**
 * @typedef {Object} FactVerification
 * @property {boolean} resolves  True when the fact's source path still exists.
 * @property {('ok'|'source_missing')} reason
 */

/**
 * Verify a fact's `source` pointer still resolves to live code under `repoRoot`.
 *
 * A cheap existence check (mirrors `glossary.mjs` `validateGlossaryEntry`): a
 * fact whose source file no longer exists is drifted and must not be trusted at
 * recall time — the "verify before use" principle. This deliberately checks
 * existence only, not line/content drift, so it is O(1) per fact and safe to
 * run over every recalled candidate.
 *
 * @param {{ source?: unknown }} fact
 * @param {string} repoRoot  Absolute repo root the source path is relative to.
 * @returns {FactVerification}
 */
export function verifyFactSource(fact, repoRoot) {
  const source = typeof fact.source === 'string' ? fact.source : '';
  if (source === '') return { resolves: false, reason: 'source_missing' };
  const abs = resolve(repoRoot, source);
  return pathExists(abs)
    ? { resolves: true, reason: 'ok' }
    : { resolves: false, reason: 'source_missing' };
}
