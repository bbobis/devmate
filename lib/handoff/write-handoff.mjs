// @ts-check

/**
 * E6-3: Write a typed handoff artifact for cold resume.
 *
 * Produces both `handoff.json` (machine-readable) and `handoff.md` (human
 * pointer summary) under `.devmate/state/handoff/<taskId>/`. The markdown brief
 * is self-contained: it carries pointers + metadata only, never raw file
 * content or pasted logs (TCM-3 evidence-as-pointer rule).
 */

import { ensureDir, writeTextFile } from "../fs-safe.mjs";
import path from "node:path";
import { isPlainRecord } from "../object-utils.mjs";

/** @typedef {import('../types.mjs').HandoffArtifact} HandoffArtifact */
/** @typedef {import('../types.mjs').HandoffInput} HandoffInput */
/** @typedef {import('../types.mjs').HandoffEvidencePointer} HandoffEvidencePointer */

/** Base directory (cwd-relative) holding per-task handoff artifacts. */
export const HANDOFF_DIR = ".devmate/state/handoff";

/** The four allowed `currentState` values. */
export const HANDOFF_STATES = [
  "in_progress",
  "halted",
  "compacted",
  "completed",
];

export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * Resolve the directory holding a task's handoff files.
 * @param {string} taskId
 * @param {string} [handoffDir] Base dir (defaults to HANDOFF_DIR).
 * @returns {string}
 */
export function handoffTaskDir(taskId, handoffDir) {
  return path.join(handoffDir ?? HANDOFF_DIR, taskId);
}

/**
 * Validate a HandoffInput. Pure — no I/O.
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateHandoffInput(input) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainRecord(input)) {
    return { ok: false, errors: ["handoff input must be a non-null object"] };
  }
  const i = /** @type {Record<string, unknown>} */ (input);

  if (typeof i.taskId !== "string" || i.taskId.length === 0)
    errors.push("taskId is required");
  if (typeof i.purpose !== "string" || i.purpose.length === 0)
    errors.push("purpose is required");
  if (
    typeof i.currentState !== "string" ||
    !HANDOFF_STATES.includes(i.currentState)
  ) {
    errors.push(`currentState must be one of: ${HANDOFF_STATES.join(", ")}`);
  }
  if (!Array.isArray(i.decisions)) errors.push("decisions must be an array");
  if (!Array.isArray(i.openQuestions))
    errors.push("openQuestions must be an array");
  if (!Array.isArray(i.evidencePointers))
    errors.push("evidencePointers must be an array");
  if (!Array.isArray(i.blockers)) errors.push("blockers must be an array");
  if (
    !(i.suggestedNextSkill === null || typeof i.suggestedNextSkill === "string")
  ) {
    errors.push("suggestedNextSkill must be a string or null");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Render a list section, falling back to "(none)" when empty.
 * @param {string} heading
 * @param {string[]} items
 * @returns {string}
 */
function listSection(heading, items) {
  const body =
    items.length > 0 ? items.map((x) => `- ${x}`).join("\n") : "- (none)";
  return `## ${heading}\n${body}\n`;
}

/**
 * Render one evidence pointer as a single bullet. Files/trace paths use a
 * backtick span; external URLs render as a markdown link. Never raw content.
 * @param {HandoffEvidencePointer} ep
 * @returns {string}
 */
function renderEvidence(ep) {
  const range = ep.line_range ? ` (lines ${ep.line_range})` : "";
  const ref =
    ep.kind === "url"
      ? `[${ep.path_or_url}](${ep.path_or_url})`
      : `\`${ep.path_or_url}\`${range}`;
  return `- ${ref} — ${ep.why_relevant} [confidence: ${ep.confidence}]`;
}

/**
 * Render the full markdown brief.
 * @param {HandoffArtifact} a
 * @returns {string}
 */
export function renderHandoffMd(a) {
  const evidence =
    a.evidencePointers.length > 0
      ? a.evidencePointers.map(renderEvidence).join("\n")
      : "- (none)";
  return [
    `# Handoff: ${a.taskId}`,
    "",
    `## Purpose\n${a.purpose}\n`,
    `## Current State\n${a.currentState}\n`,
    listSection("Decisions", a.decisions),
    listSection("Open Questions", a.openQuestions),
    `## Evidence Pointers\n${evidence}\n`,
    `## Suggested Next Skill\n${a.suggestedNextSkill ?? "(none)"}\n`,
    listSection("Blockers", a.blockers),
    `_Generated ${a.ts} (schemaVersion ${a.schemaVersion})._`,
    "",
  ].join("\n");
}

/**
 * Write a handoff artifact (json + md) for a task.
 *
 * `opts.handoffDir` is REQUIRED and must be an absolute, root-anchored dir
 * (e.g. resolve(root, HANDOFF_DIR)). The old cwd-relative default is the same
 * silent-wrong-write class as the trace root: run with cwd inside the
 * workspace's .devmate/ folder, the artifact landed under
 * .devmate/.devmate/state/handoff/ where no reader looks (#76). Reads keep a
 * lenient default (a miss degrades to "no handoff"); the WRITER must not.
 * @param {HandoffInput} input
 * @param {{ handoffDir: string }} opts
 * @returns {Promise<{ jsonPath: string, mdPath: string }>}
 */
export async function writeHandoff(input, opts) {
  if (typeof opts?.handoffDir !== 'string' || opts.handoffDir === '') {
    throw new Error('writeHandoff requires opts.handoffDir (anchor it on the resolved workspace root)');
  }
  const { ok, errors } = validateHandoffInput(input);
  if (!ok) {
    throw new Error(`invalid handoff input: ${errors.join("; ")}`);
  }

  /** @type {HandoffArtifact} */
  const artifact = {
    ...input,
    ts: new Date().toISOString(),
    schemaVersion: HANDOFF_SCHEMA_VERSION,
  };

  const dir = handoffTaskDir(input.taskId, opts.handoffDir);
  await ensureDir(dir);

  const jsonPath = path.join(dir, "handoff.json");
  const mdPath = path.join(dir, "handoff.md");

  await writeTextFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  await writeTextFile(mdPath, renderHandoffMd(artifact));

  return { jsonPath, mdPath };
}
