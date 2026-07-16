// @ts-check
// E4-7: high-recall session compaction artifacts (TCM-7). Version B wrote a
// freeform .devmate/agent-state.md blob that was neither typed nor resumable in
// isolation. This module replaces it with a typed CompactionArtifact: a single
// JSON file (plus optional Markdown companion) that a fresh session can load as
// its only source of truth — no conversation history, no trace replay required.
//
// Compaction is high-recall BEFORE precision: we preserve goal, decisions,
// constraints, unresolved bugs, implementation details, evidence pointers,
// risks, and the next action; we drop only duplicate tool output, stale
// messages, and failed branches. buildCompactionArtifact does reads then pure
// logic; only writeCompactionArtifact touches disk (atomically).
//
// Anti-hallucination note: the E4-7 spec referenced a `nextAction` field on
// step_complete trace events and a `decision` trace event type. Neither exists
// in the real codebase (StepCompleteEntry carries `label`; the loop variant
// carries `stepLabel`; there is no `decision` event type). This module reconciles
// to real fields: it reads `nextAction` only if a future event ever supplies it,
// otherwise derives the next action from the last step's label, and sources
// accepted decisions from caller-supplied `additionalDecisions`.
import { join } from "node:path";
import {
  ensureDir,
  listDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from "../fs-safe.mjs";
import { readJsonFile } from "../json-io.mjs";
import { resetContextBudget } from "./session-budget.mjs";

/** @typedef {import('../types.mjs').EvidencePointer} EvidencePointer */
/** @typedef {import('../types.mjs').CompactionArtifact} CompactionArtifact */

/** Schema version for produced artifacts. */
const SCHEMA_VERSION = "1.0";
/** Identifies the producer of an artifact. */
const COMPACTED_BY = "compact-session.mjs@1.0";
/** Fallback next action when the trace yields none. */
const DEFAULT_NEXT_ACTION =
  "Resume from compaction artifact — check nextAction field.";

/**
 * Read and JSON-parse a file, returning a fallback on any error. Never throws.
 * @param {string} filePath
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJsonSafe(filePath, fallback) {
  const parsed = await readJsonFile(filePath);
  return parsed ?? fallback;
}

/**
 * Read a JSONL trace file into parsed event objects, skipping malformed lines.
 * Returns an empty array when the file is absent or unreadable.
 * @param {string} traceFile
 * @returns {Promise<Record<string, any>[]>}
 */
async function readTraceEvents(traceFile) {
  let raw;
  try {
    raw = await readTextFile(traceFile);
  } catch {
    return [];
  }
  /** @type {Record<string, any>[]} */
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev && typeof ev === "object") events.push(ev);
    } catch {
      // skip malformed line — high-recall compaction tolerates partial traces
    }
  }
  return events;
}

/**
 * Discriminate a trace event's kind across both trace schemas (`type` and
 * `event` discriminators both exist in the codebase).
 * @param {Record<string, any>} ev
 * @returns {string|undefined}
 */
function eventKind(ev) {
  return typeof ev.type === "string"
    ? ev.type
    : typeof ev.event === "string"
      ? ev.event
      : undefined;
}

/**
 * Build a CompactionArtifact from TaskState and trace data. Does NOT write disk.
 * @param {{
 *   taskStatePath: string,
 *   traceDir?: string,
 *   traceFile?: string,
 *   additionalDecisions?: string[],
 *   additionalPointers?: EvidencePointer[]
 * }} opts
 * @returns {Promise<CompactionArtifact>}
 */
