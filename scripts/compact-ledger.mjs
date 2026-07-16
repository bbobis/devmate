// @ts-check
// Agent-invoked entrypoint: compact a fact ledger in place, bounding its size
// by expiring stale/low-confidence/old facts and summarising aged active facts
// into pointer summaries (E3-5). Outputs a compact `CompactResult` JSON to
// stdout — never prints ledger contents.
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { compactLedger } from '../lib/memory/compact.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';

/**
 * Parse `--key value` / `--key=value` args into a flat map.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = args.at(i + 1);
      if (next !== undefined && !next.startsWith('--')) {
        out.set(a.slice(2), next);
        i++;
      } else {
        out.set(a.slice(2), 'true');
      }
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const args = parseArgs(argv);
  const ledgerPath = args.get('ledger') ?? args.get('path');
  if (!ledgerPath) {
    process.stderr.write('usage: compact-ledger.mjs --ledger [path] [--maxEntries N] [--maxBytes N] [--targetEntries N] [--minConfidence F] [--expiryAgeDays N] [--archiveDir [dir]]\n');
    return 2;
  }

  /** @type {import('../lib/types.mjs').CompactOpts} */
  const opts = {};
  const maxEntries = args.get('maxEntries');
  if (maxEntries) opts.maxEntries = Number(maxEntries);
  const maxBytes = args.get('maxBytes');
  if (maxBytes) opts.maxBytes = Number(maxBytes);
  const targetEntries = args.get('targetEntries');
  if (targetEntries) opts.targetEntries = Number(targetEntries);
  const minConfidence = args.get('minConfidence');
  if (minConfidence) opts.minConfidence = Number(minConfidence);
  const expiryAgeDays = args.get('expiryAgeDays');
  if (expiryAgeDays) opts.expiryAgeDays = Number(expiryAgeDays);
  const archiveDir = args.get('archiveDir');
  if (archiveDir) opts.archiveDir = archiveDir;

  const result = await compactLedger(ledgerPath, opts);

  // Emit a `compaction` trace event so the memory pipeline is observable
  // (TCM-11) when invoked with a task context. Best-effort — a trace failure
  // never changes the compaction outcome.
  const taskId = args.get('task-id') ?? args.get('taskId');
  if (taskId && result.ok) {
    try {
      await appendTraceEvent(
        {
          type: 'compaction',
          taskId,
          stepId: 'compaction',
          ts: new Date().toISOString(),
          schemaVersion: 1,
          artifactPath: result.archivePath ?? '',
          entriesBefore: result.entriesBefore,
          entriesAfter: result.entriesAfter,
        },
        { root: args.get('root') ?? '.' },
      );
    } catch (/** @type {unknown} */ err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`compact-ledger: compaction trace skipped (non-fatal): ${msg}\n`);
    }
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
