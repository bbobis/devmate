// @ts-check
// Transactional promotion of task facts into the shared repo ledger (E3-4).
//
// Strategy: stage the full intended repo ledger (surviving existing facts +
// promoted task facts) into a temp file, atomically rename it over the repo
// ledger, verify the promoted entries are readable, and only then delete the
// task ledger. Any failure before verification leaves the task ledger intact.
import {
  readTextFile,
  removeFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './jsonl-lock.mjs';
import { resolveConflict } from './conflict-policy.mjs';
import { collectActiveFacts } from './active-facts.mjs';

/** @typedef {import('../types.mjs').FactEntry} FactEntry */
/** @typedef {import('../types.mjs').ConflictPolicy} ConflictPolicy */
/** @typedef {import('../types.mjs').PromotionRecord} PromotionRecord */
/** @typedef {import('../types.mjs').PromoteResult} PromoteResult */
/** @typedef {import('./jsonl-lock.mjs').LockOpts} LockOpts */

/**
 * Read a JSONL ledger into parsed entries. Returns [] if the file is missing.
 * @param {string} path
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readJsonl(path) {
  /** @type {string} */
  let raw;
  try {
    raw = await readTextFile(path);
  } catch (/** @type {unknown} */ err) {
    const code =
      err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  if (raw.trim().length === 0) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * The canonical source path of a fact entry. `fact-writer.mjs` stores `source`
 * as a string; tolerate an object `{ path }` form too.
 * @param {FactEntry} fact
 * @returns {string}
 */
function factSource(fact) {
  const src = /** @type {unknown} */ (fact.source);
  if (typeof src === 'string') return src;
  if (src && typeof src === 'object') {
    const p = /** @type {Record<string, unknown>} */ (src)['path'];
    if (typeof p === 'string') return p;
  }
  return '';
}

/**
 * Stable conflict identity for a fact. New ledgers use `fact.key`; legacy
 * entries fall back to source-path identity.
 * @param {FactEntry} fact
 * @returns {string}
 */
function factKey(fact) {
  const rec = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (fact));
  const id = rec['key'];
  if (typeof id === 'string' && id.length > 0) return id;
  return factSource(fact);
}

/**
 * Promote all active (non-staled) facts from `taskLedgerPath` into
 * `repoLedgerPath` transactionally. See module header for the strategy.
 * @param {string} taskLedgerPath
 * @param {string} repoLedgerPath
 * @param {{
 *   taskId: string,
 *   conflictPolicy?: ConflictPolicy,
 *   lockOpts?: LockOpts,
 *   rename?: (oldPath: string, newPath: string) => Promise<void>,
 *   readBack?: (path: string) => Promise<Record<string, unknown>[]>,
 * }} opts
 * @returns {Promise<PromoteResult>}
 */
export async function promoteLedger(taskLedgerPath, repoLedgerPath, opts) {
  const policy = opts.conflictPolicy ?? 'keep-incoming';
  const rename = opts.rename ?? renamePath;
  const readBack = opts.readBack ?? readJsonl;
  const tempPath = repoLedgerPath + '.promoting';

  // 1. Read + filter task ledger.
  const taskEntries = await readJsonl(taskLedgerPath);
  const { active: taskFacts, staleCount } = collectActiveFacts(taskEntries);

  // 2. Acquire exclusive lock on the repo ledger.
  /** @type {import('../types.mjs').LockHandle} */
  let handle;
  try {
    handle = await acquireLock(repoLedgerPath, opts.lockOpts);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof LockTimeoutError) {
      return {
        ok: false,
        promoted: 0,
        skipped: staleCount,
        conflicts: 0,
        records: [],
        error: 'lock_timeout',
      };
    }
    throw err;
  }

  try {
    // 3. Build a map of existing repo facts by conflict identity key.
    const repoEntries = await readJsonl(repoLedgerPath);
    /** @type {Map<string, FactEntry>} */
    const repoByKey = new Map();
    for (const e of repoEntries) {
      if (e['event'] === 'fact') {
        const fact = /** @type {FactEntry} */ (/** @type {unknown} */ (e));
        repoByKey.set(factKey(fact), fact);
      }
    }

    const promotedTs = Date.now();
    /** @type {PromotionRecord[]} */
    const records = [];
    let conflicts = 0;

    // Sources to drop from the carried-forward existing repo set (conflict losers).
    /** @type {Set<string>} */
    const dropExisting = new Set();
    // The task facts that will actually be written (winners / keep-both / new).
    /** @type {FactEntry[]} */
    const toWrite = [];

    for (const incoming of taskFacts) {
      const src = factSource(incoming);
      const key = factKey(incoming);
      const existing = repoByKey.get(key);
      /** @type {PromotionRecord} */
      const rec = {
        source: src,
        originalWriter: typeof (/** @type {Record<string, unknown>} */ (incoming)['writer']) === 'string'
          ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (incoming)['writer'])
          : incoming.tool,
        originalTs: incoming.ts,
        promotedTs,
        taskId: opts.taskId,
        status: 'promoted',
      };

      if (existing) {
        conflicts++;
        rec.status = 'conflict_resolved';
        const { winner } = resolveConflict(existing, incoming, policy);
        if (policy === 'keep-existing') {
          // existing stays; incoming is not written.
          records.push(rec);
          continue;
        }
        if (policy === 'keep-incoming') {
          // incoming replaces existing.
          dropExisting.add(key);
          toWrite.push(incoming);
          records.push(rec);
          continue;
        }
        // keep-both: existing stays AND incoming is written.
        void winner;
        toWrite.push(incoming);
        records.push(rec);
        continue;
      }

      // No conflict — straightforward promotion.
      toWrite.push(incoming);
      records.push(rec);
    }

    // 4. Stage the full intended repo ledger into the temp file:
    //    surviving existing facts (minus conflict losers) + non-fact repo
    //    lines preserved, then the promoted task facts (writer/ts verbatim,
    //    with promotedTs + taskId added).
    /** @type {string[]} */
    const lines = [];
    for (const e of repoEntries) {
      if (e['event'] === 'fact') {
        const key = factKey(/** @type {FactEntry} */ (/** @type {unknown} */ (e)));
        if (dropExisting.has(key)) continue; // replaced by incoming
      }
      lines.push(JSON.stringify(e));
    }
    for (const fact of toWrite) {
      // Preserve writer + ts verbatim; add promotion metadata as new fields.
      const promotedFact = { ...fact, promotedTs, taskId: opts.taskId };
      lines.push(JSON.stringify(promotedFact));
    }
    const body = lines.length > 0 ? lines.join('\n') + '\n' : '';
    await writeTextFile(tempPath, body);

    // 5. Atomic rename over the repo ledger (POSIX-atomic; Windows fallback).
    try {
      await rename(tempPath, repoLedgerPath);
    } catch (/** @type {unknown} */ err) {
      const code =
        err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        // Windows: target exists. Unlink then rename.
        await removeFile(repoLedgerPath);
        await rename(tempPath, repoLedgerPath);
      } else {
        // Clean up the temp file and bail — task ledger left intact.
        await removeFile(tempPath).catch(() => {});
        return {
          ok: false,
          promoted: 0,
          skipped: staleCount,
          conflicts,
          records,
          error: 'rename_failed',
        };
      }
    }

    // 6. Verify: count repo lines carrying our taskId equals what we wrote.
    const verifyEntries = await readBack(repoLedgerPath);
    const writtenWithTask = verifyEntries.filter(
      (e) => e['taskId'] === opts.taskId,
    ).length;
    if (writtenWithTask !== toWrite.length) {
      return {
        ok: false,
        promoted: 0,
        skipped: staleCount,
        conflicts,
        records,
        error: 'verification_failed',
      };
    }

    // 7. Delete task ledger only after verified success. Non-fatal if missing.
    await removeFile(taskLedgerPath).catch((/** @type {unknown} */ err) => {
      const code =
        err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') {
        process.stderr.write(
          `promoteLedger: task ledger unlink failed (non-fatal): ${String(err)}\n`,
        );
      }
    });

    return {
      ok: true,
      promoted: toWrite.length,
      skipped: staleCount,
      conflicts,
      records,
      error: null,
    };
  } finally {
    await releaseLock(handle);
  }
}
