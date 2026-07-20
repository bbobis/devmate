// @ts-check
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensureDirSync, writeTextFileSync } from "./fs-safe.mjs";
import { getOwn } from "./object-utils.mjs";
import { mutateTaskStateUnderLock, STATE_PATH, STATE_FILE_NOT_FOUND_PREFIX } from "./task-state.mjs";

/** @typedef {import('./types.mjs').TaskState} TaskState */

/**
 * @typedef {Object} TddScenario
 * @property {string} id           Unique scenario ID (for example "TC-001").
 * @property {string} description  One-line human description of this scenario.
 * @property {1|2|3}  tier         Test tier signal (1=unit, 2=integration, 3=e2e).
 * @property {string} testFile     Repo-relative path to the test file.
 * @property {string} runCommand   Human instruction for running the test.
 */

/**
 * @typedef {Object} FileChange
 * @property {string}  path     Relative file path.
 * @property {string}  reason   Why this file is affected.
 * @property {boolean} [isNew]  True if this file does not yet exist.
 */

/**
 * @typedef {Object} SpecContent
 * @property {string}      title               Task title.
 * @property {string}      summary             One-paragraph plain-language summary.
 * @property {string}      currentBehavior     Current codebase behavior with file citations.
 * @property {string}      gap                 What is missing or broken.
 * @property {string[]}    edgeCases           Edge cases surfaced during grill.
 * @property {string[]}    assumptions         Unconfirmed assumptions for human review (checkbox list).
 * @property {FileChange[]} files              Files that will change.
 * @property {string[]}    acceptanceCriteria  Observable, testable ACs (checkbox list).
 * @property {TddScenario[]} testPlan          Declared test scenarios with files and run commands.
 * @property {string[]}    risks               Known risks.
 * @property {string[]}    outOfScope          Explicit exclusions.
 */

/**
 * @typedef {Object} SpecWriteResult
 * @property {string} specPath    Absolute path to the written spec.md.
 * @property {string} specDigest  SHA-256 hex digest of the file content.
 */

/** @type {ReadonlyArray<keyof SpecContent>} */
const REQUIRED_FIELDS = [
  "title",
  "summary",
  "currentBehavior",
  "gap",
  "edgeCases",
  "assumptions",
  "files",
  "acceptanceCriteria",
  "testPlan",
  "risks",
  "outOfScope",
];

/**
 * A typed error thrown when a required SpecContent field is missing or invalid.
 */
export class SpecWriteError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SpecWriteError";
  }
}

/**
 * Validate that all required fields are present and non-null in SpecContent.
 * @param {SpecContent} content
 * @returns {void}  Throws SpecWriteError on the first missing field.
 */
function validateContent(content) {
  for (const field of REQUIRED_FIELDS) {
    const value = getOwn(content, field);
    if (value == null) {
      throw new SpecWriteError(
        `Required SpecContent field is missing: "${field}"`,
      );
    }
  }

  if (!Array.isArray(content.testPlan) || content.testPlan.length === 0) {
    throw new SpecWriteError(
      'Required SpecContent field is missing or empty: "testPlan"',
    );
  }
}

/**
 * Escape markdown table cell content.
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return value.replace(/\|/g, '\\|');
}

/**
 * Build the markdown string for spec.md from a validated SpecContent.
 * @param {SpecContent} content
 * @returns {string}
 */
function buildMarkdown(content) {
  const edgeCasesLines = content.edgeCases.map((e) => `- ${e}`).join("\n");
  const assumptionsLines = content.assumptions
    .map((a) => `- [ ] ${a}`)
    .join("\n");
  const filesLines = content.files
    .map((f) => `- \`${f.path}\`${f.isNew ? " (new)" : ""} \u2014 ${f.reason}`)
    .join("\n");
  const acLines = content.acceptanceCriteria
    .map((ac, i) => `- [ ] AC${i + 1}: ${ac}`)
    .join("\n");
  const testPlanHeader = "| ID | Description | Tier | Test file | How to run |";
  const testPlanDivider = "| --- | --- | --- | --- | --- |";
  const testPlanRows = content.testPlan.map(
    (scenario) =>
      `| ${escapeCell(scenario.id)} | ${escapeCell(scenario.description)} | ${String(scenario.tier)} | ${escapeCell(scenario.testFile)} | ${escapeCell(scenario.runCommand)} |`,
  );
  const risksLines = content.risks.map((r) => `- ${r}`).join("\n");
  const outOfScopeLines = content.outOfScope.map((o) => `- ${o}`).join("\n");

  return [
    `# Spec: ${content.title}`,
    "",
    "## What we're building",
    "",
    content.summary,
    "",
    "## Why (from discovery)",
    `Current behavior: ${content.currentBehavior}`,
    `Gap: ${content.gap}`,
    "",
    "## Edge cases surfaced during grill",
    edgeCasesLines,
    "",
    "## Assumptions \u2014 please verify",
    assumptionsLines,
    "",
    "## Files that will change",
    filesLines,
    "",
    "## Acceptance criteria",
    acLines,
    "",
    "## Test plan",
    testPlanHeader,
    testPlanDivider,
    ...testPlanRows,
    "",
    "## Risks",
    risksLines,
    "",
    "## Out of scope",
    outOfScopeLines,
    "",
  ].join("\n");
}

/**
 * Produces spec.md at .devmate/session/spec.md, computes SHA-256 digest,
 * and records the path and digest in task.json under artifacts.spec
 * and artifacts.specDigest.
 * @param {string} repoRoot  Absolute path to the repo root.
 * @param {SpecContent} content  Structured spec data collected from orchestrator stages.
 * @returns {Promise<SpecWriteResult>}
 */
export async function writeSpec(repoRoot, content) {
  validateContent(content);

  const sessionDir = join(repoRoot, ".devmate", "session");
  ensureDirSync(sessionDir);

  const specPath = join(sessionDir, "spec.md");
  const markdown = buildMarkdown(content);

  writeTextFileSync(specPath, markdown);

  const specDigest = createHash("sha256")
    .update(markdown, "utf8")
    .digest("hex");

  // Record path and digest in task.json under artifacts.spec / artifacts.specDigest.
  // #112: atomic read-modify-write — a concurrent gate advance cannot clobber the
  // spec hash (and vice versa). A missing task.json is a non-throwing no-op.
  const statePath = join(repoRoot, STATE_PATH);
  const outcome = await mutateTaskStateUnderLock(
    (state) =>
      /** @type {TaskState} */ ({
        ...state,
        artifactHashes: {
          ...state.artifactHashes,
          spec: specPath,
          specDigest,
        },
      }),
    statePath,
    { event: "spec-write" },
  );
  // A genuinely-absent task.json is a no-op (no task yet), same as before. Every
  // other failure — corrupt state, lock failure, an invalid write — used to
  // reject via writeTaskState and must still surface, not be silently dropped.
  if (!outcome.ok && !outcome.error.startsWith(STATE_FILE_NOT_FOUND_PREFIX)) {
    throw new Error(`spec-writer: cannot record spec metadata: ${outcome.error}`);
  }

  return { specPath, specDigest };
}
