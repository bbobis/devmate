// @ts-check
/**
 * Read the discovery worker returns that `hooks/post-tool-use.mjs` persists to
 * `.devmate/state/worker-returns/`.
 *
 * Extracted from `scripts/merge-discovery.mjs` (#91) so the CLI and the
 * gate-advance hook read the fan-in inputs through ONE implementation. The hook
 * needs the same read to derive `discovery-merged.json` — the evidence the
 * `discovery-done` gate precondition requires — and a second private copy of
 * this loop is exactly the drift this repo keeps paying for.
 */
import { join } from 'node:path';
import { listDirSync } from '../fs-safe.mjs';
import { readJsonFileSync } from '../json-io.mjs';

/** Relative dir holding one file per subagent dispatch. */
export { WORKER_RETURNS_DIR } from './persist-worker-return.mjs';

/**
 * Read every discovery worker-return artifact from the worker-returns
 * directory, in deterministic (sorted-filename) order. A parsed object whose
 * `agentName` is not `'discovery'` is another agent's return and is skipped by
 * design; a file that fails to read/parse (or parses to a non-object) is
 * counted in `unreadable` so corruption is never invisible. Structural validity
 * of the kept inputs is judged by `mergeDiscoveryArtifacts` itself
 * (`stats.invalidInputs`).
 * @param {string} returnsDir  Absolute path to `.devmate/state/worker-returns`.
 * @returns {{ artifacts: unknown[], workerIds: string[], unreadable: number }}
 */
export function readDiscoveryReturns(returnsDir) {
  const names = listDirSync(returnsDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  /** @type {unknown[]} */
  const artifacts = [];
  /** @type {string[]} */
  const workerIds = [];
  let unreadable = 0;
  for (const name of names) {
    const parsed = readJsonFileSync(join(returnsDir, name));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      unreadable += 1;
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (parsed);
    if (record['agentName'] !== 'discovery') continue;
    artifacts.push(parsed);
    workerIds.push(name.slice(0, -'.json'.length));
  }
  return { artifacts, workerIds, unreadable };
}
