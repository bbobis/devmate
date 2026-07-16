// @ts-check
// Agent-invoked entrypoint: promote a completed task's facts into the repo
// ledger, then record a compact `task_complete` summary. Never prints full
// ledger contents (E3-4).
import { join } from "node:path";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNodeVersion } from "../lib/env-guard.mjs";
import { pathExists } from "../lib/fs-safe.mjs";
import { appendJsonl } from "../lib/memory/append-jsonl.mjs";
import { promoteLedger } from "../lib/memory/promote.mjs";
import { renderMemory } from '../lib/memory/render-memory.mjs';
import {
  memoryMdPath,
  repoLedgerPath,
  taskLedgerPath,
  validateTaskId,
} from '../lib/memory/paths.mjs';
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";

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
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = args.at(i + 1);
      if (next && !next.startsWith("--")) {
        out.set(a.slice(2), next);
        i++;
      } else {
        out.set(a.slice(2), "true");
      }
    }
  }
  return out;
}

/**
 * Entrypoint. Task id defaults to TaskState.taskId; `--task-id <id>` can
 * override for test harnesses and recovery workflows. `--root <dir>` defaults
 * to cwd. `--conflict-policy <keep-existing|keep-incoming|keep-both>` optional.
 * @param {string[]} args
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  const opts = parseArgs(args);
  const root = resolve(opts.get("root") || process.cwd());
  const policy =
    /** @type {import('../lib/types.mjs').ConflictPolicy|undefined} */ (
      opts.get("conflict-policy")
    );
  const completionLog = join(root, '.devmate/state/completions.jsonl');

  const statePath = join(root, ".devmate", "state", "task.json");
  const stateResult = readTaskState(statePath);
  if (!stateResult.ok) {
    process.stderr.write(
      "complete-task: task state is unreadable; refusing completion.\n",
    );
    return 1;
  }

  const state = stateResult.state;
  const taskIdOverride = opts.get('task-id');
  const taskId =
    taskIdOverride && taskIdOverride !== 'true'
      ? taskIdOverride
      : state.taskId;
  try {
    validateTaskId(taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`complete-task: invalid task id: ${msg}\n`);
    return 2;
  }

  const taskLedger = taskLedgerPath(root, taskId);
  const repoLedger = repoLedgerPath(root);

  const guardedGate =
    state.workflowGate === "impl-started" ||
    state.workflowGate === "verification-passed";

  if (guardedGate) {
    const tddGuard = state.tddGuard;
    const hasOverride = tddGuard?.overrideGranted === true;
    const hintSaysWritten = tddGuard?.testFileWritten === true;

    if (!hasOverride && !hintSaysWritten) {
      process.stderr.write(
        "complete-task: write-first gate blocked completion. Write a test file first or grant approve no-tdd with a reason.\n",
      );
      return 1;
    }

    // Resolve the sibling verifier relative to THIS script's own location
    // (the installed plugin's scripts/ dir), never relative to the consumer
    // `root` — in an installed deployment scripts/ is not under the workspace.
    const verifierPath = fileURLToPath(new URL("./verify-test-files.mjs", import.meta.url));
    const verify = spawnSync(process.execPath, [verifierPath], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    if (verify.status !== 0) {
      process.stderr.write(
        "complete-task: test file verification failed; see .devmate/state/test-files-result.json.\n",
      );
      return 1;
    }
  }

  /** @type {import('../lib/types.mjs').PromoteResult} */
  let result;
  /** @type {number|null} */
  let factsRendered = null;
  if (!pathExists(taskLedger)) {
    process.stderr.write(
      `${JSON.stringify({ event: 'memory.promote.skipped', reason: 'no_task_ledger', taskId })}\n`,
    );
    result = {
      ok: true,
      promoted: 0,
      skipped: 0,
      conflicts: 0,
      records: [],
      error: null,
    };
  } else {
    result = await promoteLedger(taskLedger, repoLedger, {
      taskId,
      ...(policy ? { conflictPolicy: policy } : {}),
    });
    if (result.ok) {
      const renderResult = await renderMemory(repoLedger, memoryMdPath(root));
      if (!renderResult.ok) {
        process.stderr.write(
          `memory render failed: ${renderResult.error ?? 'unknown error'}\n`,
        );
      } else {
        factsRendered = renderResult.factsRendered ?? 0;
        process.stderr.write(
          `${JSON.stringify({
            event: 'memory.rendered',
            factsRendered,
            memoryPath: renderResult.memoryPath,
          })}\n`,
        );
      }
    }
  }

  // Record a compact task_complete entry (plain JSONL — not a strict loop
  // trace event, so it does not require a loop-trace schema change).
  const completion = {
    event: "task_complete",
    taskId,
    ok: result.ok,
    promoted: result.promoted,
    skipped: result.skipped,
    conflicts: result.conflicts,
    error: result.error,
    ts: Date.now(),
  };
  await appendJsonl(completionLog, completion).catch(() => {});

  // Compact summary object.
  const summary = {
    task_complete: taskId,
    ok: result.ok,
    promoted: result.promoted,
    skipped: result.skipped,
    conflicts: result.conflicts,
    ...(factsRendered !== null ? { factsRendered } : {}),
    error: result.error,
  };

  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/complete-task-result.json", summary);
  // Compact stdout summary only — never the ledger contents.
  process.stdout.write(JSON.stringify(summary) + "\n");

  return result.ok ? 0 : 1;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (entryPath === modulePath) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
