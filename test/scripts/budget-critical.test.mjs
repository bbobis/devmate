// @ts-check
/**
 * E9-08 + #87: what a critical budget breach actually does.
 *
 * E9-08 made critical actuate: it wrote the budget-critical marker, which makes
 * the gate guard deny every source edit, and a human was told to run compaction
 * to clear it. #87 found that this was a livelock (compaction cleared the marker
 * without reducing anything, so the next tool call re-blocked) and that handing
 * the job to a human terminal could resolve a different workspace root entirely.
 *
 * The contract now: a reclaimable breach is compacted in-process and never
 * reaches the user; the marker and the block are reserved for a breach that
 * compaction cannot fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as checkBudgetMain } from '../../scripts/check-session-budget.mjs';
import { main as compactMain } from '../../scripts/compact-session.mjs';
import { measureSession } from '../../lib/context/session-budget.mjs';

/** Silence stdout/stderr during a run and restore after. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
function silence() {
  process.stdout.write = /** @type {typeof process.stdout.write} */ (() => true);
  process.stderr.write = /** @type {typeof process.stderr.write} */ (() => true);
}
function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/**
 * @param {{ budgetClass?: string, sessionBytes?: number, omitTaskId?: boolean }} opts
 * @returns {Promise<{ taskStatePath: string, dir: string, markerPath: string }>}
 */
