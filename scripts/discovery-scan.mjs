// @ts-check
/**
 * FO-3: discovery-scan — thin CLI wrapper around lib/discovery/scan.mjs.
 *
 * Runs the deterministic, zero-LLM-cost candidate scan (Phase 1 of the
 * fan-out/fan-in discovery design) and writes a ranked, pointer-only
 * candidate artifact. Never a source of truth itself — the orchestrator
 * branches on the artifact's `insufficient`/`dropped` fields, not on this
 * process's exit code (exit 0 covers `insufficient: true` too).
 *
 * Usage:
 *   node scripts/discovery-scan.mjs --terms "gate,guard" \
 *     [--seed-files "lib/a.mjs,lib/b.mjs"] [--budget-class standard] \
 *     [--max-sources 10] [--min-success-rate 0.5] \
 *     [--out .devmate/state/discovery-candidates.json] \
 *     [--repo-root .]
 *
 * Exit: 0 on a completed scan (including insufficient:true); 1 on
 *       config/IO errors (missing --terms, --out escaping --repo-root,
 *       unwritable --out, etc.).
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { writeJsonFileAtomic } from '../lib/json-io.mjs';
import { runDiscoveryScan } from '../lib/discovery/scan.mjs';

/** @typedef {import('../lib/types.mjs').BudgetClass} BudgetClass */

/** Default artifact path, relative to `--repo-root`. */
const DEFAULT_OUT = '.devmate/state/discovery-candidates.json';

/** @type {readonly BudgetClass[]} */
const BUDGET_CLASSES = Object.freeze(['tiny', 'standard', 'large']);

/**
 * Split a comma-separated CLI value into trimmed, non-empty entries.
 * @param {string} raw
 * @returns {string[]}
 */
function splitCsv(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Parse `--flag value` / `--flag=value` pairs into an option map. Uses a
 * `Map` (not a plain object) so a hostile flag name like `--__proto__`
 * cannot pollute Object.prototype.
 * Unknown flags are ignored (forward-compatible).
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    // eslint-disable-next-line secure-coding/detect-object-injection -- numeric array index (args[i+1]), not an object property; no prototype-pollution surface.
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, '');
    }
  }
  return out;
}

/**
 * Build a ≤10-line human digest of a scan result for stdout.
 * @param {Awaited<ReturnType<typeof runDiscoveryScan>>} result
 * @param {string} artifactPath
 * @returns {string}
 */
function buildDigest(result, artifactPath) {
  const lines = [
    `[discovery-scan] ${result.candidates.length} candidate(s), ${result.dropped} dropped, insufficient=${result.insufficient}`,
  ];
  if (result.violations.length > 0) {
    lines.push(`violations: ${result.violations.join(', ')}`);
  }
  const top = result.candidates.slice(0, 5);
  for (const c of top) {
    lines.push(`  ${c.score.toFixed(0)}  ${c.path}  [${c.strategies.join(',')}]`);
  }
  lines.push(`artifact: ${artifactPath}`);
  return lines.join('\n');
}

/**
 * Main entrypoint.
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  const opts = parseArgs(args);
  const terms = opts.get('terms');

  if (typeof terms !== 'string' || terms.trim() === '') {
    process.stderr.write('[discovery-scan] FAIL — --terms is required (comma-separated seed terms)\n');
    return 1;
  }

  const repoRoot = resolve(opts.get('repo-root') ?? process.cwd());
  const seedTerms = splitCsv(terms);
  const seedFilesRaw = opts.get('seed-files');
  const seedFiles = typeof seedFilesRaw === 'string' ? splitCsv(seedFilesRaw) : [];
  const budgetClassRaw = opts.get('budget-class') ?? 'standard';
  const budgetClass = /** @type {readonly string[]} */ (BUDGET_CLASSES).includes(budgetClassRaw)
    ? /** @type {BudgetClass} */ (budgetClassRaw)
    : 'standard';
  const maxSourcesRaw = opts.get('max-sources');
  if (maxSourcesRaw !== undefined) {
    const maxSourcesNum = Number(maxSourcesRaw);
    if (maxSourcesRaw.trim() === '' || !Number.isInteger(maxSourcesNum) || maxSourcesNum < 0) {
      process.stderr.write(
        `[discovery-scan] FAIL — --max-sources must be a non-negative integer, got ${JSON.stringify(maxSourcesRaw)}\n`
      );
      return 1;
    }
  }
  const maxSources = maxSourcesRaw !== undefined ? Number(maxSourcesRaw) : undefined;
  const minSuccessRateRaw = opts.get('min-success-rate');
  if (minSuccessRateRaw !== undefined) {
    const minSuccessRateNum = Number(minSuccessRateRaw);
    if (
      minSuccessRateRaw.trim() === '' ||
      !Number.isFinite(minSuccessRateNum) ||
      minSuccessRateNum < 0 ||
      minSuccessRateNum > 1
    ) {
      process.stderr.write(
        `[discovery-scan] FAIL — --min-success-rate must be a number between 0 and 1, got ${JSON.stringify(minSuccessRateRaw)}\n`
      );
      return 1;
    }
  }
  const minSuccessRate = minSuccessRateRaw !== undefined ? Number(minSuccessRateRaw) : undefined;
  const outRel = opts.get('out') ?? DEFAULT_OUT;
  const outPath = resolve(repoRoot, outRel);
  const normalizedRoot = repoRoot.replace(/\\/g, '/');
  const normalizedOut = outPath.replace(/\\/g, '/');
  if (normalizedOut !== normalizedRoot && !normalizedOut.startsWith(normalizedRoot + '/')) {
    process.stderr.write(
      `[discovery-scan] FAIL — --out must resolve inside --repo-root, got ${JSON.stringify(outRel)}\n`
    );
    return 1;
  }

  /** @type {Awaited<ReturnType<typeof runDiscoveryScan>>} */
  let result;
  try {
    result = await runDiscoveryScan({
      repoRoot,
      seedTerms,
      seedFiles,
      budgetClass,
      ...(maxSources !== undefined ? { maxSources } : {}),
      ...(minSuccessRate !== undefined ? { minSuccessRate } : {}),
    });
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[discovery-scan] FAIL — scan error: ${msg}\n`);
    return 1;
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seedTerms,
    candidates: result.candidates,
    dropped: result.dropped,
    insufficient: result.insufficient,
    violations: result.violations,
  };

  try {
    await writeJsonFileAtomic(outPath, artifact);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[discovery-scan] FAIL — could not write artifact: ${msg}\n`);
    return 1;
  }

  process.stdout.write(buildDigest(result, outPath) + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
