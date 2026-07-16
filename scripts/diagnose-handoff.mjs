// @ts-check
// Agent-invoked entrypoint (E5-1): post-diagnosis fixer handoff.
//
// Reads a DiagnosisResult JSON (from --diagnosis-file <path> or stdin),
// validates it, loads TaskState, dispatches the single generic fixer agent
// (@fullstack) with the diagnosed persona, and prints a compact
// `{ target, persona, stateUpdated }` JSON line. Also writes result to
// .devmate/state/diagnose-handoff-result.json (E11-1).
//
// Exit 0 on success; 1 on validation failure or unreadable state.
// Output is a single JSON line — full diagnosis prose is never printed.
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { readTextFile } from "../lib/fs-safe.mjs";
import { writeResult } from "../lib/output/write-result.mjs";
import { readTaskState } from "../lib/task-state.mjs";
import {
  assertDiagnosisResult,
  dispatchFixer,
} from "../lib/workflow/bug-handoff.mjs";

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  // @bounded-alloc — one Buffer per stdin chunk; bounded by the piped hook payload.
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string[]} args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  let diagnosisFile;
  let statePath;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args.at(i + 1);
    if (a === "--diagnosis-file" && next) {
      diagnosisFile = next;
      i++;
    } else if (a.startsWith("--diagnosis-file=")) {
      diagnosisFile = a.slice("--diagnosis-file=".length);
    } else if (a === "--state-path" && next) {
      statePath = next;
      i++;
    } else if (a.startsWith("--state-path=")) {
      statePath = a.slice("--state-path=".length);
    }
  }

  // 1. Read raw diagnosis JSON (file preferred, else stdin).
  let raw;
  try {
    raw = diagnosisFile
      ? await readTextFile(diagnosisFile)
      : await readStdin();
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: cannot read diagnosis input: ${msg}\n`);
    return 1;
  }

  // 2. Parse + validate.
  let diagnosis;
  try {
    diagnosis = assertDiagnosisResult(JSON.parse(raw));
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: invalid diagnosis: ${msg}\n`);
    return 1;
  }

  // 3. Load TaskState.
  const read = readTaskState(statePath);
  if (!read.ok) {
    process.stderr.write(
      `error: cannot read TaskState: ${read.errors.join("; ")}\n`,
    );
    return 1;
  }

  // 4. Dispatch.
  let result;
  try {
    result = await dispatchFixer(diagnosis, read.state, { statePath });
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: dispatch failed: ${msg}\n`);
    return 1;
  }

  const out = {
    target: result.target,
    persona: result.persona,
    stateUpdated: result.stateUpdated,
  };

  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/diagnose-handoff-result.json", out);
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
