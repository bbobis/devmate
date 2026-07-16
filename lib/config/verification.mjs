// @ts-check
// E14 re-spec: verification is a variable-length list of checks fit to the
// codebase, not a fixed unitTest/typeCheck/e2e triplet. This module is the
// single place that (a) normalizes a raw verification block — including the
// DEPRECATED legacy named keys — into a canonical `checks[]` list, and (b)
// resolves the one load-bearing command (the unit-test command that drives the
// TDD gate). Pure and I/O-free: same input ⇒ same output, no clock, no rng.

/** @typedef {import('../types.mjs').VerificationConfig} VerificationConfig */
/** @typedef {import('../types.mjs').VerificationCheck} VerificationCheck */
/** @typedef {import('../types.mjs').DevmateConfig} DevmateConfig */

/**
 * Conventional (NOT enforced) category vocabulary. Documented so authors and
 * the enrichment stage converge on shared labels; the validator accepts ANY
 * non-empty string so the set is never a hardcoded ceiling.
 * @type {readonly string[]}
 */
export const CANONICAL_CATEGORIES = Object.freeze([
  'unit-test',
  'type-check',
  'e2e',
  'lint',
  'format',
  'build',
  'audit',
  'contract',
  'integration',
]);

/**
 * The category whose command drives the TDD gate (buildTddPreamble) and the
 * "TDD gate disabled" warning. First check with this category wins.
 * @type {string}
 */
export const UNIT_TEST_CATEGORY = 'unit-test';

/**
 * True when `v` is a non-empty (after trim) string.
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Normalize a raw `verification` value into the canonical `{ checks }` shape.
 *
 * - A `checks` array present ⇒ it is canonical and wins — even when EMPTY, so an
 *   explicit `checks: []` honors "no checks" rather than resurrecting stale
 *   legacy keys (and correctly leaves the TDD gate disabled).
 * - Otherwise, synthesize checks from any legacy unitTest/typeCheck/e2e keys,
 *   in fixed order, each stamped with a `source` pointing at the legacy key.
 * - Nothing usable ⇒ `{ checks: [] }`.
 *
 * The caller is expected to have run this through `validateDevmateConfig`
 * already; this function is defensive but does not re-validate shapes.
 *
 * @param {VerificationConfig|Record<string, unknown>|undefined|null} rawVerification
 * @returns {{ checks: VerificationCheck[] }}
 */
export function normalizeVerification(rawVerification) {
  if (rawVerification === null || typeof rawVerification !== 'object') {
    return { checks: [] };
  }
  const v = /** @type {Record<string, unknown>} */ (rawVerification);

  if (Array.isArray(v['checks'])) {
    const checks = /** @type {VerificationCheck[]} */ (v['checks']).map((c) => ({ ...c }));
    return { checks };
  }

  // Synthesize checks from the deprecated legacy named keys, in fixed order.
  // Literal-key access (no dynamic index) keeps the object-injection lint quiet.
  /** @type {VerificationCheck[]} */
  const synthesized = [];
  /** @type {ReadonlyArray<{ command: unknown, id: string, category: string, source: string }>} */
  const legacy = [
    { command: v['unitTest'], id: 'unit-test', category: 'unit-test', source: 'verification.unitTest' },
    { command: v['typeCheck'], id: 'type-check', category: 'type-check', source: 'verification.typeCheck' },
    { command: v['e2e'], id: 'e2e', category: 'e2e', source: 'verification.e2e' },
  ];
  for (const entry of legacy) {
    if (isNonEmptyString(entry.command)) {
      synthesized.push({ id: entry.id, command: entry.command.trim(), category: entry.category, source: entry.source });
    }
  }
  return { checks: synthesized };
}

/**
 * Resolve the unit-test command that drives the TDD gate: the first check whose
 * category is `unit-test` (after normalization, so legacy `unitTest` still
 * works). Returns null when no unit-test command is configured.
 *
 * @param {{ verification?: VerificationConfig }|DevmateConfig} config
 * @returns {string|null}
 */
export function resolveUnitTestCommand(config) {
  const { checks } = normalizeVerification(config?.verification);
  for (const check of checks) {
    if (check.category === UNIT_TEST_CATEGORY && isNonEmptyString(check.command)) {
      return check.command.trim();
    }
  }
  return null;
}
