// @ts-check
import { resolve } from 'node:path';
import { pathExists, readTextFileSync } from './fs-safe.mjs';
import { validateUiBriefArtifact } from './workflow/agents/ui-ux.mjs';

/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */

// The policy itself now lives in a dependency-free module so `gate-guard-core`
// — the pure evaluator the PreToolUse hook runs — can import it without taking
// on this file's disk I/O (#91). Re-exported here so existing importers, and
// the unit tests that have asserted this policy since v0.0.01, keep pointing at
// the one function the hook actually executes.
export { IMPL_GATES, isEditAllowedAtGate } from './gate-edit-policy.mjs';

/**
 * Pre-condition check for the spec-approved transition.
 * The spec.md file must exist on disk before the gate can advance to spec-approved.
 *
 * @param {string} [specPath]  Absolute or repo-relative path to spec.md. Defaults to 'spec.md'.
 * @param {string} [uiBriefPath]  Optional absolute or repo-relative path to ui-brief.json.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSpecApprovedPrecondition(specPath, uiBriefPath) {
  const p = specPath ?? 'spec.md';
  const abs = resolve(p);
  if (!pathExists(abs)) {
    return {
      ok: false,
      reason:
        `Gate guard: spec-approved transition denied — spec.md not found at "${abs}". ` +
        'Run the spec-writer step first.',
    };
  }

  if (typeof uiBriefPath === 'string' && uiBriefPath.trim() !== '') {
    const uiBriefAbs = resolve(uiBriefPath);
    if (!pathExists(uiBriefAbs)) {
      return {
        ok: false,
        reason:
          `Gate guard: spec-approved transition denied — UI brief not found at "${uiBriefAbs}". ` +
          'Run the @ui-ux step first.',
      };
    }

    try {
      const content = readTextFileSync(uiBriefAbs);
      const parsed = /** @type {unknown} */ (JSON.parse(content));
      const verdict = validateUiBriefArtifact(parsed);
      if (!verdict.ok) {
        return {
          ok: false,
          reason:
            `Gate guard: spec-approved transition denied — UI brief is invalid at "${uiBriefAbs}". ` +
            `Errors: ${verdict.errors.join('; ')}`,
        };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown read/parse failure';
      return {
        ok: false,
        reason:
          `Gate guard: spec-approved transition denied — UI brief is unreadable at "${uiBriefAbs}". ` +
          `Error: ${errorMessage}`,
      };
    }
  }

  return { ok: true };
}
