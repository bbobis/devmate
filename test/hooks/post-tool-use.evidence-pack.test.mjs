// @ts-check
/**
 * E9-19: post-tool-use records EvidencePointers for file-read tool calls,
 * capped at the persisted outputContract.max_context_sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runWithIO } from '../../hooks/post-tool-use.mjs';

/**
 * @param {{ maxSources?: number, evidencePack?: unknown }} [opts]
 * @returns {Promise<{ root: string, statePath: string }>}
 */
async function makeWorkspace(opts = {}) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ptu-ep-'));
  const stateDir = join(root, '.devmate', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(join(root, 'src'), { recursive: true });
  await fsp.writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1;\n', 'utf8');
  await fsp.writeFile(join(root, 'src', 'b.mjs'), 'export const b = 2;\n', 'utf8');

  /** @type {Record<string, unknown>} */
  const state = {
    taskId: 't-evidence',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
    outputContract: {
      lane: 'feature',
      format: 'pr',
      audience: 'orchestrator',
      done_when: 'x',
      evidence_required: [],
      citation_mode: 'pointer',
      token_budget_class: 'standard',
      max_context_sources: opts.maxSources ?? 10,
      created_at: new Date().toISOString(),
    },
  };
  if (opts.evidencePack !== undefined) state.evidencePack = opts.evidencePack;
  const statePath = join(stateDir, 'task.json');
  await fsp.writeFile(statePath, JSON.stringify(state), 'utf8');
  return { root, statePath };
}

/**
 * @param {string} root
 * @param {string} toolName
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function runHook(root, toolName, filePath) {
  // #77: the real wire shape — the host anchors the hook with `cwd` and names
  // the target `tool_input.filePath`. `workspaceRoot` and `tool_input.path` were
  // devmate's own inventions, and a test that sends them proves nothing about
  // the payloads a user's VS Code actually delivers.
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    cwd: root,
    tool_input: { filePath },
  };
  const stdin = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  const sink = /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ ({
    write: () => true,
  }));
  return runWithIO(stdin, sink, sink);
}

/**
 * @param {string} statePath
 * @returns {Promise<any>}
 */
async function readState(statePath) {
  return JSON.parse(await fsp.readFile(statePath, 'utf8'));
}

test('read appends pointer', async () => {
  const { root, statePath } = await makeWorkspace();
  await runHook(root, 'read_file', 'src/a.mjs');
  const state = await readState(statePath);
  assert.ok(state.evidencePack, 'pack created on first read');
  assert.equal(state.evidencePack.pointers.length, 1);
  const pointer = state.evidencePack.pointers[0];
  assert.equal(pointer.path, 'src/a.mjs');
  assert.equal(pointer.kind, 'file');
  assert.equal(pointer.lineRange, null);
  assert.equal(state.evidencePack.stage, 'impl-started');
});

test('cap enforced at max_context_sources', async () => {
  const { root, statePath } = await makeWorkspace({ maxSources: 2 });
  // @bounded-alloc — writes 4 fixture files.
  for (let i = 0; i < 4; i++) {
    const file = `src/f${i}.mjs`;
    await fsp.writeFile(join(root, file), `// ${i}\n`, 'utf8');
    await runHook(root, 'read_file', file);
  }
  const state = await readState(statePath);
  assert.equal(state.evidencePack.pointers.length, 2, 'stops appending at the cap');
});

test('duplicate reads do not duplicate pointers', async () => {
  const { root, statePath } = await makeWorkspace();
  await runHook(root, 'read_file', 'src/a.mjs');
  await runHook(root, 'read_file', 'src/a.mjs');
  const state = await readState(statePath);
  assert.equal(state.evidencePack.pointers.length, 1);
});

test('non-read tools do not append pointers', async () => {
  const { root, statePath } = await makeWorkspace();
  await runHook(root, 'write_file', 'src/a.mjs');
  const state = await readState(statePath);
  assert.equal(state.evidencePack, undefined);
});

test('pointers include freshness from mtime', async () => {
  const { root, statePath } = await makeWorkspace();
  const mtime = new Date('2026-01-02T03:04:05.000Z');
  await fsp.utimes(join(root, 'src', 'a.mjs'), mtime, mtime);
  await runHook(root, 'read_file', 'src/a.mjs');
  const state = await readState(statePath);
  assert.equal(state.evidencePack.pointers[0].freshness, mtime.toISOString());
});
