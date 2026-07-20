// @ts-check
import { join } from 'node:path';
import { listDirEntries, readTextFile } from '../fs-safe.mjs';
import { getLedgerStats } from './ledger-stats.mjs';
import { memoryMdPath, repoLedgerPath, TASK_LEDGER_DIR } from './paths.mjs';
// Single source of truth for the facts sentinels (lib/memory/render-memory.mjs).
import { FACTS_START, FACTS_END } from './render-memory.mjs';

/**
 * @typedef {Object} MemoryDiagnosis
 * @property {boolean} ok                       True when no stage looks broken.
 * @property {{ ledgers: number, pendingFacts: number }} collection  Task ledgers (transient staging).
 * @property {{ activeFacts: number, entries: number }}  promotion   Repo ledger (promoted).
 * @property {{ exists: boolean, hasMarkerBlock: boolean, renderedFactLines: number }} render  MEMORY.md.
 * @property {('collection'|'promotion'|'render'|null)} firstBrokenStage  First stage that looks broken.
 * @property {boolean} guardrailUnenforced      True when a .devmate/MEMORY.md is present but no check-memory workflow guards it (non-blocking notice, #213).
 * @property {string[]} findings                Human-readable diagnosis lines.
 */

/**
 * Detect an opt-in `check-memory` promotion guardrail (#212) in the repo's own
 * `.github/workflows/`. Pure read: scans each top-level workflow file for a
 * reference to the bundled command. Heuristic — ANY textual reference counts
 * (including a comment), so it can under-report (a workflow that only mentions
 * `check-memory` reads as wired) but never over-reports a genuine invocation,
 * which always contains the string. The bias is toward silence, the safe
 * direction for a non-blocking notice. A repo with the guardrail wired is silent;
 * one without it gets the "unenforced committed memory" notice.
 * @param {string} repoRoot
 * @returns {Promise<boolean>}
 */
async function hasCheckMemoryWorkflow(repoRoot) {
  const dir = join(repoRoot, '.github', 'workflows');
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await listDirEntries(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    let content;
    try {
      content = await readTextFile(join(dir, entry.name));
    } catch {
      continue;
    }
    if (content.includes('check-memory')) return true;
  }
  return false;
}

/**
 * Health-check the three-stage memory pipeline for a repo, in sequence:
 *   1. collection — task ledgers `.devmate/memory/tasks/*.jsonl` (staging)
 *   2. promotion  — repo ledger `.devmate/state/repo/repo.jsonl`
 *   3. render     — `.devmate/MEMORY.md` marker-bounded facts block
 *
 * Task ledgers are transient (consumed on promotion), so a healthy end-state
 * has zero pending facts, a populated repo ledger, and a .devmate/MEMORY.md whose
 * rendered fact count matches the repo ledger's active facts. The diagnosis
 * names the FIRST stage that looks broken — the industry-standard `/memory`
 * check that surfaces a silent pipeline break. Pure read — never mutates.
 *
 * @param {string} repoRoot  Absolute repo root.
 * @returns {Promise<MemoryDiagnosis>}
 */
