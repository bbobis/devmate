// @ts-check
/**
 * E9-19: compaction reduces an over-budget evidence pack first, and the
 * compaction artifact carries the (real, bounded) pointers — exercising the
 * previously dead state.evidencePack.pointers branch in compaction.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as compactMain } from '../../scripts/compact-session.mjs';

/**
 * @param {number} pointerCount
 * @param {number} maxSources
 * @returns {Promise<{ dir: string, taskStatePath: string, outputDir: string }>}
 */
async function makeWorkspace(pointerCount, maxSources) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'compact-reduce-'));
  const pointers = Array.from({ length: pointerCount }, (_, i) => ({
    path: `src/file-${i}.mjs`,
    lineRange: null,
    reason: `read ${i}`,
    confidence: 1,
    freshness: new Date().toISOString(),
    kind: 'file',
  }));
  const state = {
    taskId: 't-reduce',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
    evidencePack: {
      taskId: 't-reduce',
      stage: 'impl-started',
      pointers,
      maxSources,
      created_at: new Date().toISOString(),
    },
  };
  const taskStatePath = join(dir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  return { dir, taskStatePath, outputDir: join(dir, 'compaction') };
}

/** Silence stdio during a run. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, out: string }>}
 */
async function runCompact(args) {
  // #77: PreCompact is one of the two events VS Code documents no context
  // channel for, so compact-session's progress lines leave on stderr. Both
  // streams are collected here — what matters to this suite is that the hook
  // said it, not which pipe carried it.
  /** @type {string[]} */
  const chunks = [];
  /** @type {typeof process.stdout.write} */
  const sink = /** @type {typeof process.stdout.write} */ (
    (/** @type {string|Buffer} */ c) => {
      chunks.push(String(c));
      return true;
    }
  );
  process.stdout.write = sink;
  process.stderr.write = /** @type {typeof process.stderr.write} */ (sink);
  let code;
  try {
    code = await compactMain(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join('') };
}

test('reducer runs when pack over budget', async () => {
  const { taskStatePath, outputDir } = await makeWorkspace(9, 3);
  const { code, out } = await runCompact([taskStatePath, outputDir]);
  assert.equal(code, 0);
  assert.match(out, /Evidence pack reduced: 9 -> \d+ pointer\(s\)\./);

  const state = JSON.parse(await fsp.readFile(taskStatePath, 'utf8'));
  assert.ok(state.evidencePack.pointers.length <= 3, 'pack bounded to maxSources');
  assert.ok(state.evidencePack.pointers.length > 0, 'pointers not emptied');
});

test('compaction artifact carries pointers', async () => {
  const { taskStatePath, outputDir } = await makeWorkspace(9, 3);
  const { code } = await runCompact([taskStatePath, outputDir]);
  assert.equal(code, 0);
  const files = await fsp.readdir(outputDir);
  const jsonFile = files.find((f) => f.endsWith('.json'));
  assert.ok(jsonFile, 'compaction artifact written');
  const artifact = JSON.parse(await fsp.readFile(join(outputDir, jsonFile), 'utf8'));
  assert.ok(Array.isArray(artifact.evidencePointers), 'artifact has evidencePointers');
  assert.ok(artifact.evidencePointers.length > 0, 'pointers are not empty (dead branch now live)');
  assert.ok(artifact.evidencePointers.every((/** @type {any} */ p) => typeof p.path === 'string'));
});

test('within-budget pack is untouched', async () => {
  const { taskStatePath, outputDir } = await makeWorkspace(2, 5);
  const { code, out } = await runCompact([taskStatePath, outputDir]);
  assert.equal(code, 0);
  assert.ok(!out.includes('Evidence pack reduced'), 'no reduction message');
  const state = JSON.parse(await fsp.readFile(taskStatePath, 'utf8'));
  assert.equal(state.evidencePack.pointers.length, 2);
});