export async function buildCompactionArtifact(opts) {
  const state = await readJsonSafe(opts.taskStatePath, {});
  const contract =
    (state &&
      typeof state.outputContract === "object" &&
      state.outputContract) ||
    {};

  const taskId =
    typeof state.taskId === "string" ? state.taskId : "unknown-task";
  const goal = typeof contract.done_when === "string" ? contract.done_when : "";

  // Constraints seeded from the contract's required evidence kinds.
  /** @type {string[]} */
  const constraints = Array.isArray(contract.evidence_required)
    ? contract.evidence_required.map(
        (/** @type {unknown} */ e) => `Evidence required: ${String(e)}`,
      )
    : [];

  // Resolve the trace file: explicit traceFile, else <traceDir>/<taskId>.jsonl,
  // else the canonical single-file default.
  const traceFile =
    opts.traceFile ??
    (opts.traceDir
      ? join(opts.traceDir, `${taskId}.jsonl`)
      : ".devmate/state/trace.jsonl");
  const events = await readTraceEvents(traceFile);

  // nextAction: prefer an explicit nextAction field (future-proofing), else the
  // last step_complete's label/stepLabel, else the documented fallback.
  const stepCompletes = events.filter((e) => eventKind(e) === "step_complete");
  let nextAction = DEFAULT_NEXT_ACTION;
  if (stepCompletes.length > 0) {
    const last = stepCompletes[stepCompletes.length - 1];
    if (typeof last.nextAction === "string" && last.nextAction.trim() !== "") {
      nextAction = last.nextAction;
    } else if (typeof last.label === "string" && last.label.trim() !== "") {
      nextAction = `Continue after completed step: ${last.label}`;
    } else if (
      typeof last.stepLabel === "string" &&
      last.stepLabel.trim() !== ""
    ) {
      nextAction = `Continue after completed step: ${last.stepLabel}`;
    }
  }

  // acceptedDecisions: caller-supplied plus any (currently non-existent) decision events.
  /** @type {string[]} */
  const acceptedDecisions = [...(opts.additionalDecisions ?? [])];
  for (const ev of events) {
    if (eventKind(ev) === "decision" && typeof ev.decision === "string") {
      acceptedDecisions.push(ev.decision);
    }
  }

  // unresolvedBugs from loop_halt events; read both lastError and last_error.
  /** @type {string[]} */
  const unresolvedBugs = [];
  let sawHalt = false;
  for (const ev of events) {
    if (eventKind(ev) === "loop_halt") {
      sawHalt = true;
      const err = ev.lastError ?? ev.last_error;
      if (typeof err === "string" && err.trim() !== "") {
        unresolvedBugs.push(`${err} (pointer: ${traceFile} — halt)`);
      } else {
        unresolvedBugs.push(`Loop halted (pointer: ${traceFile} — halt)`);
      }
    }
  }

  // evidencePointers: caller-supplied plus any pointers persisted on TaskState.
  /** @type {EvidencePointer[]} */
  const evidencePointers = [...(opts.additionalPointers ?? [])];
  const packPointers = state?.evidencePack?.pointers;
  if (Array.isArray(packPointers)) {
    for (const p of packPointers) {
      if (p && typeof p === "object" && typeof p.path === "string")
        evidencePointers.push(p);
    }
  }

  // droppedCategories: always duplicate output + stale messages; failed branches only if halts seen.
  const droppedCategories = ["duplicate-tool-output", "stale-messages"];
  if (sawHalt) droppedCategories.push("failed-branches");

  return {
    schemaVersion: SCHEMA_VERSION,
    taskId,
    compactedAt: new Date().toISOString(),
    goal,
    acceptedDecisions,
    constraints,
    unresolvedBugs,
    implementationDetails: [],
    evidencePointers,
    risks: [],
    nextAction,
    compactedBy: COMPACTED_BY,
    droppedCategories,
  };
}

/**
 * Render a CompactionArtifact as a human-readable Markdown companion.
 * @param {CompactionArtifact} a
 * @returns {string}
 */
function renderMarkdown(a) {
  /** @param {string[]} items */
  const list = (items) =>
    items.length === 0 ? "_none_" : items.map((i) => `- ${i}`).join("\n");
  const pointers =
    a.evidencePointers.length === 0
      ? "_none_"
      : a.evidencePointers
          .map(
            (p) =>
              `- ${p.path}${p.lineRange ? `:${p.lineRange[0]}-${p.lineRange[1]}` : ""} — ${p.reason}`,
          )
          .join("\n");

  return [
    `# Compaction Artifact — ${a.taskId}`,
    "",
    `Compacted at ${a.compactedAt} by ${a.compactedBy} (schema ${a.schemaVersion}).`,
    "",
    "## Goal",
    a.goal || "_none_",
    "",
    "## Decisions",
    list(a.acceptedDecisions),
    "",
    "## Constraints",
    list(a.constraints),
    "",
    "## Unresolved Bugs",
    list(a.unresolvedBugs),
    "",
    "## Next Action",
    a.nextAction || "_none_",
    "",
    "## Evidence Pointers",
    pointers,
    "",
    "## Dropped Categories",
    list(a.droppedCategories),
    "",
  ].join("\n");
}

/**
 * Write a CompactionArtifact to disk as JSON plus an optional Markdown companion.
 * Filenames embed a millisecond timestamp so an existing artifact is never
 * overwritten. JSON is written atomically (tmp file + rename).
 * @param {CompactionArtifact} artifact
 * @param {string} outputDir
 * @param {{ writeMarkdown?: boolean }} [opts]
 * @returns {Promise<{ jsonPath: string, mdPath?: string }>}
 */
