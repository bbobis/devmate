// @ts-check
/**
 * Who ran? Ask the host, not the model.
 *
 * A worker's return had exactly one way to say which agent produced it: an
 * `agentName` field the MODEL had to remember to put in its own reply, which a
 * parser then had to find inside prose. When a grill report forgot it — or buried it
 * where the parser could not see it — the return became unattributable, and an
 * unattributable return is discarded. A completed dispatch left no artifact, no
 * worker-return file, and no explanation.
 *
 * But the host already knows. From the captured payloads (and pinned in
 * `test/conformance/agent-identity.test.mjs`):
 *
 *   SubagentStart : { agent_id: "toolu_bdrk_01UqQ…", agent_type: "router" }
 *   PostToolUse   : { tool_use_id: "toolu_bdrk_01UqQ…__vscode-1783942732395" }
 *
 * `agent_id` IS the `tool_use_id` of the `runSubagent` call that spawned the agent —
 * the completion carries that id plus a host-appended suffix. So the identity of
 * every return is derivable from two events devmate already receives, with no
 * cooperation from the model at all.
 *
 * This module is that join. The self-reported `agentName` remains a fallback (it is
 * right whenever it is present), but it is no longer the only channel — which means
 * a forgetful agent now costs a field, not an artifact.
 *
 * The index is bookkeeping, not a ledger: it is bounded, and every failure to read
 * or write it is swallowed. Losing it degrades attribution back to self-report; it
 * must never take down a session.
 */
import { join } from 'node:path';
import { ensureDirSync, pathExists, readTextFileSync } from '../fs-safe.mjs';
import { writeJsonFileAtomic } from '../json-io.mjs';
import { parseJsonSafe } from '../json-io.mjs';
import { getOwn } from '../object-utils.mjs';

/** Where the agent_id -> agent_type index lives, relative to the workspace root. */
export const SUBAGENT_INDEX_PATH = '.devmate/state/subagent-index.json';

/**
 * How many dispatches to remember. A session's returns arrive within a few turns of
 * their start, so the tail is dead weight; an unbounded file would grow for the life
 * of the repo and buy nothing.
 */
const MAX_ENTRIES = 200;

/**
 * @typedef {Object} SubagentEntry
 * @property {string} agentId
 * @property {string} agentType
 */

/**
 * Read the index. A missing, unreadable, or corrupt file is an empty index — never
 * an error.
 * @param {string} repoRoot
 * @returns {SubagentEntry[]}
 */
export function readSubagentIndex(repoRoot) {
  const path = join(repoRoot, SUBAGENT_INDEX_PATH);
  if (!pathExists(path)) return [];

  try {
    const parsed = parseJsonSafe(readTextFileSync(path));
    const entries = parsed === null ? null : getOwn(/** @type {Record<string, unknown>} */ (parsed), 'entries');
    if (!Array.isArray(entries)) return [];

    /** @type {SubagentEntry[]} */
    // @bounded-alloc — capped at MAX_ENTRIES on write.
    const out = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = /** @type {Record<string, unknown>} */ (entry);
      const agentId = getOwn(record, 'agentId');
      const agentType = getOwn(record, 'agentType');
      if (typeof agentId === 'string' && agentId !== '' && typeof agentType === 'string' && agentType !== '') {
        out.push({ agentId, agentType });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Record the agent a `SubagentStart` names. Idempotent per `agentId`.
 *
 * @param {string} repoRoot
 * @param {{ agentId: string, agentType: string }} dispatch
 * @returns {Promise<void>}
 */
export async function recordSubagentStart(repoRoot, dispatch) {
  if (dispatch.agentId === '' || dispatch.agentType === '') return;

  const existing = readSubagentIndex(repoRoot).filter((e) => e.agentId !== dispatch.agentId);
  const entries = [...existing, { agentId: dispatch.agentId, agentType: dispatch.agentType }].slice(
    -MAX_ENTRIES,
  );

  ensureDirSync(join(repoRoot, '.devmate', 'state'));
  await writeJsonFileAtomic(join(repoRoot, SUBAGENT_INDEX_PATH), { entries });
}

/**
 * The agent a completion belongs to, resolved from the index.
 *
 * The join is a prefix test, not equality: the host appends a `__vscode-<n>` suffix
 * to the `agent_id` when it builds the completion's `tool_use_id`. Equality is still
 * accepted first, so a host that stops appending the suffix keeps working.
 *
 * @param {string} repoRoot
 * @param {unknown} toolUseId
 * @returns {string|null}
 */
export function resolveAgentName(repoRoot, toolUseId) {
  if (typeof toolUseId !== 'string' || toolUseId === '') return null;

  for (const entry of readSubagentIndex(repoRoot)) {
    if (toolUseId === entry.agentId || toolUseId.startsWith(`${entry.agentId}__`)) {
      return entry.agentType;
    }
  }
  return null;
}
