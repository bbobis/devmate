// @ts-check
import { join } from 'node:path';
import { listDirEntries, readTextFile } from '../fs-safe.mjs';
import { getLedgerStats } from './ledger-stats.mjs';
import { memoryMdPath, repoLedgerPath, TASK_LEDGER_DIR } from './paths.mjs';

const FACTS_START = '<!-- devmate:facts:start -->';
const FACTS_END = '<!-- devmate:facts:end -->';

/**
 * @typedef {Object} MemoryDiagnosis
 * @property {boolean} ok                       True when no stage looks broken.
 * @property {{ ledgers: number, pendingFacts: number }} collection  Task ledgers (transient staging).
 * @property {{ activeFacts: number, entries: number }}  promotion   Repo ledger (promoted).
 * @property {{ exists: boolean, hasMarkerBlock: boolean, renderedFactLines: number }} render  MEMORY.md.
 * @property {('collection'|'promotion'|'render'|null)} firstBrokenStage  First stage that looks broken.
 * @property {string[]} findings                Human-readable diagnosis lines.
 */

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
  } else if (repoStats.activeCount !== renderedFactLines) {
    firstBrokenStage = 'render';
    findings.push(
      `Repo ledger has ${repoStats.activeCount} active fact(s) but .devmate/MEMORY.md renders ` +
        `${renderedFactLines} — render is stale or not running (re-render via ` +
        'session-stop / complete-task / compaction).',
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

  return {
    ok: firstBrokenStage === null,
    collection: { ledgers, pendingFacts },
    promotion: { activeFacts: repoStats.activeCount, entries: repoStats.entryCount },
    render: { exists, hasMarkerBlock, renderedFactLines },
    firstBrokenStage,
    findings,
  };
}