export async function writeCompactionArtifact(artifact, outputDir, opts = {}) {
  await ensureDir(outputDir);
  const stamp = Date.now();
  const base = `compaction-${artifact.taskId}-${stamp}`;
  const jsonPath = join(outputDir, `${base}.json`);
  const tmpPath = `${jsonPath}.tmp`;

  await writeTextFile(tmpPath, JSON.stringify(artifact, null, 2));
  await renamePath(tmpPath, jsonPath);

  /** @type {{ jsonPath: string, mdPath?: string }} */
  const result = { jsonPath };

  if (opts.writeMarkdown === true) {
    const mdPath = join(outputDir, `${base}.md`);
    const mdTmp = `${mdPath}.tmp`;
    await writeTextFile(mdTmp, renderMarkdown(artifact));
    await renamePath(mdTmp, mdPath);
    result.mdPath = mdPath;
  }

  return result;
}

/**
 * Load the most recent CompactionArtifact from a directory. Sorts the
 * `compaction-*.json` files by their timestamp suffix and returns the newest.
 * Returns null when none exist, none parse, or the schema version is unknown.
 * @param {string} outputDir
 * @returns {Promise<CompactionArtifact|null>}
 */
export async function loadCompactionArtifact(outputDir) {
  let entries;
  try {
    entries = await listDir(outputDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((f) => f.startsWith("compaction-") && f.endsWith(".json"))
    .sort();
  if (candidates.length === 0) return null;

  // Newest is last by sorted filename (timestamp suffix). Walk backward so a
  // corrupt newest file falls through to the next valid one.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const artifact = await readJsonSafe(join(outputDir, candidates[i]), null);
    if (
      artifact &&
      typeof artifact === "object" &&
      typeof artifact.schemaVersion === "string" &&
      artifact.schemaVersion === SCHEMA_VERSION
    ) {
      return /** @type {CompactionArtifact} */ (artifact);
    }
  }
  return null;
}

/**
 * Check whether a CompactionArtifact is self-sufficient for resume: it must have
 * a non-empty goal, a non-empty nextAction, and at least one evidence pointer or
 * accepted decision. This is the quality gate that prevents an unrecoverable
 * compacted session.
 * @param {CompactionArtifact} artifact
 * @returns {{ ok: boolean, missingFields: string[] }}
 */
export function canResumeFromCompaction(artifact) {
  /** @type {string[]} */
  const missingFields = [];
  if (!artifact.goal || artifact.goal.trim() === "") missingFields.push("goal");
  if (!artifact.nextAction || artifact.nextAction.trim() === "")
    missingFields.push("nextAction");
  const hasContext =
    (Array.isArray(artifact.evidencePointers) &&
      artifact.evidencePointers.length > 0) ||
    (Array.isArray(artifact.acceptedDecisions) &&
      artifact.acceptedDecisions.length > 0);
  if (!hasContext) missingFields.push("evidencePointers|acceptedDecisions");

  return { ok: missingFields.length === 0, missingFields };
}

/**
 * #87: compact a session AND reclaim its context budget — the whole recovery, in
 * one call, so that every caller performs all of it.
 *
 * The budget's `critical` level blocks every source edit until the context total
 * comes down. Writing an artifact does not bring it down; only reducing what the
 * budget counts does. Those were two separate steps in one script, which is how
 * they came apart: compaction cleared the edit-blocking marker without shrinking
 * anything, the next tool call re-measured the same session and re-blocked, and
 * the only advertised way out was a no-op.
 *
 * Both callers now go through here — the CLI/PreCompact entrypoint
 * (scripts/compact-session.mjs) and the automatic recovery inside the budget hook
 * (scripts/check-session-budget.mjs) — so a recovery that writes the artifact but
 * forgets to reclaim is not a thing that can be written.
 *
 * @param {{ taskStatePath: string, outputDir: string }} opts
 * @returns {Promise<{ jsonPath: string, resume: { ok: boolean, missingFields: string[] }, reset: import('../types.mjs').ContextBudgetReset }>}
 */
export async function compactAndReclaim(opts) {
  const artifact = await buildCompactionArtifact({ taskStatePath: opts.taskStatePath });
  const { jsonPath } = await writeCompactionArtifact(artifact, opts.outputDir, {
    writeMarkdown: true,
  });

  // The archive is named after the artifact this run just wrote, so each
  // compaction keeps its own copy instead of overwriting the previous one.
  const archivePath = jsonPath.endsWith(".json")
    ? `${jsonPath.slice(0, -".json".length)}-session.md`
    : `${jsonPath}-session.md`;

  const reset = await resetContextBudget({ taskStatePath: opts.taskStatePath, archivePath });

  return { jsonPath, resume: canResumeFromCompaction(artifact), reset };
}