export async function diagnoseMemory(repoRoot) {
  // Stage 1 — collection: task ledgers still staging (not yet promoted).
  const taskDir = join(repoRoot, TASK_LEDGER_DIR);
  let ledgers = 0;
  let pendingFacts = 0;
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await listDirEntries(taskDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    ledgers += 1;
    const stats = await getLedgerStats(join(taskDir, entry.name));
    pendingFacts += stats.activeCount;
  }

  // Stage 2 — promotion: shared repo ledger.
  const repoStats = await getLedgerStats(repoLedgerPath(repoRoot));

  // Stage 3 — render: .devmate/MEMORY.md marker-bounded facts block.
  let memText = '';
  let exists = false;
  try {
    memText = await readTextFile(memoryMdPath(repoRoot));
    exists = true;
  } catch {
    exists = false;
  }
  // #213: a .devmate/MEMORY.md is present, but is the promotion guardrail wired?
  // The seeded .gitignore tracks .devmate/MEMORY.md, so a present file is
  // committed-by-convention — but this stays a pure read (presence, not a git
  // ls-files subprocess), so it detects the file, not its committed state. A
  // consumer relying on it without the opt-in check-memory workflow is trusting
  // it by convention — surface that, never silently assume.
  const guardrailUnenforced = exists && !(await hasCheckMemoryWorkflow(repoRoot));

  const startIdx = memText.indexOf(FACTS_START);
  const endIdx = memText.indexOf(FACTS_END);
  const hasMarkerBlock = startIdx !== -1 && endIdx !== -1 && startIdx < endIdx;
  let renderedFactLines = 0;
  if (hasMarkerBlock) {
    const block = memText.slice(startIdx + FACTS_START.length, endIdx);
    renderedFactLines = block
      .split('\n')
      .filter((line) => line.trim().startsWith('- ')).length;
  }

  // Diagnose the first broken stage, in pipeline order.
  /** @type {string[]} */
  const findings = [];
  /** @type {'collection'|'promotion'|'render'|null} */
  let firstBrokenStage = null;

  if (repoStats.activeCount === 0 && pendingFacts === 0 && renderedFactLines === 0) {
    firstBrokenStage = 'collection';
    findings.push(
      'No facts anywhere — no task ledgers, empty repo ledger, empty MEMORY.md. ' +
        'Collection may not be firing: check the PostToolUse hook and that a task ' +
        'is active with a valid taskId.',
    );
  } else if (pendingFacts > 0 && repoStats.activeCount === 0) {
    firstBrokenStage = 'promotion';
    findings.push(
      `${pendingFacts} fact(s) staged in ${ledgers} task ledger(s) but the repo ` +
        'ledger is empty — promotion has not run (session-stop, complete-task, or ' +
        'compaction promote the task ledger).',
    );
  } else if (repoStats.discoveryActiveCount !== renderedFactLines) {
    // Issue 150: the committed .devmate/MEMORY.md renders only SEMANTIC discovery facts,
    // not bare edit events. Compare like-for-like — the discovery-fact subset of
    // the repo ledger against the rendered lines. Comparing the FULL active count
    // here would falsely flag every normal mixed ledger (edit + discovery) as a
    // stale render.
    firstBrokenStage = 'render';
    findings.push(
      `Repo ledger has ${repoStats.discoveryActiveCount} active discovery fact(s) but ` +
        `.devmate/MEMORY.md renders ${renderedFactLines} — render is stale or not running ` +
        '(re-render via session-stop / complete-task / compaction).',
    );
  }

  if (pendingFacts > 0 && firstBrokenStage === null) {
    findings.push(
      `Note: ${pendingFacts} fact(s) still staged in ${ledgers} task ledger(s) — ` +
        'they promote on the next capture (session end, completion, or compaction).',
    );
  }

  if (findings.length === 0) {
    findings.push('Memory pipeline healthy: .devmate/MEMORY.md reflects the active repo ledger.');
  }

  // Non-blocking notice (#213): appended after the health findings and never
  // sets firstBrokenStage, so it informs without affecting `ok`.
  if (guardrailUnenforced) {
    findings.push(
      'A .devmate/MEMORY.md is present but the promotion guardrails are unenforced ' +
        '(no check-memory workflow found in .github/workflows/) — add the drop-in workflow ' +
        '(docs/memory.md) so CI verifies the committed memory is marker-valid, secret-free, ' +
        'and within bounds.',
    );
  }

  return {
    ok: firstBrokenStage === null,
    collection: { ledgers, pendingFacts },
    promotion: { activeFacts: repoStats.activeCount, entries: repoStats.entryCount },
    render: { exists, hasMarkerBlock, renderedFactLines },
    firstBrokenStage,
    guardrailUnenforced,
    findings,
  };
}
