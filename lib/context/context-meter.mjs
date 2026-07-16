// @ts-check
/**
 * #87: the in-context token meter — the one quantity the session budget is
 * allowed to meter.
 *
 * ## Why this module exists
 *
 * The session budget used to sum the byte sizes of three files on disk and call
 * the result "context". Two of those files (`.devmate/session.md`, the capped
 * tool-output artifact) have no producer anywhere in the plugin, so they measure
 * 0 forever. The third — the per-task trace JSONL — is an append-only event log
 * that is never injected into the model's prompt. It only grows, so it was the
 * only component with real bytes in it, and it drove every budget warning the
 * plugin has ever emitted. The budget was metering **disk**, and blocking edits
 * over it.
 *
 * A context budget has to meter what actually enters the prompt. On the one
 * surface devmate targets, that quantity is observable exactly once per turn: the
 * VS Code `PostToolUse` payload carries `tool_response`, which is the text the
 * host feeds back to the model. Summing it across the turns of a task is the
 * honest measure of what devmate has put into the window, and — unlike a file on
 * disk — it is a quantity compaction can actually reduce, which is what makes a
 * critical breach recoverable instead of a livelock.
 *
 * Ground truth for the payload shape is a captured fixture, never the docs:
 * test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json.
 *
 * The meter is a sidecar (`.devmate/state/context-meter.json`), not a field in
 * `task.json`: it is written on every single tool call, and it must never
 * contend with the orchestrator's locked TaskState writes for that.
 */
import { dirname, join } from "node:path";
import { readTextFile, renamePath, writeTextFile } from "../fs-safe.mjs";
import { estimateTokens } from "./estimate-tokens.mjs";

/** @typedef {import('../types.mjs').ContextMeter} ContextMeter */

/** Filename of the meter sidecar, written next to `task.json`. */
export const CONTEXT_METER_FILE = "context-meter.json";

/** Schema version of the meter sidecar. */
const SCHEMA_VERSION = 1;

/**
 * Path of the meter sidecar for a given TaskState file.
 * @param {string} taskStatePath
 * @returns {string}
 */
export function contextMeterPath(taskStatePath) {
  return join(dirname(taskStatePath), CONTEXT_METER_FILE);
}

/**
 * A zeroed meter — the value of a task that has put nothing into context yet,
 * and the value compaction resets to. Pure.
 * @returns {ContextMeter}
 */
export function emptyMeter() {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextTokens: 0,
    toolResults: 0,
    lastReportId: null,
  };
}

/**
 * Estimated tokens this tool result puts into the model's context. Pure.
 *
 * `tool_response` is a string on every captured VS Code payload, but it is typed
 * `unknown` here because a hook must never crash on a shape it did not expect —
 * an unmeasurable response counts as 0 rather than throwing inside PostToolUse.
 * @param {unknown} toolResponse  The payload's `tool_response` field.
 * @returns {number}
 */
export function toolResponseTokens(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return 0;
  if (typeof toolResponse === "string") return estimateTokens(toolResponse);
  try {
    const serialized = JSON.stringify(toolResponse);
    return typeof serialized === "string" ? estimateTokens(serialized) : 0;
  } catch {
    // Circular or otherwise unserializable — unmeasurable, not fatal.
    return 0;
  }
}

/**
 * Coerce a persisted field to a non-negative count. A meter that has been
 * hand-edited, truncated, or written by a future schema must degrade to 0
 * rather than poison the budget with a negative or non-numeric total.
 * @param {unknown} value
 * @returns {number}
 */
function asCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Read the meter, or a zeroed one when it is absent/unreadable/malformed. Never
 * throws: this runs inside PostToolUse, where a read error must not take down
 * the tool call.
 * @param {string} taskStatePath
 * @returns {Promise<ContextMeter>}
 */
export async function readContextMeter(taskStatePath) {
  try {
    const parsed = JSON.parse(await readTextFile(contextMeterPath(taskStatePath)));
    if (parsed === null || typeof parsed !== "object") return emptyMeter();
    const raw = /** @type {Record<string, unknown>} */ (parsed);
    const reportId = raw["lastReportId"];
    return {
      schemaVersion: SCHEMA_VERSION,
      contextTokens: asCount(raw["contextTokens"]),
      toolResults: asCount(raw["toolResults"]),
      lastReportId: typeof reportId === "string" ? reportId : null,
    };
  } catch {
    return emptyMeter();
  }
}

/**
 * Write the meter atomically (tmp + rename), so a crashed hook can never leave a
 * half-written meter that reads back as a lower number than the truth.
 * @param {string} taskStatePath
 * @param {ContextMeter} meter
 * @returns {Promise<void>}
 */
async function writeContextMeter(taskStatePath, meter) {
  const target = contextMeterPath(taskStatePath);
  const tmp = `${target}.tmp`;
  await writeTextFile(tmp, JSON.stringify(meter, null, 2));
  await renamePath(tmp, target);
}

/**
 * Add one tool result's context cost to the meter and persist it.
 * @param {string} taskStatePath
 * @param {unknown} toolResponse  The PostToolUse payload's `tool_response`.
 * @returns {Promise<ContextMeter>} The meter after the addition.
 */
export async function recordToolResult(taskStatePath, toolResponse) {
  const meter = await readContextMeter(taskStatePath);
  const added = toolResponseTokens(toolResponse);
  // Nothing entered context, so there is nothing to persist — a hook that runs
  // on every tool call must not churn a file for a no-op.
  if (added < 1) return meter;

  const next = {
    ...meter,
    contextTokens: meter.contextTokens + added,
    toolResults: meter.toolResults + 1,
  };
  await writeContextMeter(taskStatePath, next);
  return next;
}

/**
 * Persist the identity of the budget line just reported, so an unchanged breach
 * is not re-reported on every subsequent tool call (#87 AC5).
 * @param {string} taskStatePath
 * @param {string|null} reportId  Identity from `reportId()`; null when level is ok.
 * @returns {Promise<void>}
 */
export async function rememberReport(taskStatePath, reportId) {
  const meter = await readContextMeter(taskStatePath);
  if (meter.lastReportId === reportId) return;
  await writeContextMeter(taskStatePath, { ...meter, lastReportId: reportId });
}

/**
 * Zero the meter. Called by compaction: the compacted window no longer contains
 * the tool results this counted, so the count must go with them.
 * @param {string} taskStatePath
 * @returns {Promise<void>}
 */
export async function resetContextMeter(taskStatePath) {
  await writeContextMeter(taskStatePath, emptyMeter());
}
