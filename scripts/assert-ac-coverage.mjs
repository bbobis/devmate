// @ts-check
// Deterministic AC coverage read (AC-1 of the deterministic AC coverage
// harness, epic #416). Reads the active task's spec.md + trace and asks
// "which approved ACs have no recorded completion?" without trusting any
// agent-reported claim — only a real `impl-AC{n}` step_complete trace event
// counts. Writes a result file plus a single JSON stdout line; exits 0 when
// fully covered, 1 when ACs are missing.
//
// Fail-closed: in the feature lane, zero parsed ACs is treated as coverage
// failure (a malformed `## Acceptance criteria` heading must not vacuously
// pass — see docs/research/deterministic-ac-harness.md). No enforcement
// wiring here — that is AC-2.
//
// Never pastes file contents — pointers only (TCM-3/-4).
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion } from "../lib/env-guard.mjs";
import { pathExists, readTextFileSync } from "../lib/fs-safe.mjs";
import { TRACE_DIR } from "../lib/trace/append.mjs";
import { readTrace } from "../lib/trace/read-trace.mjs";
import {
  completedAcNumbers,
  computeAcCoverage,
  parseAcceptanceCriteria,
} from "../lib/spec-progress.mjs";
import { readTaskState, STATE_PATH } from "../lib/task-state.mjs";
import { writeResult } from "../lib/output/write-result.mjs";

/** Spec artifact path, relative to the repo root. */
const SPEC_REL_PATH = ".devmate/session/spec.md";

/** Result-file path, relative to the repo root. */
const RESULT_REL_PATH = ".devmate/state/assert-ac-coverage-result.json";

/** Error message for the feature-lane zero-AC fail-closed case. */
const ZERO_AC_ERROR =
  "no acceptance criteria parsed from spec.md (feature lane requires at least one)";

/**
 * Parse CLI args of the form `--flag value` / `--flag=value` / `--flag`.
 * @param {string[]} args
 * @returns {Map<string, string>}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    let flagName = a.slice(2);
    let val;
    const eq = flagName.indexOf("=");
    if (eq !== -1) {
      val = flagName.slice(eq + 1);
      flagName = flagName.slice(0, eq);
    } else {
      const next = args.at(i + 1);
      if (next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        val = "true";
      }
    }
    flags.set(flagName, val);
  }
  return flags;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const flags = parseArgs(argv);

  const repoRoot = resolve(flags.get("repo-root") || process.cwd());
  const statePath = flags.get("state-path") || join(repoRoot, STATE_PATH);
  const specPath = flags.get("spec-path") || join(repoRoot, SPEC_REL_PATH);
  const traceDir = flags.get("trace-dir") || join(repoRoot, TRACE_DIR);
  const resultPath = join(repoRoot, RESULT_REL_PATH);

  const stateRes = readTaskState(statePath);
  const taskId = flags.get("task") || (stateRes.ok ? stateRes.state.taskId : undefined);
  const lane = stateRes.ok ? stateRes.state.lane : "feature";

  if (!taskId) {
    const result = {
      ok: false,
      error: "task id unresolved: pass --task <id> or ensure task.json exists",
    };
    await writeResult(resultPath, result);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  const markdown = pathExists(specPath) ? readTextFileSync(specPath) : "";
  const criteria = parseAcceptanceCriteria(markdown);

  const { steps } = await readTrace(taskId, { traceDir });
  const completedIds = completedAcNumbers(steps);

  const coverage = computeAcCoverage(criteria, completedIds);

  // Fail-closed: a feature-lane spec that parses to zero ACs (e.g. a
  // malformed heading) must not read as vacuously covered.
  const zeroAcFailure = lane === "feature" && coverage.total === 0;
  const ok = zeroAcFailure ? false : coverage.ok;
  const error = zeroAcFailure ? ZERO_AC_ERROR : null;

  const result = {
    ok,
    taskId,
    lane,
    total: coverage.total,
    completed: coverage.completed,
    coveragePercent: coverage.coveragePercent,
    missing: coverage.missing,
    error,
  };
  await writeResult(resultPath, result);
  process.stdout.write(JSON.stringify(result) + "\n");
  return ok ? 0 : 1;
}

// Only run when executed directly, not when imported by tests.
const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (entryPath === modulePath) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
