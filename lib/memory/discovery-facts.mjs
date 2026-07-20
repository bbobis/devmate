// @ts-check
// FO-6: persist merged discovery facts into the task fact ledger.
//
// Nothing cached read/search results before this module: `fact-writer.mjs`
// writes facts only for edit-class tools, so discovery re-derived the same
// repository facts from scratch every session. `writeDiscoveryFacts` is the
// explicit write path (never a PostToolUse hook): it converts each merged
// discovery claim (FO-4/FO-5) into a ledger `FactEntry` matching the existing
// schema exactly, anchored to the referenced file's content digest so recall
// can detect staleness later.
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { readTextFile } from '../fs-safe.mjs';
import { readJsonFile } from '../json-io.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { appendJsonlWithHandle } from './append-jsonl.mjs';
import { collectActiveFacts } from './active-facts.mjs';
import { deriveTags } from './fact-writer.mjs';
import { normalizeForDigest } from './digest-normalize.mjs';
import { taskLedgerPath, validateTaskId } from './paths.mjs';

/** @typedef {import('../types.mjs').FactEntry} FactEntry */
/** @typedef {import('../types.mjs').StaleEntry} StaleEntry */
/** @typedef {import('../types.mjs').MergedDiscoveryClaim} MergedDiscoveryClaim */
/** @typedef {import('../types.mjs').WriteDiscoveryFactsOpts} WriteDiscoveryFactsOpts */
/** @typedef {import('../types.mjs').DiscoveryFactsWriteResult} DiscoveryFactsWriteResult */

/**
 * The `tool` marker distinguishing discovery facts from edit facts in the
 * ledger. Queries branch on this value; it is a contract, not a label.
 * @type {string}
 */
export const DISCOVERY_FACT_TOOL = 'discovery-merge';

/** stepId recorded on every discovery fact (mirrors the merge trace event). */
const DISCOVERY_STEP_ID = 'merge-discovery';

/** Summary cap, matching `fact-writer.mjs`'s MAX_SUMMARY_LEN. */
const MAX_SUMMARY_LEN = 120;

/** Digest length in hex chars — the trace layer's bounded-digest convention. */
const DIGEST_LEN = 16;

/** Claim-identity digest prefix length (mirrors fact-writer's key format). */
const KEY_DIGEST_LEN = 8;

/**
 * Confidence mapping from merged-claim confidence to FactEntry confidence.
 * A `Map` so a hostile confidence value cannot reach Object.prototype.
 * @type {ReadonlyMap<string, number>}
 */
const CONFIDENCE_MAP = new Map([
  ['high', 0.9],
  ['low', 0.6],
]);

/**
 * 16-hex SHA-256 content digest — the freshness anchor written on every
 * discovery fact and recomputed by the recall-side stale check. Same bounded
 * digest convention as the trace layer (`lib/trace/audit-action.mjs`) and the
 * `SourceIdentity` digest.
 * @param {string} text
 * @returns {string} 16 lowercase hex characters.
 */
export function contentDigest16(text) {
  return createHash('sha256').update(normalizeForDigest(text), 'utf8').digest('hex').slice(0, DIGEST_LEN);
}

// #148: normalizeForDigest lives in its own module to avoid an import cycle
// (this module imports deriveTags from fact-writer, which needs the normalizer
// too). Re-exported here so the documented contract and existing importers hold.
export { normalizeForDigest };

/**
 * Validate a claim's `path` is workspace-relative and cannot escape the repo
 * root. Returns the slash-normalised path, or null when rejected.
 * @param {string} rawPath
 * @returns {string|null}
 */
function canonicaliseClaimPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  const normalised = rawPath.split('\\').join('/');
  if (isAbsolute(normalised) || normalised.startsWith('/')) return null;
  if (normalised.split('/').includes('..')) return null;
  return normalised;
}

