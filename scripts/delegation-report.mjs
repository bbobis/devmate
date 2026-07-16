// @ts-check
/**
 * delegation-report — show, from a task's trace, how much of the work was
 * delegated to subagents versus likely done inline (the context-degradation
 * risk). Read-only observability; it never gates anything by default.
 *
 * Usage:
 *   node scripts/delegation-report.mjs --trace <path.jsonl> [--lane <feature|bug|chore>] [--json] [--strict]
 *   node scripts/delegation-report.mjs --task <taskId> [--root <dir>] [--json] [--strict]
 *   node scripts/delegation-report.mjs --all [--root <dir>] [--json] [--strict]
 *
 * With --task the trace path (.devmate/state/trace/<taskId>.jsonl) and the lane
 * (from task.json) are resolved automatically under --root (default cwd). --all
 * scans every trace under <root>/.devmate/state/trace and prints a fleet-wide
 * dashboard. The lane makes single-task scoring precise: a chore has no analysis
 * phase, so it is not flagged for "missing" discovery/grill.
 *
 * Exit: 0 on success; 2 on a usage error. By default the report is pure
 * observability (exit 0 regardless of verdict); pass --strict to exit 1 when any
 * reported task is RED, so a downstream CI can fail a run that did work inline.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { listDir, readTextFileSync } from '../lib/fs-safe.mjs';
import { parseJsonl } from '../lib/json-io.mjs';
import { readTaskState } from '../lib/task-state.mjs';
import {
  summarizeDelegation,
  formatDelegationReport,
  formatDelegationDashboard,
} from '../lib/orchestrator/delegation-report.mjs';

/** Safe task-id shape (mirrors the ledger-filename rule): no path traversal. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Trace directory, relative to a repo root. */
const TRACE_DIR = '.devmate/state/trace';

/**
 * @param {string[]} args
 * @returns {{ trace: string|undefined, task: string|undefined, root: string|undefined, lane: string|undefined, json: boolean, strict: boolean, all: boolean }}
 */
function parseArgs(args) {
  let trace;
  let task;
  let root;
  let lane;
  let json = false;
  let strict = false;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--trace' && i + 1 < args.length) {
      trace = args.at(i + 1);
      i += 1;
    } else if (a === '--task' && i + 1 < args.length) {
      task = args.at(i + 1);
      i += 1;
    } else if (a === '--root' && i + 1 < args.length) {
      root = args.at(i + 1);
      i += 1;
    } else if (a === '--lane' && i + 1 < args.length) {
      lane = args.at(i + 1);
      i += 1;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--strict') {
      strict = true;
    } else if (a === '--all') {
      all = true;
    }
  }
  return { trace, task, root, lane, json, strict, all };
}

/**
 * @param {string|undefined} p
 * @returns {boolean}
 */
function isSafePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0');
}

/**
 * Read + parse a JSONL trace file, tolerating a missing/unreadable file.
 * @param {string} path
 * @returns {unknown[]}
 */
function readTrace(path) {
  try {
    return parseJsonl(readTextFileSync(path));
  } catch {
    return [];
  }
}

/**
 * Fleet-wide mode: summarize every task trace under the root's trace dir.
 * @param {string} baseRoot
 * @param {boolean} json
 * @param {boolean} strict
 * @returns {Promise<number>}
 */
async function runAll(baseRoot, json, strict) {
  const dir = join(baseRoot, TRACE_DIR);
  /** @type {string[]} */
  let files = [];
  try {
    files = (await listDir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  files.sort();

  /** @type {Array<{ taskId: string, summary: ReturnType<typeof summarizeDelegation> }>} */
  const entries = [];
  for (const file of files) {
    const taskId = file.slice(0, -'.jsonl'.length);
    entries.push({ taskId, summary: summarizeDelegation(readTrace(join(dir, file))) });
  }

  const out = json
    ? JSON.stringify(entries.map((e) => ({ taskId: e.taskId, ...e.summary })))
    : formatDelegationDashboard(entries);
  process.stdout.write(out + '\n');

  const anyRed = entries.some((e) => e.summary.verdict === 'red');
  return strict && anyRed ? 1 : 0;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const { trace, task, root, lane, json, strict, all } = parseArgs(args);
  const baseRoot = isSafePath(root) ? /** @type {string} */ (root) : '.';

  if (all) {
    return runAll(baseRoot, json, strict);
  }

  // Resolve the trace path: explicit --trace wins, else derive it from --task.
  let tracePath = isSafePath(trace) ? /** @type {string} */ (trace) : undefined;
  if (tracePath === undefined) {
    if (typeof task === 'string' && TASK_ID_RE.test(task)) {
      tracePath = join(baseRoot, TRACE_DIR, `${task}.jsonl`);
    } else {
      process.stdout.write(
        JSON.stringify({ ok: false, error: 'provide --trace PATH, --task TASKID, or --all' }) + '\n',
      );
      return 2;
    }
  }

  // Resolve the lane: explicit --lane wins; in --task mode, fall back to the
  // lane persisted in task.json (best-effort). In --trace mode we never guess.
  let resolvedLane = typeof lane === 'string' && lane.trim() !== '' ? lane : undefined;
  if (resolvedLane === undefined && typeof task === 'string' && TASK_ID_RE.test(task)) {
    const stateResult = readTaskState(join(baseRoot, '.devmate/state/task.json'));
    if (stateResult.ok) resolvedLane = stateResult.state.lane;
  }

  const summary = summarizeDelegation(readTrace(tracePath), { lane: resolvedLane });
  process.stdout.write(
    (json ? JSON.stringify(summary) : formatDelegationReport(summary)) + '\n',
  );
  return strict && summary.verdict === 'red' ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
