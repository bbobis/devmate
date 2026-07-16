// @ts-check

/**
 * The version of the shared devmate ⇄ monoroot config contract this build
 * targets — the vendored schema at docs/devmate-config.schema.json plus the
 * fixtures corpus at test/fixtures/config-contract, whose manifest pins the
 * same number. The producer (monoroot) stamps its contract version into the
 * merged multi-root config as `contractVersion`; scripts/init.mjs compares
 * that stamp against this constant and emits a non-blocking skew nudge on
 * mismatch (fail-open — an absent or non-numeric stamp never nudges).
 *
 * Bump it together with the corpus manifest AND the expected contract hash
 * in scripts/check-contract-drift.mjs, coordinated with monoroot so the
 * shared files stay byte-identical.
 * @type {number}
 */
export const CONTRACT_VERSION = 4;
