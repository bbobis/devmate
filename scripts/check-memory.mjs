// @ts-check
/**
 * check-memory — the opt-in consumer-side guardrail for committed memory (#212).
 *
 * devmate ships the memory *pipeline* into a consumer repo by seeding hooks +
 * layout, but the promotion *guardrails* that make committed memory safe at
 * scale are CI, and a plugin cannot add CI to someone else's repo
 * (docs/design/mem-consumer-enforcement.md). This is the single command a
 * consumer drops into their own `.github/workflows/` to get those guardrails.
 *
 * THE CRUX (resolved): the design doc's first-choice guardrail — re-render
 * `.devmate/MEMORY.md` from the ledger and fail on a diff — is not possible on a
 * clone, because the ledger (`.devmate/state/repo/repo.jsonl`) is git-ignored and
 * never committed. So v1 degrades, as the doc anticipated, to STRUCTURAL
 * validation of the committed file — the checks that do not need the private
 * ledger:
 *   1. marker integrity — the `<!-- devmate:facts:* -->` block is well-formed
 *      (exactly one of each sentinel, in order), so a hand-edit that truncated it
 *      or a merge-conflict artifact that duplicated it fails;
 *   2. bounds — the file is within the render soft cap (compaction signal);
 *   3. best-effort secret scan — no env-var / bearer / authorization-shaped
 *      credential survived into committed memory (reuses `redactSecrets`; not a
 *      security guarantee — see its contract in lib/loop/output-cap.mjs).
 * Deterministic-regeneration verify remains a future opt-in for a consumer that
 * additionally commits a ledger source of truth; it is out of scope here and
 * documented as such (docs/memory.md).
 *
 * Usage:  node scripts/check-memory.mjs [repoRoot]
 * Exit:   0 clean (or no committed memory to check); 1 on any violation.
 */

import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { readTextFile } from '../lib/fs-safe.mjs';
import { memoryMdPath, MEMORY_PATH } from '../lib/memory/paths.mjs';
import { FACTS_START, FACTS_END, MEMORY_MD_SOFT_LINE_CAP } from '../lib/memory/render-memory.mjs';
import { redactSecrets } from '../lib/loop/output-cap.mjs';

/**
 * Structurally validate committed memory content. Pure — no I/O, no clock — so it
 * is directly assertable. Returns the list of human-readable violations; empty
 * means clean.
 * @param {string} content  The committed `.devmate/MEMORY.md` bytes.
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateCommittedMemory(content) {
  /** @type {string[]} */
  const violations = [];
  const text = typeof content === 'string' ? content : '';

  // 1. Marker integrity. A freshly-seeded file with no promoted facts has no
  // block yet — that is valid (zero of each sentinel). Otherwise the render
  // writes exactly one well-ordered block, so anything else — a truncated block
  // (one sentinel missing) or a DUPLICATED block (START…END…START, the classic
  // merge-conflict artifact) — is a hand-edit that corrupted the rendered region.
  const startCount = text.split(FACTS_START).length - 1;
  const endCount = text.split(FACTS_END).length - 1;
  if (startCount === 0 && endCount === 0) {
    // no facts block yet — valid pre-render / empty-ledger state
  } else if (startCount !== 1 || endCount !== 1) {
    violations.push(
      `malformed facts block: expected exactly one start and one end sentinel, found ` +
        `${startCount} start / ${endCount} end — a merge-conflict artifact or hand-edit likely left ` +
        `duplicate or truncated markers`,
    );
  } else if (text.indexOf(FACTS_START) > text.indexOf(FACTS_END)) {
    violations.push('malformed facts block: the start marker appears after the end marker');
  }

  // 2. Bounds — the render soft cap is the growth signal the renderer surfaces.
  const lineCount = text.split('\n').length;
  if (lineCount > MEMORY_MD_SOFT_LINE_CAP) {
    violations.push(
      `over the render soft cap: ${lineCount} lines > ${MEMORY_MD_SOFT_LINE_CAP} — compact the committed memory`,
    );
  }

  // 3. Best-effort secret scan — reuse the same redactor the output boundary
  // uses (env-var `KEY=value`, `Bearer …`, `Authorization: …`, and long
  // delimited base64 shapes; not a security guarantee). Committed memory is
  // repo knowledge and legitimately references commit SHAs / content hashes,
  // which the generic base64-after-delimiter rule would flag — so neutralize
  // standalone 40/64-char hex runs (git SHA-1/SHA-256) first to avoid a false
  // positive on normal memory. Real credentials are not bare lowercase hex.
  const masked = text.replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/gi, 'HASH');
  const scrubbed = redactSecrets(masked);
  if (scrubbed !== masked) {
    violations.push('a secret-like token was found in committed memory — redact it before committing');
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Entry point.
 * @param {string[]} args  CLI args (without node/script); args[0] optional repoRoot.
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  const repoRoot = args[0] && args[0] !== '' ? args[0] : process.cwd();
  const path = memoryMdPath(repoRoot);

  /** @type {string} */
  let content;
  try {
    content = await readTextFile(path);
  } catch (/** @type {unknown} */ err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') {
      // No committed memory to guard — nothing to fail on. The "has committed
      // memory but no guardrail wired" case is the doctor's concern (#213).
      process.stdout.write(`[check-memory] no committed memory at ${MEMORY_PATH}; nothing to check.\n`);
      return 0;
    }
    process.stderr.write(`[check-memory] FAIL — cannot read ${MEMORY_PATH}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { ok, violations } = evaluateCommittedMemory(content);
  if (ok) {
    process.stdout.write(`[check-memory] OK — ${MEMORY_PATH} passes marker, bounds, and secret-scan checks.\n`);
    return 0;
  }
  process.stderr.write(`[check-memory] FAIL — ${violations.length} violation(s) in ${MEMORY_PATH}:\n`);
  for (const v of violations) {
    process.stderr.write(`  - ${v}\n`);
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
