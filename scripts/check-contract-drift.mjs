// @ts-check
// CI guard for the shared devmate ⇄ monoroot contracts — the vendored config
// schema + fixtures corpus (pinned by contractVersion) and the session
// handshake schema + corpus (pinned by handshakeVersion). Two layers:
//
//   1. In-repo hash (ALWAYS runs, including in blind CI): the EOL-normalized
//      SHA-256 of each contract's files must match its checked-in expected
//      hash. Any edit to a shared file — even one byte — fails until the hash
//      is deliberately bumped alongside the contract version, which forces the
//      cross-repo coordination conversation.
//   2. Sibling diff (runs only when a monoroot checkout is reachable):
//      EOL-normalized comparison of every shared file against the sibling
//      copy, failing on any divergence. Self-skips with a notice when the
//      sibling is absent (e.g. GitHub CI has no ../monoroot and no token to
//      fetch one — by design, no CI token is required).
//
// Sibling location: ../monoroot next to this repo, overridable via the
// DEVMATE_MONOROOT_PATH environment variable.
import { timingSafeEqual } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { pathExists, statPathSync } from '../lib/fs-safe.mjs';
import { collectContractFiles, compareSharedEntry, hashContractFiles } from '../lib/contract-drift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Expected in-repo hash of the config contract (docs/devmate-config.schema.json
 * + test/fixtures/config-contract). Bump together with the corpus manifest's
 * contractVersion and lib/config/contract-version.mjs, coordinated with
 * monoroot. Current: contractVersion 4.
 * @type {string}
 */
const EXPECTED_CONTRACT_HASH = 'ef2dd7d39f457aa591fa4d03714ef8aba82132ad75292124a2dc3f601278df69';

/**
 * Expected in-repo hash of the session-handshake contract
 * (docs/session-handshake.schema.json + test/fixtures/session-handshake).
 * Bump together with the corpus manifest's handshakeVersion, coordinated with
 * monoroot. Current: handshakeVersion 2.
 * @type {string}
 */
const EXPECTED_HANDSHAKE_HASH = '4eee2daf7a776cc1cc2bfa8d89a8b35ff9739fe26418bd3256c143b5101db125';

/**
 * @typedef {import('../lib/contract-drift.mjs').SharedEntry} SharedEntry
 * @typedef {Object} ContractSpec
 * @property {string} id            Short name used in output.
 * @property {string} expectedHash  Checked-in EOL-normalized SHA-256.
 * @property {SharedEntry[]} shared Local ⇄ sibling path pairs (files or dirs).
 */

/**
 * Constant-time hash comparison (satisfies the secure-coding lint even though
 * these hashes are not secrets — both live in the repo). Falls back to false
 * on length mismatch, which timingSafeEqual would throw on.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function hashesEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** @type {ContractSpec[]} */
const CONTRACTS = [
  {
    id: 'config-contract',
    expectedHash: EXPECTED_CONTRACT_HASH,
    shared: [
      { local: 'docs/devmate-config.schema.json', sibling: 'schema/devmate-config.schema.json' },
      { local: 'test/fixtures/config-contract', sibling: 'test/fixtures/config-contract' },
    ],
  },
  {
    id: 'session-handshake',
    expectedHash: EXPECTED_HANDSHAKE_HASH,
    shared: [
      { local: 'docs/session-handshake.schema.json', sibling: 'schema/session-handshake.schema.json' },
      { local: 'test/fixtures/session-handshake', sibling: 'test/fixtures/session-handshake' },
    ],
  },
];

/**
 * CI entrypoint. Exits 0 when every contract's in-repo hash matches and (when
 * the sibling checkout is present) every shared file agrees byte-for-byte
 * after EOL normalization; 1 otherwise.
 * @param {string[]} _args  CLI args (unused).
 * @param {{
 *   rootOverride?: string,
 *   siblingOverride?: string,
 *   contractsOverride?: ContractSpec[],
 * }} [opts]  Test overrides.
 * @returns {Promise<number>} exit code
 */
export async function main(_args, opts = {}) {
  const root = opts.rootOverride ?? ROOT;
  const siblingPath =
    opts.siblingOverride ?? process.env['DEVMATE_MONOROOT_PATH'] ?? resolve(root, '..', 'monoroot');
  const contracts = opts.contractsOverride ?? CONTRACTS;
  const siblingPresent = pathExists(siblingPath) && statPathSync(siblingPath).isDirectory();

  /** @type {string[]} */
  const problems = [];

  for (const contract of contracts) {
    const files = collectContractFiles(root, contract.shared.map((s) => s.local));
    const actualHash = hashContractFiles(files);
    if (!hashesEqual(actualHash, contract.expectedHash)) {
      problems.push(
        `${contract.id}: in-repo hash mismatch — expected ${contract.expectedHash}, got ${actualHash} ` +
          `over ${files.length} file(s). If this contract change is intentional, bump the pinned ` +
          `version and the expected hash in scripts/check-contract-drift.mjs, coordinated with monoroot.`,
      );
    }

    if (siblingPresent) {
      for (const entry of contract.shared) {
        for (const problem of compareSharedEntry(root, siblingPath, entry)) {
          problems.push(`${contract.id}: ${problem}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `[check-contract-drift] FAIL — ${problems.length} problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n',
    );
    return 1;
  }

  const siblingNote = siblingPresent
    ? `cross-repo diff against ${siblingPath} agrees`
    : `sibling monoroot checkout not found at ${siblingPath} — cross-repo diff skipped (in-repo hashes still enforced)`;
  process.stdout.write(
    `[check-contract-drift] PASS — ${contracts.length} contract hash(es) match; ${siblingNote}.\n`,
  );
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