async function makeSession(opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-'));
  const sessionPath = path.join(dir, 'session.md');
  if (opts.sessionBytes) await fsp.writeFile(sessionPath, 'x'.repeat(opts.sessionBytes));
  /** @type {Record<string, unknown>} */
  const state = {
    taskId: 't-critical',
    lane: 'feature',
    workflowGate: 'impl-started',
    currentStep: 0,
    artifactHashes: {},
    preImplStash: null,
    budget: 10,
    schemaVersion: 1,
    sessionPath,
    loadedSkills: [],
  };
  if (opts.omitTaskId) delete state.taskId;
  if (opts.budgetClass) {
    state.outputContract = { token_budget_class: opts.budgetClass, max_context_sources: 5 };
  }
  const taskStatePath = path.join(dir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  return { taskStatePath, dir, markerPath: path.join(dir, 'budget-critical.json') };
}

/** @param {string} p @returns {Promise<boolean>} */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// #87 — the hook detects the breach and already holds the correct workspace root,
// so it recovers in-process instead of writing an edit-blocking marker and asking
// a human to paste a command into a terminal (whose cwd may resolve a DIFFERENT
// root — which is how a real session ended up compacting a task that wasn't there
// and staying blocked). A reclaimable breach must never reach the user at all.
test('#87 — a critical breach auto-compacts in-process and does not block', async () => {
  // tiny critical = 4000 tokens → 20000 bytes = 5000 tokens.
  const { taskStatePath, dir, markerPath } = await makeSession({ budgetClass: 'tiny', sessionBytes: 20000 });
  silence();
  let code;
  try {
    code = await checkBudgetMain([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }

  assert.equal(code, 0, 'a reclaimable breach self-heals — nothing is blocked');
  assert.equal(
    await exists(markerPath),
    false,
    'no marker: the block is reserved for a breach compaction could not fix',
  );

  // It actually compacted: an artifact exists and the session is back in budget.
  const artifacts = await fsp.readdir(path.join(dir, 'compaction'));
  assert.ok(artifacts.some((f) => f.endsWith('.json')), 'a compaction artifact was written');

  silence();
  let recheck;
  try {
    recheck = await checkBudgetMain([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  assert.equal(recheck, 0, 'and it stays recovered on the next tool call');
});

// The fail-closed stop still exists — it is now reserved for the case where there
// is nothing to reclaim, so compaction cannot help and a human must intervene.
test('#87 — a critical breach that cannot be compacted still blocks', async () => {
  const { taskStatePath, dir, markerPath } = await makeSession({
    budgetClass: 'tiny',
    sessionBytes: 20000,
    omitTaskId: true, // no task → nothing to compact
  });
  silence();
  let code;
  try {
    code = await checkBudgetMain([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }

  assert.equal(code, 2, 'an unrecoverable breach still blocks, fail-closed');
  assert.equal(await exists(markerPath), true, 'marker written when compaction cannot run');
  const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  assert.equal(marker.field, 'session-total');
  assert.equal(marker.current, 5000);
  assert.equal(marker.limit, 4000);
  assert.equal(typeof marker.at, 'string');
});

test('warn does not write marker', async () => {
  // tiny warn band: 12000 bytes = 3000 tokens (2000 <= 3000 < 4000).
  const { taskStatePath, dir, markerPath } = await makeSession({ budgetClass: 'tiny', sessionBytes: 12000 });
  silence();
  let code;
  try {
    code = await checkBudgetMain([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  assert.equal(code, 1);
  assert.equal(await exists(markerPath), false, 'no marker on warn');
});

test('compaction clears the marker', async () => {
  const { taskStatePath, dir, markerPath } = await makeSession({ budgetClass: 'tiny', sessionBytes: 20000 });
  // A marker left behind by an earlier unrecoverable breach (or an older devmate).
  await fsp.writeFile(
    markerPath,
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', field: 'session-total', current: 5000, limit: 4000 }),
    'utf8',
  );
  silence();
  try {
    const code = await compactMain([taskStatePath, path.join(dir, 'compaction')]);
    assert.equal(code, 0, 'compaction succeeds');
  } finally {
    restore();
  }
  assert.equal(await exists(markerPath), false, 'marker cleared after compaction');
});

// #87 — the livelock regression. Clearing the marker is not recovery: the guard
// re-measures the SAME session on the very next PostToolUse. If compaction does
// not reduce what measureSession counts, the marker comes straight back and
// every source edit stays denied forever, with the only advertised remedy a
// no-op. A critical breach must be recoverable BY CONSTRUCTION — so the check
// that matters is not "is the marker gone" but "does the next measurement still
// breach". On the pre-#87 code this fails: compaction left session.md at its
// full size and the re-measure went critical again.
test('#87 — a critical breach is recoverable: compaction drops the measured total below critical', async () => {
  // Drive the manual path (the one a human runs) against a session that is over
  // the critical threshold, and prove the RE-MEASURE comes back under it. On the
  // pre-#87 code this failed: compaction cleared the marker without shrinking
  // session.md, so the next check went critical again and rewrote it. Clearing
  // the marker is not recovery — reducing what is measured is.
  const { taskStatePath, dir, markerPath } = await makeSession({ budgetClass: 'tiny', sessionBytes: 20000 });
  await fsp.writeFile(
    markerPath,
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', field: 'session-total', current: 5000, limit: 4000 }),
    'utf8',
  );

  silence();
  let recheck;
  try {
    const before = await measureSession({ taskStatePath });
    assert.ok(before.totalEstimatedTokens >= 4000, 'precondition: session is over tiny critical');

    await compactMain([taskStatePath, path.join(dir, 'compaction')]);

    // The next PostToolUse. Nothing else changed — only compaction ran.
    recheck = await checkBudgetMain([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }

  assert.notEqual(recheck, 2, 're-measure after compaction must not be critical again');
  assert.equal(
    await exists(markerPath),
    false,
    'marker must not be rewritten — a livelock blocks every source edit with no way out',
  );
});

// #87 — observed in a real session. A hook resolves the workspace root from the
// payload's cwd; a human running compact-session from a terminal resolves it
// from the terminal's cwd. In a multi-root workspace those differ, so the script
// compacted a task.json that was not there: it built an artifact for the sentinel
// id "unknown-task", cleared a marker that did not exist at that path, reported
// "Compaction written" — and left the real marker, and the block, in place. The
// one way out of a critical breach must never silently do nothing.
test('#87 — compaction refuses to run against a missing task, instead of silently doing nothing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-notask-'));
  const taskStatePath = path.join(dir, 'task.json'); // never written

  /** @type {string[]} */
  const errs = [];
  process.stderr.write = /** @type {typeof process.stderr.write} */ (
    (/** @type {string} */ chunk) => {
      errs.push(String(chunk));
      return true;
    }
  );
  process.stdout.write = /** @type {typeof process.stdout.write} */ (() => true);

  let code;
  try {
    code = await compactMain([taskStatePath, path.join(dir, 'compaction')]);
  } finally {
    restore();
  }

  assert.notEqual(code, 0, 'a compaction that compacted nothing must not report success');
  const blob = errs.join('');
  assert.match(blob, /no devmate task/i);
  assert.match(blob, /no budget-critical marker was cleared/i, 'must say plainly that nothing was unblocked');
  assert.match(blob, /\.devmate[/\\]state[/\\]task\.json/, 'must show how to aim it at the right root');

  // And no sentinel artifact is left behind claiming a task that does not exist.
  const artifacts = await fsp.readdir(path.join(dir, 'compaction')).catch(() => []);
  assert.equal(
    artifacts.some((f) => f.includes('unknown-task')),
    false,
    'the unknown-task sentinel is how this bug hid — it must never be written',
  );
});
