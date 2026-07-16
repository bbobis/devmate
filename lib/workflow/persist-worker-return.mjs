// @ts-check
/**
 * Persist a subagent's result to `.devmate/state/worker-returns/`.
 *
 * The orchestrator prompt tells it to validate every dispatch with
 * `orch-assert-dispatch.mjs --file <result-path>`, and `merge-discovery.mjs`
 * reads `.devmate/state/worker-returns/`. But NOTHING in the repo ever wrote a
 * file there: `@discovery` is `tools: [read, search]`, `@tech-design` has no
 * `edit`, and the orchestrator has neither `edit` nor `execute`. The directory
 * was not even in `STATE_DIRS`. So the artifact the whole dispatch protocol is
 * built on could never exist, every validation step was unrunnable, and a lane
 * that had in fact produced good results looked like it had produced nothing.
 *
 * The host is the only party that sees a subagent's return, so the hook is the
 * only honest place to write it down.
 */
import { join } from "node:path";
import { ensureDirSync } from "../fs-safe.mjs";
import { writeTextFile } from "../fs-safe.mjs";

/** Relative dir holding one file per subagent dispatch. */
export const WORKER_RETURNS_DIR = ".devmate/state/worker-returns";

/**
 * Filesystem-safe filename for a dispatch result.
 *
 * Keyed by `toolUseId`, not by agent name: the orchestrator dispatches
 * `@discovery` K times in one parallel wave, and a name-keyed file would have
 * each worker silently overwrite the last — leaving one survivor and looking
 * like a fan-out that mostly vanished. `tool_use_id` is unique per dispatch and
 * present on every captured payload.
 *
 * @param {string} agentName
 * @param {string} toolUseId
 * @returns {string}
 */
export function workerReturnFilename(agentName, toolUseId) {
  const safeAgent = agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const safeId = toolUseId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safeAgent}.${safeId}.json`;
}

/**
 * Write one dispatch result under the workspace root.
 *
 * @param {string} repoRoot  Absolute workspace root.
 * @param {{ agentName: string, toolUseId: string, result: Record<string, unknown> }} dispatch
 * @returns {Promise<string>}  Absolute path written.
 */
export async function persistWorkerReturn(repoRoot, dispatch) {
  const dir = join(repoRoot, WORKER_RETURNS_DIR);
  ensureDirSync(dir);

  const path = join(dir, workerReturnFilename(dispatch.agentName, dispatch.toolUseId));
  await writeTextFile(path, `${JSON.stringify(dispatch.result, null, 2)}\n`);
  return path;
}
