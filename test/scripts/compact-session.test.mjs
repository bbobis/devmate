// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/compact-session.mjs';

/** @type {string[]} */
let outWrites = [];
/** @type {string[]} */
let errWrites = [];
/** @type {typeof process.stdout.write} */
const realOut = process.stdout.write.bind(process.stdout);
/** @type {typeof process.stderr.write} */
const realErr = process.stderr.write.bind(process.stderr);

function capture() {
  outWrites = [];
  errWrites = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        outWrites.push(String(chunk));
        return true;
      }
    );
  process.stderr.write =
    /** @type {typeof process.stderr.write} */ (
      (/** @type {string} */ chunk) => {
        errWrites.push(String(chunk));
        return true;
      }
    );
}

function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/**
 * Build a task.json. When selfSufficient, include a goal so resume is READY.
 * @param {{ selfSufficient: boolean }} opts
 * @returns {Promise<{ taskStatePath: string, outDir: string }>}
 */
async function makeTask(opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-cli-'));
  const taskStatePath = path.join(dir, 'task.json');
  /** @type {Record<string, unknown>} */
  const state = { taskId: 'cli-task' };
  if (opts.selfSufficient) {
    state.outputContract = { done_when: 'ship it' };
    // Persisted evidence pointer so resume passes the context check.
    state.evidencePack = {
      pointers: [{ path: 'lib/x.mjs', lineRange: null, reason: 'r', confidence: 0.9, freshness: 'now', kind: 'file' }],
    };
  }
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  return { taskStatePath, outDir: path.join(dir, 'out') };
}

test('compact-session main() / writes artifact and prints READY when self-sufficient', async () => {
  const { taskStatePath, outDir } = await makeTask({ selfSufficient: true });
  capture();
  let code;
  try {
    code = await main([taskStatePath, outDir]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  // #77: PreCompact is one of the two events VS Code documents no context
  // channel for, so these progress lines leave on stderr rather than as text on
  // stdout that the host would try (and fail) to parse as JSON.
  const blob = errWrites.join('');
  assert.match(blob, /Compaction written:/);
  assert.match(blob, /resume: READY/);
  // Artifact file actually exists.
  const files = (await fsp.readdir(outDir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
});

test('compact-session main() / exits 0 even for incomplete artifact (prints warning only)', async () => {
  const { taskStatePath, outDir } = await makeTask({ selfSufficient: false });
  capture();
  let code;
  try {
    code = await main([taskStatePath, outDir]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.match(errWrites.join(''), /resume: INCOMPLETE/);
});