/**
 * Read a JSONL ledger leniently: [] when the file is missing, malformed lines
 * skipped (a corrupt line must not block a memory write).
 * @param {string} ledgerPath
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readLedgerEntries(ledgerPath) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(ledgerPath);
  } catch (/** @type {unknown} */ err) {
    const code = err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * True when `entry` is an active discovery fact belonging to `taskId`.
 * Task-ledger facts carry no `taskId` field (promotion adds it), so an absent
 * taskId matches; a present one must equal ours — this is the
 * "match on taskId + kind" idempotency filter.
 * @param {FactEntry} entry
 * @param {string} taskId
 * @returns {boolean}
 */
function isOwnDiscoveryFact(entry, taskId) {
  if (entry.tool !== DISCOVERY_FACT_TOOL) return false;
  const entryTaskId = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (entry)
  )['taskId'];
  return entryTaskId === undefined || entryTaskId === taskId;
}

/**
 * Build a `DiscoveryFactsWriteResult` error result.
 * @param {string} error
 * @param {string} ledgerPath
 * @returns {DiscoveryFactsWriteResult}
 */
function errorResult(error, ledgerPath) {
  return {
    ok: false,
    facts: [],
    staledPrior: 0,
    skippedNeedsReview: 0,
    skippedMissingSource: 0,
    skippedInvalid: 0,
    ledgerPath,
    error,
  };
}

/**
 * Persist the claims of a merged discovery artifact (FO-4/FO-5) as fact
 * entries in the task fact ledger, so later sessions can recall — and
 * seed their scans from — what discovery already established.
 *
 * Behaviour:
 *  - Each kept claim becomes a `FactEntry` matching the existing ledger schema
 *    exactly, with `tool: 'discovery-merge'` as the kind marker,
 *    confidence mapped `high` → 0.9 / `low` → 0.6, the shared tagger from
 *    `fact-writer.mjs`, and `contentDigest` = the referenced file's current
 *    16-hex content digest (the freshness anchor the stale check recomputes).
 *  - A claim's key is `${path}:${sha256(fact-text) first 8 hex}` — identity is
 *    (file, claim text), so the same claim re-discovered by a later task maps
 *    to the same key and promotion's `keep-incoming` policy replaces rather
 *    than duplicates. Freshness lives in `contentDigest`, not the key.
 *  - Claims flagged `needsReview: true` are skipped (unadjudicated conflicts
 *    must not enter memory), as are claims whose file does not exist and
 *    claims failing shape/path validation — each skip is counted.
 *  - Idempotent per task: prior active discovery facts for this task are
 *    marked stale before the new batch is appended (same lock, one critical
 *    section), so re-running a merge replaces rather than duplicates. Edit
 *    facts are never touched.
 *  - Result-object returns; never throws across the module boundary.
 *
 * @param {WriteDiscoveryFactsOpts} opts
 * @returns {Promise<DiscoveryFactsWriteResult>}
 */
