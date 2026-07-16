// @ts-check
/**
 * E8-4: CI guard for the model policy config.
 *
 * Blocks premature defaults: exits non-zero if any entry carries a real-looking
 * model ID without a `verifiedAt` date, mixes a placeholder with a `verifiedAt`
 * date, or is verified without a `source` URL. An explicitly-placeholder entry
 * (`[UNVERIFIED …]` + `verifiedAt: null`) is the sanctioned shipping state until
 * a human verifies real IDs (see docs/model-policy.md), so it passes with a
 * notice. This guarantees no unverified model ID can silently become a
 * committed default, while staying wireable into CI (E9-02). The same rules
 * apply to the optional per-worker `roles` block (FO-7); unknown role names
 * are rejected by the shape validation in lib/routing/model-policy.mjs.
 *
 * Usage: node scripts/validate-model-policy.mjs [path-to-policy.json]
 */

import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import {
  loadModelPolicy,
  validateModelPolicy,
  DEFAULT_POLICY_PATH,
} from '../lib/routing/model-policy.mjs';

/** Marker that flags a placeholder, never-verified model ID. */
const PLACEHOLDER_MARKER = '[UNVERIFIED';

/**
 * Validate the model policy config and report. Returns a non-zero exit code if
 * the policy is malformed, OR if any entry is unverified / placeholder. The
 * latter is expected today — the config ships with placeholders on purpose — so
 * a clean exit means a human has verified real IDs.
 * @param {string[]} args  argv slice; args[0] optional policy path.
 * @returns {Promise<number>} process exit code
 */
export async function main(args) {
  const policyPath = args[0] ? args[0] : DEFAULT_POLICY_PATH;

  /** @type {import('../lib/types.mjs').ModelPolicy} */
  let policy;
  try {
    policy = await loadModelPolicy({ policyPath });
  } catch (/** @type {unknown} */ err) {
    process.stderr.write(
      `[validate-model-policy] FAIL — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  // Shape is already validated by loadModelPolicy; re-run for an explicit report.
  const shape = validateModelPolicy(policy);
  if (!shape.ok) {
    for (const e of shape.errors) process.stderr.write(`[validate-model-policy] ${e}\n`);
    return 1;
  }

  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const placeholders = [];
  /**
   * Apply the shared placeholder/verification consistency rules to one entry.
   * Role entries (FO-7) follow exactly the same rules as class entries.
   * @param {string} label  e.g. `tiny` or `roles.discoveryWorker`.
   * @param {import('../lib/types.mjs').ModelEntry | import('../lib/types.mjs').ModelRoleEntry} entry
   * @returns {void}
   */
  function checkEntry(label, entry) {
    const isPlaceholder = entry.modelId.includes(PLACEHOLDER_MARKER);
    if (isPlaceholder && entry.verifiedAt === null) {
      // Sanctioned shipping state: explicitly unverified, no real ID committed.
      placeholders.push(label);
      return;
    }
    if (isPlaceholder && entry.verifiedAt !== null) {
      problems.push(`${label}: placeholder modelId but verifiedAt is set (inconsistent)`);
    }
    if (!isPlaceholder && entry.verifiedAt === null) {
      problems.push(`${label}: modelId "${entry.modelId}" committed without verifiedAt (premature default)`);
    }
    if (entry.verifiedAt !== null && !entry.source) {
      problems.push(`${label}: verifiedAt set but no source URL provided`);
    }
  }
  for (const [cls, entry] of Object.entries(policy.byBudgetClass)) {
    checkEntry(cls, entry);
  }
  for (const [role, entry] of Object.entries(policy.roles ?? {})) {
    if (entry !== undefined) checkEntry(`roles.${role}`, entry);
  }

  if (problems.length > 0) {
    process.stderr.write('[validate-model-policy] FAIL — unverified or inconsistent entries:\n');
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(
      '\nA real modelId requires verifiedAt + source URL (and an eval baseline). See docs/model-policy.md.\n'
    );
    return 1;
  }

  if (placeholders.length > 0) {
    const noun =
      placeholders.length === 1
        ? 'entry is still an explicit placeholder'
        : 'entries are still explicit placeholders';
    process.stdout.write(
      `[validate-model-policy] PASS — ${placeholders.length} ${noun} ` +
      `(${placeholders.join(', ')}); no unverified real ID committed. See docs/model-policy.md to verify IDs.\n`
    );
    return 0;
  }

  process.stdout.write('[validate-model-policy] PASS — all entries verified.\n');
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
