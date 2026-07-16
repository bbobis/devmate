// @ts-check

/**
 * E6-2: Canonical trace reader with stable `stepId`-based resume semantics.
 *
 * Reads `.devmate/state/trace/<taskId>.jsonl`, de-duplicates by stable `stepId`
 * (never label-only), reports malformed line counts + 1-based line numbers, and
 * returns a structured `ResumeSummary` describing where to resume.
 *
 * This is the single canonical reader — no other caller should parse trace
 * JSONL directly.
 */

import { openReadStream } from "../fs-safe.mjs";
import path from "node:path";
import { createInterface } from "node:readline";
import { TRACE_DIR } from "./append.mjs";
import { validateTraceEvent } from "./schema.mjs";

/** @typedef {import('../types.mjs').TraceEvent} TraceEvent */
/** @typedef {import('../types.mjs').TraceEventType} TraceEventType */
/** @typedef {import('../types.mjs').TraceStep} TraceStep */
/** @typedef {import('../types.mjs').ResumeSummary} ResumeSummary */
/** @typedef {import('../types.mjs').ReadTraceResult} ReadTraceResult */

/**
 * Resolve the trace file path for a task.
 * @param {string} taskId
 * @param {string} [traceDir] Directory holding trace files (defaults to TRACE_DIR).
 * @returns {string}
 */
function resolveTracePath(taskId, traceDir) {
  return path.join(traceDir ?? TRACE_DIR, `${taskId}.jsonl`);
}

/**
 * Derive a human label for an event. `step_complete` carries `label`; other
 * events fall back to their type so a step is never label-empty.
 * @param {TraceEvent} ev
 * @returns {string}
 */
function deriveLabel(ev) {
  if (
    ev.type === "step_complete" &&
    typeof (/** @type {any} */ (ev).label) === "string"
  ) {
    return /** @type {any} */ (ev).label;
  }
  return ev.type;
}

/**
 * Read all valid + malformed lines from a trace file.
 * Returns events in file order (each tagged with its 1-based line number).
 * @param {string} filePath
 * @returns {Promise<{ events: Array<{ ev: TraceEvent, line: number }>, malformedLines: number[], totalLines: number }>}
 */
async function readLines(filePath) {
  /** @type {Array<{ ev: TraceEvent, line: number }>} */
  const events = [];
  /** @type {number[]} */
  const malformedLines = [];
  let totalLines = 0;

  /** @type {import('node:fs').ReadStream} */
  let stream;
  try {
    // openReadStream yields a byte stream; readline decodes chunks as utf8 by
    // default, so line content is identical to the previous utf8-encoded stream.
    stream = openReadStream(filePath);
  } catch {
    return { events, malformedLines, totalLines };
  }

  // Surface ENOENT (missing file) as an empty trace rather than a throw.
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    stream.on("error", (/** @type {any} */ err) => {
      if (err && err.code === "ENOENT") resolve();
      else reject(err);
    });
    stream.on("open", () => resolve());
  });
  await ready;

  if (stream.destroyed || stream.errored) {
    return { events, malformedLines, totalLines };
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    if (rawLine.trim().length === 0) continue; // skip blank lines (not counted)
    totalLines += 1;
    const lineNo = totalLines;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      malformedLines.push(lineNo);
      continue;
    }
    const { ok } = validateTraceEvent(parsed);
    if (!ok) {
      malformedLines.push(lineNo);
      continue;
    }
    events.push({ ev: /** @type {TraceEvent} */ (parsed), line: lineNo });
  }

  return { events, malformedLines, totalLines };
}

/**
 * Read a task's trace and produce resume semantics.
 * @param {string} taskId
 * @param {{ traceDir?: string }} [opts]
 * @returns {Promise<ReadTraceResult>}
 */
export async function readTrace(taskId, opts = {}) {
  const filePath = resolveTracePath(taskId, opts.traceDir);
  const { events, malformedLines, totalLines } = await readLines(filePath);

  // Group valid events by stepId, preserving file order within each group.
  /** @type {Map<string, Array<{ ev: TraceEvent, line: number }>>} */
  const byStep = new Map();
  /** @type {string[]} */
  const stepOrder = []; // first-seen order of stepIds
  for (const item of events) {
    const id = item.ev.stepId;
    if (!byStep.has(id)) {
      byStep.set(id, []);
      stepOrder.push(id);
    }
    /** @type {Array<{ ev: TraceEvent, line: number }>} */ (
      byStep.get(id)
    ).push(item);
  }

  /** @type {TraceStep[]} */
  const steps = [];
  for (const id of stepOrder) {
    const group = /** @type {Array<{ ev: TraceEvent, line: number }>} */ (
      byStep.get(id)
    );
    const last = group[group.length - 1];

    const completed = group.some((g) => g.ev.type === "step_complete");
    // halted = a loop_halt exists with no later step_complete in the same group.
    const lastHaltIdx = group.map((g) => g.ev.type).lastIndexOf("loop_halt");
    const lastCompleteIdx = group
      .map((g) => g.ev.type)
      .lastIndexOf("step_complete");
    const halted = lastHaltIdx !== -1 && lastHaltIdx > lastCompleteIdx;

    // label: prefer a step_complete label, else the last event's derived label.
    const completeEvent = [...group]
      .reverse()
      .find((g) => g.ev.type === "step_complete");
    const label = completeEvent
      ? deriveLabel(completeEvent.ev)
      : deriveLabel(last.ev);

    steps.push({
      stepId: id,
      label,
      lastEventType: last.ev.type,
      ts: last.ev.ts,
      completed,
      halted,
    });
  }

  // lastCompleted = most recent completed step by ts (ties broken by file order).
  /** @type {TraceStep|null} */
  let lastCompleted = null;
  for (const s of steps) {
    if (!s.completed) continue;
    if (lastCompleted === null || s.ts >= lastCompleted.ts) lastCompleted = s;
  }

  // currentBlocked = most recent halted-and-not-completed step by ts.
  /** @type {TraceStep|null} */
  let currentBlocked = null;
  for (const s of steps) {
    if (!s.halted || s.completed) continue;
    if (currentBlocked === null || s.ts >= currentBlocked.ts)
      currentBlocked = s;
  }

  /** @type {string|null} */
  let nextLegalAction;
  if (currentBlocked) {
    nextLegalAction = `resolve halt for stepId ${currentBlocked.stepId} (label: ${currentBlocked.label})`;
  } else if (steps.length === 0) {
    nextLegalAction = "start first step";
  } else if (lastCompleted === null) {
    // Steps exist but none completed and none blocked (e.g. only compaction/action).
    nextLegalAction = "start first step";
  } else {
    // At least one completed step, nothing blocked → task may be complete.
    nextLegalAction = null;
  }

  /** @type {ResumeSummary} */
  const summary = {
    lastCompleted,
    currentBlocked,
    nextLegalAction,
    malformedCount: malformedLines.length,
    malformedLines,
  };

  return { steps, summary, totalLines };
}