export async function writeDiscoveryFacts(opts) {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const lane = typeof opts.lane === 'string' && opts.lane !== '' ? opts.lane : 'unknown';

  /** @type {string} */
  let ledgerPath;
  try {
    ledgerPath = opts.ledgerPath ?? taskLedgerPath(repoRoot, opts.taskId);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`invalid taskId: ${msg}`, opts.ledgerPath ?? '');
  }
  if (opts.ledgerPath) {
    try {
      validateTaskId(opts.taskId);
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`invalid taskId: ${msg}`, ledgerPath);
    }
  }

  // Resolve the merged artifact: in-memory object preferred, else read from disk.
  /** @type {unknown} */
  let artifact = opts.mergedArtifact;
  if (artifact === undefined && typeof opts.mergedArtifactPath === 'string') {
    artifact = await readJsonFile(resolve(repoRoot, opts.mergedArtifactPath));
  }
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return errorResult('invalid merged artifact: expected an object with a claims array', ledgerPath);
  }
  const claims = /** @type {Record<string, unknown>} */ (artifact)['claims'];
  if (!Array.isArray(claims)) {
    return errorResult('invalid merged artifact: expected an object with a claims array', ledgerPath);
  }

  const now = opts.now ?? Date.now;
  const baseTs = now();

  let skippedNeedsReview = 0;
  let skippedMissingSource = 0;
  let skippedInvalid = 0;
  /** @type {FactEntry[]} */
  const newFacts = [];

  for (const raw of claims) {
    if (raw === null || typeof raw !== 'object') {
      skippedInvalid += 1;
      continue;
    }
    const claim = /** @type {MergedDiscoveryClaim} */ (raw);
    if (claim.needsReview === true) {
      skippedNeedsReview += 1;
      continue;
    }
    const confidence = CONFIDENCE_MAP.get(String(claim.confidence));
    if (typeof claim.fact !== 'string' || claim.fact.trim() === '' || confidence === undefined) {
      skippedInvalid += 1;
      continue;
    }
    const source = canonicaliseClaimPath(claim.path);
    if (source === null) {
      skippedInvalid += 1;
      continue;
    }

    // Freshness anchor: digest the referenced file's CURRENT content. A claim
    // whose file is already gone would be born stale — skip it (fail-closed).
    /** @type {string} */
    let fileContent;
    try {
      fileContent = await readTextFile(resolve(repoRoot, source));
    } catch {
      skippedMissingSource += 1;
      continue;
    }
    const digest = contentDigest16(fileContent);
    // #148: normalize identically so the claim key is checkout-invariant too.
    const claimDigest = createHash('sha256')
      .update(normalizeForDigest(claim.fact), 'utf8')
      .digest('hex')
      .slice(0, KEY_DIGEST_LEN);

    const summary = claim.fact.length > MAX_SUMMARY_LEN
      ? claim.fact.slice(0, MAX_SUMMARY_LEN)
      : claim.fact;

    // Distinct ts per fact (baseTs + index) so the ts-keyed stale mechanism
    // can never conflate two facts written in the same batch.
    newFacts.push({
      event: 'fact',
      key: `${source}:${claimDigest}`,
      source,
      tool: DISCOVERY_FACT_TOOL,
      lane,
      tags: deriveTags(source),
      summary,
      confidence,
      ts: baseTs + newFacts.length,
      stepId: DISCOVERY_STEP_ID,
      firstEdit: false,
      contentDigest: digest,
    });
  }

  // Stale prior batch + append new batch inside one critical section so no
  // concurrent writer can interleave between the replacement halves.
  /** @type {import('../types.mjs').LockHandle | null} */
  let handle = null;
  try {
    handle = await acquireLock(ledgerPath);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return errorResult('lock_timeout', ledgerPath);
    }
    // Any other lock failure (EACCES, ENOTDIR, …) also becomes a result —
    // this module's contract is "never throw across the module boundary".
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`lock_failed: ${msg}`, ledgerPath);
  }

  try {
    const entries = await readLedgerEntries(ledgerPath);
    const { active } = collectActiveFacts(entries);
    const priorDiscovery = active.filter((f) => isOwnDiscoveryFact(f, opts.taskId));

    for (const prior of priorDiscovery) {
      /** @type {StaleEntry} */
      const stale = {
        event: 'stale',
        source: { path: prior.source },
        reason: 'changed',
        stalledFactTs: prior.ts,
        ts: now(),
      };
      await appendJsonlWithHandle(ledgerPath, stale);
    }
    for (const fact of newFacts) {
      await appendJsonlWithHandle(ledgerPath, fact);
    }

    return {
      ok: true,
      facts: newFacts,
      staledPrior: priorDiscovery.length,
      skippedNeedsReview,
      skippedMissingSource,
      skippedInvalid,
      ledgerPath,
      error: null,
    };
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`append_failed: ${msg}`, ledgerPath);
  } finally {
    await releaseLock(handle);
  }
}
