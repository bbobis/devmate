// @ts-check
/**
 * #95: the two hooks must agree about what a tool IS.
 *
 * PostToolUse used to hand-author its own read set (`open_file`, `view_file`),
 * so a name could be a file read to one hook and an unrecognized source edit to
 * the other. The read set now derives from `lib/gate-guard-core.mjs`, and these
 * tests are what keep the two verdicts from drifting apart again: each one takes
 * a single tool name across the hook boundary and checks BOTH classifications.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  FILE_READ_TOOLS,
  KNOWN_SOURCE_EDIT_TOOLS,
  isFileReadTool,
  isSourceEditTool,
  isUnrecognizedTool,
} from '../../lib/gate-guard-core.mjs';
import { runWithIO } from '../../hooks/post-tool-use.mjs';

/**
 * A workspace with a persisted task state, so PostToolUse has somewhere to
 * append an evidence pointer.
 * @returns {Promise<{ root: string, statePath: string }>}
 */
async function makeWorkspace() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ptu-class-'));
  await fsp.mkdir(join(root, '.devmate', 'state'), { recursive: true });
  await fsp.mkdir(join(root, 'src'), { recursive: true });
  await fsp.writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1;\n', 'utf8');
  const statePath = join(root, '.devmate', 'state', 'task.json');
  await fsp.writeFile(
    statePath,
    JSON.stringify({
      taskId: 't-classify',
      lane: 'feature',
      workflowGate: 'impl-started',
      currentStep: 0,
      artifactHashes: {},
      preImplStash: null,
      budget: 10,
      schemaVersion: 1,
    }),
    'utf8',
  );
  return { root, statePath };
}

/**
 * Drive the real PostToolUse entrypoint with a captured-shape payload.
 * @param {string} root
 * @param {string} toolName
 * @returns {Promise<number>}
 */
async function runPostToolUse(root, toolName) {
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    cwd: root,
    tool_input: { filePath: 'src/a.mjs' },
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

test('no PostToolUse read tool is a PreToolUse source edit', () => {
  assert.ok(FILE_READ_TOOLS.length > 0, 'the read set is not empty');
  for (const toolName of FILE_READ_TOOLS) {
    // Omitted namedPaths is the fail-closed case for an unrecognized tool: a
    // read tool must be cleared on name alone, or PreToolUse would deny a call
    // PostToolUse records as evidence.
    assert.equal(
      isSourceEditTool(toolName, undefined, undefined),
      false,
      `${toolName} is a read to PostToolUse but an edit to PreToolUse`,
    );
    // Naming a source path must not flip the verdict either — a read of
    // lib/app.mjs is still a read.
    assert.equal(
      isSourceEditTool(toolName, undefined, ['lib/app.mjs']),
      false,
      `${toolName} became an edit because it named a source path`,
    );
    assert.equal(
      isUnrecognizedTool(toolName),
      false,
      `${toolName} is unknown to the classifier`,
    );
  }
});

test('the read set and the known-edit set are disjoint', () => {
  for (const toolName of FILE_READ_TOOLS) {
    assert.equal(
      KNOWN_SOURCE_EDIT_TOOLS.includes(toolName),
      false,
      `${toolName} is both a read and a known editor`,
    );
  }
});

test('open_file / view_file are not tool names devmate recognizes', () => {
  // Dropped in #95: ungrounded in every captured VS Code payload. Asserting the
  // absence keeps them from being reintroduced on one side of the boundary only.
  for (const toolName of ['open_file', 'view_file']) {
    assert.equal(isFileReadTool(toolName), false, `${toolName} claimed as a read`);
  }
});

test('every read tool records an evidence pointer at the PostToolUse boundary', async () => {
  for (const toolName of FILE_READ_TOOLS) {
    const { root, statePath } = await makeWorkspace();
    await runPostToolUse(root, toolName);
    const state = await readState(statePath);
    assert.equal(
      state.evidencePack?.pointers?.[0]?.path,
      'src/a.mjs',
      `${toolName} recorded no pointer`,
    );
  }
});

test('a tool outside the read set records no evidence pointer', async () => {
  const { root, statePath } = await makeWorkspace();
  await runPostToolUse(root, 'open_file');
  const state = await readState(statePath);
  assert.equal(state.evidencePack, undefined, 'open_file is no longer a read');
});
