// @ts-check
/**
 * fanout-report — show, from a task's trace joined with the worker-telemetry
 * ledger, how much parallelism a fan-out run actually achieved (max overlap,
 * speedup vs serial-equivalent), scan-phase health, merge quality, and token
 * cost. Read-only observability; it never gates anything (FO-8). This is the
 * data source for the concurrency-ceiling calibration procedure in
 * docs/parallel-dispatch.md ("Calibrating the ceilings").
 *
 * Usage:
 *   node scripts/fanout-report.mjs --trace <path.jsonl> [--telemetry <path.jsonl>] [--json]
 *   node scripts/fanout-report.mjs --task <taskId> [--root <dir>] [--telemetry <path.jsonl>] [--json]
 *   node scripts/fanout-report.mjs --all [--root <dir>] [--telemetry <path.jsonl>] [--json]
 *
 * With --task the trace path (.devmate/state/trace/<taskId>.jsonl) is resolved
 * under --root (default cwd). --all scans every task trace under the root and
 * prints a fleet dashboard + verdict tally. --telemetry defaults to the repo
 * ledger (evals/telemetry/workers.jsonl). Malformed JSONL lines are skipped
 * and counted, never a crash — the same stance as the other trace readers.
 *
 * Exit: 0 on success (pure observability — the verdict never fails the run);
 * 2 on a usage error. There is deliberately no --strict / RED-fails mode.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from '../lib/env-guard.mjs';
import { listDir, readTextFileSync } from '../lib/fs-safe.mjs';
import { DEFAULT_TELEMETRY_PATH } from '../lib/orchestrator/telemetry.mjs';
import {
  buildFanoutReport,
  formatFanoutReport,
  formatFanoutDashboard,
} from '../lib/orchestrator/fanout-report.mjs';

/** Safe task-id shape (mirrors delegation-report's rule): no path traversal. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Trace directory, relative to a repo root. */
const TRACE_DIR = '.devmate/state/trace';

/**
 * @param {string[]} args
 * @returns {{ trace: string|undefined, task: string|undefined, root: string|undefined, telemetry: string|undefined, json: boolean, all: boolean }}
 */
function parseArgs(args) {
  let trace;
  let task;
  let root;
  let telemetry;
  let json = false;
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
    } else if (a === '--telemetry' && i + 1 < args.length) {
      telemetry = args.at(i + 1);
      i += 1;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--all') {
      all = true;
    }
  }
  return { trace, task, root, telemetry, json, all };
}

/**
 * @param {string|undefined} p
 * @returns {boolean}
 */
function isSafePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0');
}

/**
 * Read + parse a JSONL file leniently: a missing/unreadable file is an empty
 * list; a malformed line is skipped and counted, never a crash.
 * @param {string} path
 * @returns {{ rows: unknown[], malformed: number }}
 */
function readJsonlLenient(path) {
  /** @type {string} */
  let text;
  try {
    text = readTextFileSync(path);
  } catch {
    return { rows: [], malformed: 0 };
  }
  /** @type {unknown[]} */
  const rows = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      // @trusted-local-json — repo-local JSONL ledger/trace authored by this tool.
      rows.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

/**
 * Fleet-wide mode: report every task trace under the root's trace dir.
 * @param {string} baseRoot
 * @param {string} telemetryPath
 * @param {boolean} json
 * @returns {Promise<number>}
 */
async function runAll(baseRoot, telemetryPath, json) {
  const dir = join(baseRoot, TRACE_DIR);
  /** @type {string[]} */
  let files = [];
  try {
    files = (await listDir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  files.sort();

  const telemetry = readJsonlLenient(telemetryPath);

  /** @type {Array<{ taskId: string, report: import('../lib/types.mjs').FanoutReport, malformedTraceLines: number }>} */
  const entries = [];
  for (const file of files) {
    const taskId = file.slice(0, -'.jsonl'.length);
    const trace = readJsonlLenient(join(dir, file));
    entries.push({
      taskId,
      report: buildFanoutReport({
        traceEvents: trace.rows,
        telemetryEntries: telemetry.rows,
      }),
      malformedTraceLines: trace.malformed,
    });
  }

  const out = json
    ? JSON.stringify(
        entries.map((e) => ({
          taskId: e.taskId,
          ...e.report,
          malformedTraceLines: e.malformedTraceLines,
          malformedTelemetryLines: telemetry.malformed,
        })),
      )
    : formatFanoutDashboard(entries.map(({ taskId, report }) => ({ taskId, report })));
  process.stdout.write(out + '\n');
  return 0;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function main(args) {
  const { trace, task, root, telemetry, json, all } = parseArgs(args);
  const baseRoot = isSafePath(root) ? /** @type {string} */ (root) : '.';
  const telemetryPath = isSafePath(telemetry)
    ? /** @type {string} */ (telemetry)
    : DEFAULT_TELEMETRY_PATH;

  if (all) {
    return runAll(baseRoot, telemetryPath, json);
  }

  // Resolve the trace path: explicit --trace wins, else derive it from --task.
  let tracePath = isSafePath(trace) ? /** @type {string} */ (trace) : undefined;
  let taskId = undefined;
  if (typeof task === 'string' && TASK_ID_RE.test(task)) taskId = task;
  if (tracePath === undefined) {
    if (taskId !== undefined) {
      tracePath = join(baseRoot, TRACE_DIR, `${taskId}.jsonl`);
    } else {
      process.stdout.write(
        JSON.stringify({ ok: false, error: 'provide --trace PATH, --task TASKID, or --all' }) +
          '\n',
      );
      return 2;
    }
  }

  const traceRead = readJsonlLenient(tracePath);
  const telemetryRead = readJsonlLenient(telemetryPath);
  const report = buildFanoutReport({
    traceEvents: traceRead.rows,
    telemetryEntries: telemetryRead.rows,
  });

  if (json) {
    const payload = JSON.stringify({
      ...(taskId !== undefined ? { taskId } : {}),
      ...report,
      malformedTraceLines: traceRead.malformed,
      malformedTelemetryLines: telemetryRead.malformed,
    });
    process.stdout.write(payload + '\n');
    return 0;
  }

  let out = formatFanoutReport(report, taskId);
  if (traceRead.malformed > 0 || telemetryRead.malformed > 0) {
    out +=
      `\n  (skipped ${traceRead.malformed} malformed trace line(s), ` +
      `${telemetryRead.malformed} malformed telemetry line(s))`;
  }
  process.stdout.write(out + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
