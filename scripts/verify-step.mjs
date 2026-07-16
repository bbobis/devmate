// @ts-check
import { assertNodeVersion, isMainModule } from "../lib/env-guard.mjs";
import { verifyStep } from "../lib/loop/verify-step.mjs";
import { writeResult } from "../lib/output/write-result.mjs";

/** @typedef {import('../lib/types.mjs').VerifyStepOpts} VerifyStepOpts */
/** @typedef {import('../lib/types.mjs').LoopOutput} LoopOutput */
/** @typedef {import('../lib/types.mjs').LoopOutputFull} LoopOutputFull */

/**
 * Parse a named flag value from args array.
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|undefined}
 */
function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args.at(idx + 1);
}

/**
 * Check for a boolean flag (presence = true).
 * @param {string[]} args
 * @param {string} flag
 * @returns {boolean}
 */
function hasFlag(args, flag) {
  return args.includes(flag);
}

/**
 * Main entrypoint for verify-step.
 * Runs the command, enforces the output boundary, and prints a LoopOutput JSON
 * to stdout. output_full is NEVER included unless --include-full-output is set.
 * Also writes LoopOutput to .devmate/state/verify-step-result.json so the agent
 * can read_file when shell integration is absent (E11-1).
 * @param {string[]} args
 * @returns {Promise<number>} exit code
 */
export async function main(args) {
  // Parse argv: support --argv JSON or positional args after --
  let argv;
  const argvFlag = getFlag(args, "--argv");
  if (argvFlag !== undefined) {
    try {
      argv = JSON.parse(argvFlag);
    } catch {
      process.stderr.write("Error: --argv must be a JSON array string\n");
      return 1;
    }
  } else {
    const ddIdx = args.indexOf("--");
    if (ddIdx !== -1) {
      argv = args.slice(ddIdx + 1);
    }
  }

  if (!Array.isArray(argv) || argv.length === 0) {
    process.stderr.write(
      "Error: provide command via --argv JSON or after --\n",
    );
    return 1;
  }

  const traceFile = getFlag(args, "--trace-file");
  const taskId = getFlag(args, "--task-id");
  const attemptId = getFlag(args, "--attempt-id");
  const timeoutMsStr = getFlag(args, "--timeout-ms");
  const tierStr = getFlag(args, "--tier");
  const outputDir = getFlag(args, "--output-dir") ?? ".devmate/output";
  const includeFullOutput = hasFlag(args, "--include-full-output");

  if (!traceFile) {
    process.stderr.write("Error: --trace-file is required\n");
    return 1;
  }
  if (!taskId) {
    process.stderr.write("Error: --task-id is required\n");
    return 1;
  }
  if (!attemptId) {
    process.stderr.write("Error: --attempt-id is required\n");
    return 1;
  }

  /** @type {VerifyStepOpts} */
  const stepOpts = {
    argv,
    traceFile,
    taskId,
    attemptId,
    ...(timeoutMsStr !== undefined
      ? { timeoutMs: parseInt(timeoutMsStr, 10) }
      : {}),
    ...(tierStr !== undefined ? { tier: parseInt(tierStr, 10) } : {}),
    outputDir,
  };

  let verifyResult;
  try {
    verifyResult = await verifyStep(stepOpts);
  } catch (/** @type {unknown} */ err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  /** @type {LoopOutput | LoopOutputFull} */
  const loopOutput = await buildBoundaryOutput({
    verifyResult,
    attemptId,
    includeFullOutput,
  });

  // Write to state file so agent can read_file (E11-1).
  await writeResult(".devmate/state/verify-step-result.json", loopOutput);
  process.stdout.write(JSON.stringify(loopOutput) + "\n");

  // Include compact flakeResult summary on stderr when a rerun occurred.
  if (
    verifyResult.flakeResult &&
    verifyResult.flakeResult.rerunAttemptId !== null
  ) {
    const flakeSummary = {
      verdict: verifyResult.flakeResult.verdict,
      firstAttemptId: verifyResult.flakeResult.firstAttemptId,
      rerunAttemptId: verifyResult.flakeResult.rerunAttemptId,
      output_digest: verifyResult.flakeResult.outputDigest,
      rerunFullOutputPath: verifyResult.flakeResult.rerunFullOutputPath,
    };
    process.stderr.write("flakeResult: " + JSON.stringify(flakeSummary) + "\n");
  }

  return verifyResult.exitCode;
}

/**
 * Build the boundary LoopOutput from a verifyStep result.
 * Applies redaction and capping at the scripts boundary.
 * Only includes output_full when includeFullOutput is true.
 *
 * @param {{
 *   verifyResult: Awaited<ReturnType<typeof verifyStep>>,
 *   attemptId: string,
 *   includeFullOutput: boolean,
 * }} opts
 * @returns {Promise<LoopOutput | LoopOutputFull>}
 */
async function buildBoundaryOutput({
  verifyResult,
  attemptId,
  includeFullOutput,
}) {
  const { readFileSync } = await import("node:fs");
  const { redactSecrets, capOutput } =
    await import("../lib/loop/output-cap.mjs");

  // Read the full output from the artifact already written by flake-rerun.
  let fullCombined = "";
  try {
    fullCombined = readFileSync(verifyResult.fullOutputPath, "utf8");
  } catch {
    // Artifact missing — fall back to capped output.
    fullCombined = verifyResult.outputCapped;
  }

  const redacted = redactSecrets(fullCombined);
  const output_capped = capOutput(redacted);

  /** @type {LoopOutput} */
  const base = {
    passed: verifyResult.passed,
    exitCode: verifyResult.exitCode,
    timedOut: verifyResult.timedOut,
    output_capped,
    output_digest: verifyResult.outputDigest,
    full_output_path: verifyResult.fullOutputPath,
    durationMs: verifyResult.durationMs,
    attemptId,
  };

  if (includeFullOutput) {
    return { ...base, output_full: redacted };
  }

  return base;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
