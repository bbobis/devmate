// @ts-check
/**
 * E9-07: check-session-budget consumes the persisted budget class and emits
 * budget_warning trace events on warn/critical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/check-session-budget.mjs';
import { parseJsonl } from '../../lib/json-io.mjs';

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
  // #77: a non-zero exit means the host reads stderr, not stdout — so the
  // suite has to read it too.
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
 * Build a task.json plus component files sized to hit a target token level.
 * @param {{ budgetClass?: string, sessionBytes?: number, taskId?: string }} opts
 * @returns {Promise<{ taskStatePath: string, dir: string }>}
 */
async function makeSession(opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'csb-emit-'));
  const sessionPath = path.join(dir, 'session.md');
  if (opts.sessionBytes) await fsp.writeFile(sessionPath, 'x'.repeat(opts.sessionBytes));

  /** @type {Record<string, unknown>} */
  const state = { sessionPath, loadedSkills: [], taskId: opts.taskId ?? 't-budget' };
  if (opts.budgetClass) {
    state.outputContract = { token_budget_class: opts.budgetClass, max_context_sources: 5 };
  }
  const taskStatePath = path.join(dir, 'task.json');
  await fsp.writeFile(taskStatePath, JSON.stringify(state), 'utf8');
  return { taskStatePath, dir };
}

/**
 * Read appended trace events for a task under a trace root.
 * @param {string} root
 * @param {string} taskId
 * @returns {Promise<any[]>}
 */
async function readTrace(root, taskId) {
  const file = path.join(root, '.devmate', 'state', 'trace', `${taskId}.jsonl`);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return parseJsonl(raw);
  } catch {
    return [];
  }
}

test('consumes tiny class thresholds when contract is tiny', async () => {
  // 12000 bytes = 3000 tokens: within standard warn (8000) but in the tiny
  // warn band (2000 <= 3000 < 4000) — proving the persisted class is consumed.
  const { taskStatePath, dir } = await makeSession({ budgetClass: 'tiny', sessionBytes: 12000 });
  capture();
  let code;
  try {
    code = await main([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  assert.equal(code, 1, 'tiny thresholds must trigger warn where standard would be ok');
  assert.match([...outWrites, ...errWrites].join(''), /\[BUDGET:warn\]/);
});

test('appends budget_warning on warn', async () => {
  const { taskStatePath, dir } = await makeSession({ budgetClass: 'tiny', sessionBytes: 12000, taskId: 't-warn' });
  capture();
  try {
    await main([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  const events = await readTrace(dir, 't-warn');
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'budget_warning');
  assert.equal(ev.field, 'session-total');
  assert.equal(ev.current, 3000);
  assert.equal(ev.limit, 2000, 'warn limit is the tiny warn threshold');
  assert.equal(ev.taskId, 't-warn');
});

test('appends budget_warning with critical limit on critical', async () => {
  // 20000 bytes = 5000 tokens >= tiny critical (4000).
  const { taskStatePath, dir } = await makeSession({ budgetClass: 'tiny', sessionBytes: 20000, taskId: 't-crit' });
  capture();
  let code;
  try {
    code = await main([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  // #87: the breach is still traced — it happened, and it stays observable. But
  // it no longer BLOCKS: the hook compacts in-process and the session recovers,
  // so the tool call proceeds. Exit 2 is now reserved for a breach that even a
  // full reclaim could not bring back under the threshold.
  assert.equal(code, 0, 'a reclaimable breach self-heals instead of blocking');
  const events = await readTrace(dir, 't-crit');
  assert.equal(events.length, 1);
  assert.equal(events[0].limit, 4000, 'critical limit is the tiny critical threshold');
  assert.equal(events[0].current, 5000);
});

test('emits unclassified diagnostic when no contract', async () => {
  const { taskStatePath, dir } = await makeSession({ sessionBytes: 100 });
  capture();
  let code;
  try {
    code = await main([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  assert.equal(code, 0);
  const out = [...outWrites, ...errWrites].join('');
  assert.match(out, /\[BUDGET:unclassified\]/, 'unclassified session must be observable');
  assert.match(out, /\[BUDGET:ok\]/, 'status line still printed');
});

test('still prints ok status within budget', async () => {
  const { taskStatePath, dir } = await makeSession({ budgetClass: 'standard', sessionBytes: 100, taskId: 't-ok' });
  capture();
  let code;
  try {
    code = await main([taskStatePath], { traceRoot: dir });
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.match([...outWrites, ...errWrites].join(''), /\[BUDGET:ok\]/);
  const events = await readTrace(dir, 't-ok');
  assert.equal(events.length, 0, 'no budget_warning within budget');
});
