// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { HANDOFF_DIR, writeHandoff } from "../lib/handoff/write-handoff.mjs";
import { resolveHookRoot } from "../lib/init/repo-root.mjs";
import { join } from "node:path";
import { buildHandoffInput } from "../lib/handoff/build-handoff-input.mjs";

/**
 * E6-3: `create-handoff` — agent-invoked. Builds a handoff artifact from the
 * current trace resume summary after a halt, compaction, or manual trigger.
 *
 * Flags:
 *   --task <taskId>       Required.
 *   --reason <halt|compaction|manual>   Required. Drives currentState.
 *   --purpose <string>    Optional one-line purpose override.
 *   --trace-dir <dir>     Optional. Trace dir (tests).
 *   --handoff-dir <dir>   Optional. Handoff base dir (tests).
 *
 * Exit: 0 on success (prints both paths), 1 on bad usage.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  /** @param {string} flag */
  const val = (flag) => {
    const idx = args.indexOf(flag);
    const next = args.at(idx + 1);
    return idx !== -1 && next ? next : undefined;
  };

  const taskId = val("--task");
  const reason = val("--reason");
  const purposeOverride = val("--purpose");
  const traceDir = val("--trace-dir");
  // Default anchors on the resolved workspace root, not the cwd: this CLI runs
  // in the integrated terminal, which opens at workspaceFolders[0] — the
  // workspace's own .devmate/ folder in the monoroot layout (#76).
  const handoffDir =
    val("--handoff-dir") ?? join(resolveHookRoot(), HANDOFF_DIR);

  if (
    !taskId ||
    !reason ||
    !["halt", "compaction", "manual"].includes(reason)
  ) {
    process.stdout.write(
      "Usage: create-handoff --task [taskId] --reason [halt|compaction|manual] [--purpose [string]]\n",
    );
    return 1;
  }

  const input = await buildHandoffInput(taskId, {
    reason,
    ...(traceDir ? { traceDir } : {}),
    ...(purposeOverride ? { purpose: purposeOverride } : {}),
  });

  const { jsonPath, mdPath } = await writeHandoff(input, { handoffDir });
  process.stdout.write(`jsonPath: ${jsonPath}\n`);
  process.stdout.write(`mdPath: ${mdPath}\n`);
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
