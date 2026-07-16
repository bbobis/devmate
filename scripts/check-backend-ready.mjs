// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";
import {
  checkBackendReady,
  loadHealthPredicates,
  markBackendReadyStale,
} from "../lib/workflow/backend-ready.mjs";

/**
 * `check-backend-ready` entrypoint. Loads health predicates (config-driven, no
 * Spring default), runs the check, prints a compact result JSON. Also writes
 * result to .devmate/state/backend-ready-result.json so the agent can read_file
 * when shell integration is absent (E11-1).
 *
 * Flags:
 *   --config <path>            Explicit health-predicates JSON file.
 *   --mark-stale-on-failure    Update task state on failure.
 *
 * Exit: 0 when ready, 1 when not.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  let configPath;
  const cIdx = args.indexOf("--config");
  const cVal = args.at(cIdx + 1);
  if (cIdx !== -1 && cVal) configPath = cVal;
  const markStale = args.includes("--mark-stale-on-failure");

  let predicates;
  try {
    predicates = await loadHealthPredicates(configPath);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errResult = { ready: false, reason: msg, failedPredicates: [] };
    await writeResult(".devmate/state/backend-ready-result.json", errResult);
    process.stdout.write(JSON.stringify(errResult) + "\n");
    return 1;
  }

  const result = await checkBackendReady(predicates);
  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/backend-ready-result.json", result);
  process.stdout.write(JSON.stringify(result) + "\n");

  if (!result.ready && markStale) {
    const stateResult = readTaskState();
    if (stateResult.ok) {
      await markBackendReadyStale(stateResult.state, result.reason);
    }
  }

  return result.ready ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
