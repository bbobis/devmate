// @ts-check
// Minimal MCP (Model Context Protocol) server exposing devmate memory recall as
// a first-class tool the model can call mid-session. Zero runtime dependencies
// by design (AGENTS.md): a hand-rolled JSON-RPC 2.0 handler over the stdio
// transport (newline-delimited JSON messages), not an SDK.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { queryMemory } from '../lib/memory/query.mjs';
import { repoLedgerPath } from '../lib/memory/paths.mjs';
import { buildMemoryContext } from '../lib/memory/memory-context.mjs';

/** @typedef {import('../lib/types.mjs').MemoryQueryRequest} MemoryQueryRequest */

const SERVER_INFO = { name: 'devmate-memory', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2024-11-05';

/**
 * The single recall tool. `query_memory` returns scored top-N pointer+summary
 * matches, verify-before-use by default (drops facts whose source no longer
 * resolves to live code).
 */
const QUERY_MEMORY_TOOL = {
  name: 'query_memory',
  description:
    'Recall relevant devmate facts (scored top-N pointer+summaries) from the repo ' +
    'memory ledger. Facts are hints — verify each against current code before ' +
    'relying on it. Drifted facts (source file gone) are dropped by default.',
  inputSchema: {
    type: 'object',
    properties: {
      lane: { type: 'string', description: 'Filter to a workflow lane (feature|bug|chore).' },
      pathPrefix: { type: 'string', description: 'Boost facts whose source starts with this prefix.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Boost facts matching these tags.' },
      text: { type: 'string', description: 'Free-text keyword hint.' },
      topN: { type: 'number', description: 'Max matches to return (default 10).' },
      includeExpired: { type: 'boolean', description: 'Include stale facts (audit mode).' },
      verify: { type: 'boolean', description: 'Verify-before-use: drop facts whose source is gone (default true).' },
    },
  },
};

/**
 * Resolve the repo root the ledger + verification are anchored to.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveRepoRoot(env) {
  return resolve(env.DEVMATE_REPO_ROOT ?? process.cwd());
}

/**
 * Run the `query_memory` tool and return an MCP tool-result payload.
 * @param {Record<string, unknown>} args
 * @param {string} repoRoot
 * @returns {Promise<{ content: Array<{ type: 'text', text: string }>, isError: boolean }>}
 */
export async function runQueryMemoryTool(args, repoRoot) {
  /** @type {MemoryQueryRequest} */
  const request = { tags: [] };
  if (typeof args.lane === 'string') request.lane = args.lane;
  if (typeof args.pathPrefix === 'string') request.pathPrefix = args.pathPrefix;
  if (Array.isArray(args.tags)) {
    request.tags = args.tags.filter((t) => typeof t === 'string');
  }
  if (typeof args.text === 'string') request.text = args.text;
  if (typeof args.topN === 'number') request.topN = args.topN;
  if (args.includeExpired === true) request.includeExpired = true;
  if (Array.isArray(request.tags) && request.tags.length === 0) delete request.tags;

  const verify = args.verify !== false; // default on
  const opts = verify ? { verifyRoot: repoRoot } : {};
  const result = await queryMemory(repoLedgerPath(repoRoot), request, opts);

  const text =
    result.matches.length > 0
      ? buildMemoryContext(result.matches)
      : 'No matching facts in memory.';
  return { content: [{ type: 'text', text }], isError: !result.ok };
}

/**
 * Handle a single JSON-RPC message. Calls `respond` with a response object for
 * requests (id present); notifications (no id) produce no response. Never
 * throws — tool errors are returned as JSON-RPC errors.
 * @param {any} msg
 * @param {(response: object) => void} respond
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<void>}
 */
export async function handleMessage(msg, respond, ctx) {
  const id = msg?.id;
  const method = msg?.method;
  const hasId = id !== undefined && id !== null;

  if (method === 'initialize') {
    const protocolVersion =
      typeof msg?.params?.protocolVersion === 'string'
        ? msg.params.protocolVersion
        : DEFAULT_PROTOCOL;
    respond({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    });
    return;
  }

  if (method === 'tools/list') {
    respond({ jsonrpc: '2.0', id, result: { tools: [QUERY_MEMORY_TOOL] } });
    return;
  }

  if (method === 'tools/call') {
    const name = msg?.params?.name;
    if (name !== QUERY_MEMORY_TOOL.name) {
      respond({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
      return;
    }
    try {
      const args = /** @type {Record<string, unknown>} */ (msg?.params?.arguments ?? {});
      const result = await runQueryMemoryTool(args, ctx.repoRoot);
      respond({ jsonrpc: '2.0', id, result });
    } catch (/** @type {unknown} */ err) {
      const message = err instanceof Error ? err.message : String(err);
      respond({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    }
    return;
  }

  if (method === 'ping') {
    respond({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // Unknown request → method-not-found. Notifications (no id) are ignored.
  if (hasId) {
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
}

/**
 * Wire the JSON-RPC handler to stdio (newline-delimited messages).
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv }} [io]
 * @returns {void}
 */
export function serve(io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const repoRoot = resolveRepoRoot(io.env ?? process.env);
  const respond = (/** @type {object} */ response) => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  const rl = createInterface({ input });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise
    }
    void handleMessage(msg, respond, { repoRoot });
  });
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  serve();
}
