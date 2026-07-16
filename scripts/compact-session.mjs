// @ts-check
import { dirname, join, resolve, sep } from 'node:path';
import { compactAndReclaim } from "../lib/context/compaction.mjs";
import { readJsonFile } from '../lib/json-io.mjs';
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { createTextCapture, writeHookOutput } from '../lib/hooks/output-schema.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { captureMemory } from '../lib/memory/capture.mjs';
import { readTaskState, writeTaskState } from '../lib/task-state.mjs';
import { reduceEvidencePack } from '../lib/context/context-reducer.mjs';

/** Default TaskState path when none is supplied. */
const DEFAULT_TASK_STATE = ".devmate/state/task.json";
/** Default output directory for compaction artifacts. */
const DEFAULT_OUTPUT_DIR = ".devmate/state/compaction/";

/**
 * E4-7: `compact-session` — PreCompact hook + CLI entrypoint (TCM-7).
 *
 * Builds a typed CompactionArtifact from TaskState + trace, writes it as JSON
 * plus a Markdown companion, and reports whether the artifact is self-sufficient
 * for resume. A critical BudgetWarning (E4-6) can also trigger this proactively.
 *
 * Usage:
 *   node scripts/compact-session.mjs [taskStatePath] [outputDir]
 *
 * Exit: 0 normally — even for an incomplete artifact (a warning is printed).
 *       1 only on an I/O error while building or writing.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  // Defaults anchor on the resolved workspace root. This is a PreCompact hook
  // command (hooks.json), so its cwd is whatever the host chose — the
  // workspace's own .devmate/ folder in the monoroot layout — and the old
  // cwd-relative defaults read/wrote the doubled .devmate/.devmate paths (#76).
  const hookRoot = resolveHookRoot();
  const taskStatePath = args[0] || join(hookRoot, DEFAULT_TASK_STATE);
  const outputDir = args[1] || join(hookRoot, DEFAULT_OUTPUT_DIR);

  // PreCompact is one of the two events VS Code documents no context channel
  // for — its output is the common format only. These progress lines are
  // diagnostics, so they leave on stderr; printing them to stdout only made the
  // host fail to parse it as JSON (#77).
  const capture = createTextCapture();

  // #87: refuse to "compact" a task that is not there.
  //
  // A compaction is the ONLY way out of a critical budget breach — the gate
  // guard denies every source edit until the marker is cleared, and the model
  // tells the user to run this script to clear it. So a run that quietly does
  // nothing is not a harmless no-op: it is the advertised remedy lying, and the
  // user stays blocked with no signal why.
  //
  // That is not hypothetical. A hook resolves its root from the payload's cwd;
  // a human running this from a terminal resolves it from the terminal's cwd.
  // In a multi-root workspace those are different directories, so the script
  // read a task.json that was not there, built an artifact for the sentinel task
  // id "unknown-task" (lib/context/compaction.mjs), cleared a marker that did
  // not exist at that path, printed "Compaction written", and left the real
  // marker — and the block — exactly where they were.
  //
  // No task state, no compaction: say which path was checked, and how to aim it.
  const taskState = await readJsonFile(resolve(taskStatePath));
  const taskId =
    taskState !== null && typeof taskState === 'object'
      ? /** @type {Record<string, unknown>} */ (taskState)['taskId']
      : undefined;
  if (typeof taskId !== 'string' || taskId === '') {
    process.stderr.write(
      `compact-session: no devmate task at ${resolve(taskStatePath)}\n` +
        'Nothing was compacted, and no budget-critical marker was cleared.\n' +
        "The workspace root was inferred from this process's working directory, which for a " +
        'terminal run is not necessarily the root the hooks use. Point it at the task state ' +
        'explicitly:\n' +
        `  node scripts/compact-session.mjs WORKSPACE${sep}.devmate${sep}state${sep}task.json\n`,
    );
    return writeHookOutput('PreCompact', capture.text(), 1);
  }

  // When compacting against the canonical TaskState path, promote any active
  // task ledger and re-render .devmate/MEMORY.md before the context is dropped
  // (TCM-7). Shared with the Stop hook via captureMemory so the two triggers
  // never drift. Best-effort — warnings only, never fatal to compaction.
  const taskStateAbs = resolve(taskStatePath);
  const normalised = taskStateAbs.split('\\').join('/');
  if (normalised.endsWith('/.devmate/state/task.json')) {
    const repoRoot = resolve(dirname(taskStateAbs), '..', '..');
    await captureMemory(repoRoot, {
      warn: (msg) => process.stderr.write(`compact: ${msg}\n`),
    });
  }

  // E9-19: an over-budget evidence pack is MapReduce-reduced before the
  // compaction artifact is built, so the artifact carries bounded, deduped
  // pointers instead of an oversized (or truncated) list. Best-effort.
  try {
    const stateForPack = readTaskState(resolve(taskStatePath));
    if (stateForPack.ok && stateForPack.state.evidencePack) {
      const pack = stateForPack.state.evidencePack;
      const reduced = await reduceEvidencePack(pack);
      if (reduced !== null) {
        const boundedPointers = reduced.allPointers.slice(0, pack.maxSources);
        await writeTaskState(
          { ...stateForPack.state, evidencePack: { ...pack, pointers: boundedPointers } },
          resolve(taskStatePath),
        );
        capture.stream.write(
          `Evidence pack reduced: ${reduced.originalCount} -> ${boundedPointers.length} pointer(s).\n`,
        );
      }
    }
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`compact: evidence reduce failed (non-fatal): ${msg}\n`);
  }

  try {
    // E9-08 + #87: writing the artifact and reclaiming the budget are ONE step
    // (lib/context/compaction.mjs). They used to be two, and that is how they
    // came apart: the marker was cleared without anything shrinking, so the next
    // tool call re-measured the same session and re-blocked every edit.
    const { jsonPath, resume, reset } = await compactAndReclaim({
      taskStatePath: resolve(taskStatePath),
      outputDir,
    });

    const status = resume.ok ? 'READY' : `INCOMPLETE — ${resume.missingFields.join(', ')}`;
    capture.stream.write(`Compaction written: ${jsonPath} (resume: ${status})\n`);
    if (reset.sessionArchivedTo !== null) {
      capture.stream.write(`Session markdown archived: ${reset.sessionArchivedTo}\n`);
    }
    // "cleared" is a claim about the edit-blocking marker, so it must be true.
    // markerCleared is false both when there was no marker AND when removing it
    // failed, so reporting the second case as "absent" would tell the user the
    // block is gone when it is not — the exact class of lie this whole change is
    // about. Anything that is not a confirmed clear reads as "unchanged", and the
    // reason follows on stderr.
    capture.stream.write(
      `Context budget reset (meter: ${reset.contextMeterReset ? 'zeroed' : 'unchanged'}, ` +
        `marker: ${reset.markerCleared ? 'cleared' : 'unchanged'}).\n`,
    );
    for (const err of reset.errors) {
      process.stderr.write(`compact: ${err} (non-fatal)\n`);
    }
    return writeHookOutput('PreCompact', capture.text(), 0);
  } catch (/** @type {any} */ err) {
    process.stderr.write(
      `compact-session: I/O error — ${err?.message ?? String(err)}\n`,
    );
    return writeHookOutput('PreCompact', capture.text(), 1);
  }
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
