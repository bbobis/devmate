// @ts-check
// Agent-invoked entrypoint (E3-6): write a validated `step_complete` trace
// entry with artifact pointers to the task trace JSONL, enabling reliable
// skip-completed-work on resume. Never pastes file contents — pointers + digests
// only (TCM-3). Output is a single JSON line; full ledger contents are never
// printed.
//
// Trace path resolution: process.env.DEVMATE_TRACE_PATH, else
// `.devmate/state/trace.jsonl` resolved from process.cwd() (E11-1: absolute
// path, not bare relative, so it always resolves from the consumer workspace).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { readTextFile } from "../lib/fs-safe.mjs";
import { writeStepComplete } from "../lib/memory/trace-writer.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";

/**
 * Resolve the default trace path as an absolute path from cwd so it always
 * points to the consumer workspace root regardless of where node was invoked.
 * @returns {string}
 */
function defaultTracePath() {
  return join(process.cwd(), ".devmate", "state", "trace.jsonl");
}

/**
 * Parse CLI args supporting repeatable `--artifact` flags.
 * @param {string[]} args
 * @returns {{ flags: Map<string, string>, artifacts: string[] }}
 */
function parseArgs(args) {
  /** @type {Map<string, string>} */
  const flags = new Map();
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
    if (flagName === "artifact") {
      artifacts.push(val);
    } else {
      flags.set(flagName, val);
    }
  }
  return { flags, artifacts };
}

/**
 * Build an ArtifactPointer from a `--artifact path@kind` spec, computing a
 * digest from the file content when it exists on disk.
 * @param {string} spec
 * @returns {Promise<import('../lib/types.mjs').ArtifactPointer>}
 */
async function buildArtifact(spec) {
  const at = spec.lastIndexOf("@");
  let artifactFile = spec;
  let kind = "source-file";
  if (at > 0) {
    artifactFile = spec.slice(0, at);
    kind = spec.slice(at + 1);
  }
  /** @type {import('../lib/types.mjs').ArtifactPointer} */
  const ptr = { path: artifactFile, kind };
  try {
    // Artifacts are utf8 text (source files, JSON, MD); hashing the decoded
    // text re-encoded as utf8 is byte-identical for valid utf8 content.
    const text = await readTextFile(artifactFile);
    ptr.digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  } catch {
    // Missing file — pointer without digest is allowed.
  }
  return ptr;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { flags, artifacts: artifactSpecs } = parseArgs(argv);

  const stepId = flags.get("step-id");
  const label = flags.get("label");
  const taskId = flags.get("task-id");
  if (!stepId || !label || !taskId) {
    process.stderr.write(
      "error: --step-id, --label, and --task-id are required\n" +
        "usage: complete-step.mjs --step-id [id] --label [text] --task-id [id] " +
        "[--lane [lane]] [--artifact [path@kind]]... [--verify-output [text]]\n",
    );
    return 1;
  }

  // Resolve lane: explicit flag, else TaskState, else 'unknown'.
  let lane = flags.get("lane");
  if (!lane) {
    const st = readTaskState();
    lane = st.ok ? st.state.lane : "unknown";
  }

  const artifacts = [];
  for (const spec of artifactSpecs) {
    artifacts.push(await buildArtifact(spec));
  }

  /** @type {import('../lib/types.mjs').StepCompleteEntry} */
  const entry = {
    event: "step_complete",
    stepId,
    label,
    taskId,
    lane,
    artifacts,
    ts: Date.now(),
  };
  const verifyOutput = flags.get("verify-output");
  if (verifyOutput !== undefined) {
    entry.verifyOutput = verifyOutput;
  }

  // E11-1: resolve trace path absolutely from cwd so it always points to the
  // consumer workspace root (DEVMATE_TRACE_PATH env var respected first).
  const tracePath = process.env.DEVMATE_TRACE_PATH || defaultTracePath();
  const result = await writeStepComplete(entry, tracePath);

  // Write result to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/complete-step-result.json", result);
  process.stdout.write(JSON.stringify(result) + "\n");

  if (result.ok || result.error === "already_complete") return 0;
  return 1;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
