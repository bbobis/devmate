// @ts-check
// Agent-invoked entrypoint: record per-acceptance-criterion implementation
// progress. For each completed AC id it appends a canonical `step_complete`
// event (`stepId: impl-AC{n}`) to the per-task trace via `appendTraceEvent` —
// the SAME trace `buildResumePlan`/`readTrace` consume, so resume skips
// completed ACs — then syncs the `spec.md` checkboxes (`- [ ]` -> `- [x]`) to
// match and refreshes `artifactHashes.specDigest` so the spec-integrity guard
// stays consistent. Trace is the source of truth; the checkboxes are a view.
//
// Never pastes file contents — pointers only (TCM-3/-4). Output is one JSON line
// plus a result file at `.devmate/state/complete-ac-result.json`.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import {
  pathExists,
  readTextFileSync,
  writeTextFileSync,
} from "../lib/fs-safe.mjs";
import { appendTraceEvent, TRACE_DIR } from "../lib/trace/append.mjs";
import { readTrace } from "../lib/trace/read-trace.mjs";
import {
  acStepId,
  completedAcNumbers,
  parseAcceptanceCriteria,
  renderCheckedSpec,
} from "../lib/spec-progress.mjs";
import { readTaskState, recordArtifactHash, STATE_PATH } from "../lib/task-state.mjs";
import { writeResult } from "../lib/output/write-result.mjs";

/** Trace schema version emitted for AC completions. */
const SCHEMA_VERSION = 1;

/** Cap the trace label so a single completion line stays bounded. */
const MAX_LABEL = 120;

/** Spec artifact path, relative to the repo root. */
const SPEC_REL_PATH = ".devmate/session/spec.md";

/**
 * Parse CLI args supporting repeatable `--ac` and `--artifact` flags.
 * @param {string[]} args
 * @returns {{ flags: Map<string, string>, acs: number[], artifacts: string[] }}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  /** @type {number[]} */
  const acs = [];
  /** @type {string[]} */
  const artifacts = [];
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
    if (flagName === "ac") {
      const n = Number(val);
      if (Number.isInteger(n) && n >= 1) acs.push(n);
    } else if (flagName === "artifact") {
      artifacts.push(val);
    } else {
      flags.set(flagName, val);
    }
  }
  return { flags, acs, artifacts };
}

/**
 * Cap a string to `max` chars, appending an ellipsis when truncated.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function capLabel(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Resolve the ordered acceptance-criteria labels: prefer persisted task state,
 * else fall back to parsing spec.md, else empty.
 * @param {string[]|undefined} fromState
 * @param {string} specPath
 * @returns {string[]}
 */
function resolveAcLabels(fromState, specPath) {
  if (Array.isArray(fromState) && fromState.length > 0) return fromState;
  if (pathExists(specPath)) {
    try {
      const parsed = parseAcceptanceCriteria(readTextFileSync(specPath));
      if (parsed.length > 0) {
        // Positional: index+1 is the id; place text at [id-1].
        /** @type {string[]} */
        const labels = [];
        for (const c of parsed) labels[c.id - 1] = c.text;
        return labels;
      }
    } catch {
      // Unreadable spec — fall through to empty labels.
    }
  }
  return [];
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { flags, acs, artifacts: artifactPaths } = parseArgs(argv);

  const repoRoot = resolve(flags.get("repo-root") || process.cwd());
  const statePath = flags.get("state-path") || join(repoRoot, STATE_PATH);
  const specPath = flags.get("spec-path") || join(repoRoot, SPEC_REL_PATH);
  const traceDir = flags.get("trace-dir") || join(repoRoot, TRACE_DIR);

  // Resolve taskId and AC labels from task state.
  const stateRes = readTaskState(statePath);
  let taskId = flags.get("task-id") || flags.get("task");
  /** @type {string[]} */
  let acLabels = [];
  /** @type {string} */
  let lane = "feature";
  if (stateRes.ok) {
    taskId = taskId || stateRes.state.taskId;
    lane = stateRes.state.lane;
    acLabels = resolveAcLabels(stateRes.state.acceptanceCriteria, specPath);
  } else {
    acLabels = resolveAcLabels(undefined, specPath);
  }

  if (!taskId) {
    const result = {
      ok: false,
      error: "task id unresolved: pass --task <id> or ensure task.json exists",
    };
    await writeResult(join(repoRoot, ".devmate/state/complete-ac-result.json"), result);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  if (acs.length === 0) {
    const result = { ok: false, error: "no acceptance criteria given: pass --ac <n>" };
    await writeResult(join(repoRoot, ".devmate/state/complete-ac-result.json"), result);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 1;
  }

  // Idempotency: skip ids already recorded as complete in the trace.
  const { steps } = await readTrace(taskId, { traceDir });
  const already = new Set(completedAcNumbers(steps));

  /** @type {number[]} */
  const recorded = [];
  /** @type {number[]} */
  const skipped = [];
  for (const n of acs) {
    if (already.has(n)) {
      skipped.push(n);
      continue;
    }
    const label = capLabel(acLabels[n - 1] || `AC${n}`, MAX_LABEL);
    const append = await appendTraceEvent(
      {
        type: "step_complete",
        stepId: acStepId(n),
        taskId,
        ts: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
        label,
        artifactPaths,
      },
      { root: repoRoot },
    );
    if (append.ok) {
      recorded.push(n);
      already.add(n);
    } else {
      const result = {
        ok: false,
        error: `trace append failed for AC${n}: ${(append.errors || []).join("; ")}`,
      };
      await writeResult(join(repoRoot, ".devmate/state/complete-ac-result.json"), result);
      process.stdout.write(JSON.stringify(result) + "\n");
      return 1;
    }
  }

  // Sync spec.md checkboxes to the full completed set, then refresh the digest.
  let specSynced = false;
  let specDigest = null;
  if (pathExists(specPath)) {
    const markdown = readTextFileSync(specPath);
    const completedSet = new Set(already);
    const next = renderCheckedSpec(markdown, completedSet);
    if (next !== markdown) {
      writeTextFileSync(specPath, next);
      specSynced = true;
    }
    specDigest = createHash("sha256")
      .update(next, "utf8")
      .digest("hex");
    // Keep the recorded spec digest consistent with the on-disk bytes so the
    // spec-integrity guard does not see a stale mismatch. Reuses the atomic,
    // file-locked writer; a no-op when task.json is absent.
    await recordArtifactHash("spec", specDigest, specPath, { statePath });
  }

  const result = {
    ok: true,
    taskId,
    lane,
    recorded,
    skipped,
    completed: [...already].sort((a, b) => a - b),
    total: acLabels.length,
    specSynced,
    specDigest,
    error: null,
  };
  await writeResult(join(repoRoot, ".devmate/state/complete-ac-result.json"), result);
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
