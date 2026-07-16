// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCompactionArtifact,
  writeCompactionArtifact,
  loadCompactionArtifact,
  canResumeFromCompaction,
} from '../../../lib/context/compaction.mjs';

/**
 * Create a temp dir with a task.json and optional trace file.
 * @param {{
 *   outputContract?: Record<string, unknown>,
 *   evidencePack?: Record<string, unknown>,
 *   traceLines?: string[],
 * }} [opts]
 * @returns {Promise<{ dir: string, taskStatePath: string, traceFile: string }>}
 */
async function mkTask(opts = {}) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'compaction-'));
  const taskStatePath = join(dir, 'task.json');
  const traceFile = join(dir, 'trace.jsonl');

  /** @type {Record<string, unknown>} */
  const state = { taskId: 't-1' };
  if (opts.outputContract) state.outputContract = opts.outputContract;
  if (opts.evidencePack) state.evidencePack = opts.evidencePack;
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');

  if (opts.traceLines) await fsp.writeFile(traceFile, opts.traceLines.join('\n'), 'utf8');

  return { dir, taskStatePath, traceFile };
}

/**
 * Minimal valid evidence pointer.
 * @param {string} path
 * @returns {import('../../../lib/types.mjs').EvidencePointer}
 */
function pointer(path) {
  return { path, lineRange: [1, 10], reason: 'relevant', confidence: 0.9, freshness: new Date().toISOString(), kind: 'file' };
}

test('buildCompactionArtifact / extracts goal from OutputContract in TaskState', async () => {
  const { taskStatePath, traceFile } = await mkTask({
    outputContract: { done_when: 'All v0.3.0 issues merged.', evidence_required: ['failing-test'] },
  });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile });
  assert.equal(a.goal, 'All v0.3.0 issues merged.');
  assert.equal(a.taskId, 't-1');
  assert.deepEqual(a.constraints, ['Evidence required: failing-test']);
});

test('buildCompactionArtifact / populates nextAction from last step_complete trace event', async () => {
  const { taskStatePath, traceFile } = await mkTask({
    outputContract: { done_when: 'goal' },
    traceLines: [
      JSON.stringify({ type: 'step_complete', stepLabel: 'wrote module' }),
      JSON.stringify({ event: 'step_complete', label: 'added tests' }),
    ],
  });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile });
  assert.match(a.nextAction, /added tests/);
});

test('buildCompactionArtifact / falls back to default nextAction when trace absent', async () => {
  const { taskStatePath, dir } = await mkTask({ outputContract: { done_when: 'goal' } });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile: join(dir, 'nope.jsonl') });
  assert.equal(a.nextAction, 'Resume from compaction artifact — check nextAction field.');
});

test('buildCompactionArtifact / includes droppedCategories', async () => {
  const { taskStatePath, traceFile } = await mkTask({
    outputContract: { done_when: 'goal' },
    traceLines: [JSON.stringify({ type: 'loop_halt', lastError: 'boom' })],
  });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile });
  assert.ok(a.droppedCategories.includes('duplicate-tool-output'));
  assert.ok(a.droppedCategories.includes('stale-messages'));
  // halt present → failed-branches dropped, and the halt surfaces as a bug.
  assert.ok(a.droppedCategories.includes('failed-branches'));
  assert.match(a.unresolvedBugs[0], /boom/);
});

test('writeCompactionArtifact / writes JSON atomically, does not overwrite existing artifact', async () => {
  const { taskStatePath, traceFile, dir } = await mkTask({ outputContract: { done_when: 'goal' } });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile });
  const outDir = join(dir, 'out');
  const first = await writeCompactionArtifact(a, outDir);
  // Force a distinct timestamp suffix so the second file does not collide.
  await new Promise((r) => setTimeout(r, 5));
  const second = await writeCompactionArtifact(a, outDir);
  assert.notEqual(first.jsonPath, second.jsonPath);
  const files = (await fsp.readdir(outDir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  // No leftover tmp files.
  assert.equal((await fsp.readdir(outDir)).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('writeCompactionArtifact / writes Markdown companion when writeMarkdown=true', async () => {
  const { taskStatePath, traceFile, dir } = await mkTask({ outputContract: { done_when: 'ship it' } });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile });
  const outDir = join(dir, 'out');
  const { mdPath } = await writeCompactionArtifact(a, outDir, { writeMarkdown: true });
  assert.ok(mdPath);
  const md = await fsp.readFile(/** @type {string} */ (mdPath), 'utf8');
  assert.match(md, /## Goal/);
  assert.match(md, /ship it/);
});

test('loadCompactionArtifact / returns null for empty directory', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'compaction-empty-'));
  assert.equal(await loadCompactionArtifact(dir), null);
});

test('loadCompactionArtifact / returns most recent artifact from multiple files', async () => {
  const { taskStatePath, traceFile, dir } = await mkTask({ outputContract: { done_when: 'goal' } });
  const outDir = join(dir, 'out');
  const a1 = await buildCompactionArtifact({ taskStatePath, traceFile });
  a1.nextAction = 'first';
  await writeCompactionArtifact(a1, outDir);
  await new Promise((r) => setTimeout(r, 5));
  const a2 = await buildCompactionArtifact({ taskStatePath, traceFile });
  a2.nextAction = 'second';
  await writeCompactionArtifact(a2, outDir);

  const loaded = await loadCompactionArtifact(outDir);
  assert.ok(loaded);
  assert.equal(/** @type {import('../../../lib/types.mjs').CompactionArtifact} */ (loaded).nextAction, 'second');
});

test('canResumeFromCompaction / ok=false for empty artifact with named missingFields', async () => {
  const { taskStatePath, dir } = await mkTask({});
  const a = await buildCompactionArtifact({ taskStatePath, traceFile: join(dir, 'none.jsonl') });
  // goal empty (no contract), no decisions, no pointers.
  const r = canResumeFromCompaction(a);
  assert.equal(r.ok, false);
  assert.ok(r.missingFields.includes('goal'));
  assert.ok(r.missingFields.includes('evidencePointers|acceptedDecisions'));
});

test('canResumeFromCompaction / ok=true for artifact with goal + nextAction + one pointer', async () => {
  const { taskStatePath, traceFile } = await mkTask({ outputContract: { done_when: 'finish' } });
  const a = await buildCompactionArtifact({ taskStatePath, traceFile, additionalPointers: [pointer('lib/x.mjs')] });
  const r = canResumeFromCompaction(a);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missingFields, []);
});

test('resume-from-compaction-only / load written artifact and resume with no trace or session file', async () => {
  const { taskStatePath, traceFile, dir } = await mkTask({ outputContract: { done_when: 'ship v0.3.0' } });
  const built = await buildCompactionArtifact({ taskStatePath, traceFile, additionalPointers: [pointer('lib/y.mjs')] });
  const outDir = join(dir, 'standalone');
  await writeCompactionArtifact(built, outDir, { writeMarkdown: true });

  // Simulate a fresh session: only the artifact directory exists. Remove task + trace.
  await fsp.rm(taskStatePath, { force: true });
  await fsp.rm(traceFile, { force: true });

  const loaded = await loadCompactionArtifact(outDir);
  assert.ok(loaded);
  const r = canResumeFromCompaction(/** @type {import('../../../lib/types.mjs').CompactionArtifact} */ (loaded));
  assert.equal(r.ok, true);
  assert.equal(/** @type {import('../../../lib/types.mjs').CompactionArtifact} */ (loaded).goal, 'ship v0.3.0');
});
