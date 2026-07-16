// @ts-check

/** @typedef {import('../types.mjs').FlakeResult} FlakeResult */
/** @typedef {import('../types.mjs').FlakeRunOpts} FlakeRunOpts */
/** @typedef {import('../types.mjs').LoopAttemptEvent} LoopAttemptEvent */

import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ensureDirSync, writeTextFileSync } from '../fs-safe.mjs';
import { runCommand } from './run-command.mjs';
import { appendTraceEvent } from './trace-writer.mjs';
import { SCHEMA_VERSION } from './trace-schema.mjs';
import { estimateAttemptTokens } from './cost-tracker.mjs';
import { digestsEqual } from '../digest-compare.mjs';

/** Output cap in characters (4 KiB). */
const OUTPUT_CAP = 4096;

/**
 * Compute SHA-256 digest (first 64 hex chars) of a string.
 * @param {string} text
 * @returns {string}
 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

/**
 * Write full output to an artifact file and return its absolute path.
 * @param {string} outputDir
 * @param {string} attemptId
 * @param {string} combined
 * @returns {string}
 */
function writeArtifact(outputDir, attemptId, combined) {
  const absDir = resolve(outputDir);
  ensureDirSync(absDir);
  const filePath = join(absDir, `${attemptId}.txt`);
  writeTextFileSync(filePath, combined);
  return filePath;
}

/**
 * Run `argv` once. If it fails, run it again.
 * Trace both runs via `appendTraceEvent` with linked `rerunOf` field.
 * Return a compact FlakeResult — never return raw full output.
 *
 * Callers should not call step_complete writer (E2-1) when
 * verdict === 'flaky' or verdict === 'failed' without human acknowledgement.
 *
 * @param {FlakeRunOpts} opts
 * @returns {Promise<FlakeResult>}
 */
export async function runWithFlakeDetection(opts) {
  const {
    argv,
    traceFile,
    taskId,
    firstAttemptId,
    timeoutMs = 120_000,
    outputDir = '.devmate/output',
    tier = 1,
  } = opts;

  const startMs = Date.now();

  // --- First run ---
  const first = await runCommand(argv, { timeoutMs });
  const firstCombined = first.stdout + first.stderr;
  const firstDigest = digest(firstCombined);
  const firstCapped = firstCombined.slice(0, OUTPUT_CAP);
  const firstArtifact = writeArtifact(outputDir, firstAttemptId, firstCombined);
  const firstTokenEstimate = estimateAttemptTokens({ outputBytes: firstCombined.length });

  /** @type {LoopAttemptEvent} */
  const firstEvent = {
    schemaVersion: SCHEMA_VERSION,
    type: 'loop_attempt',
    attemptId: firstAttemptId,
    taskId,
    ts: new Date().toISOString(),
    tier,
    command: argv,
    exitCode: first.exitCode,
    outputDigest: firstDigest,
    fullOutputPath: firstArtifact,
    tokenEstimate: firstTokenEstimate,
  };
  await appendTraceEvent(traceFile, firstEvent);

  // First run passed — no rerun needed.
  if (first.exitCode === 0 && !first.timedOut) {
    return {
      verdict: 'passed',
      firstAttemptId,
      rerunAttemptId: null,
      outputDigest: firstDigest,
      outputCapped: firstCapped,
      fullOutputPath: firstArtifact,
      rerunFullOutputPath: null,
      timedOut: false,
      durationMs: Date.now() - startMs,
    };
  }

  // First run timed out — treat as unstable fail, no rerun.
  if (first.timedOut) {
    return {
      verdict: 'failed',
      firstAttemptId,
      rerunAttemptId: null,
      outputDigest: firstDigest,
      outputCapped: firstCapped,
      fullOutputPath: firstArtifact,
      rerunFullOutputPath: null,
      timedOut: true,
      durationMs: Date.now() - startMs,
    };
  }

  // --- Second run (rerun) ---
  const rerunAttemptId = randomUUID();
  const rerun = await runCommand(argv, { timeoutMs });
  const rerunCombined = rerun.stdout + rerun.stderr;
  const rerunDigest = digest(rerunCombined);
  const rerunCapped = rerunCombined.slice(0, OUTPUT_CAP);
  const rerunArtifact = writeArtifact(outputDir, rerunAttemptId, rerunCombined);
  const rerunTokenEstimate = estimateAttemptTokens({ outputBytes: rerunCombined.length });

  /** @type {LoopAttemptEvent} */
  const rerunEvent = {
    schemaVersion: SCHEMA_VERSION,
    type: 'loop_attempt',
    attemptId: rerunAttemptId,
    taskId,
    ts: new Date().toISOString(),
    tier,
    command: argv,
    exitCode: rerun.exitCode,
    outputDigest: rerunDigest,
    fullOutputPath: rerunArtifact,
    tokenEstimate: rerunTokenEstimate,
    rerunOf: firstAttemptId,
  };
  await appendTraceEvent(traceFile, rerunEvent);

  const totalDurationMs = Date.now() - startMs;

  // Rerun passed — flaky confirmed.
  if (rerun.exitCode === 0 && !rerun.timedOut) {
    return {
      verdict: 'flaky',
      firstAttemptId,
      rerunAttemptId,
      outputDigest: firstDigest,
      outputCapped: firstCapped,
      fullOutputPath: firstArtifact,
      rerunFullOutputPath: rerunArtifact,
      timedOut: false,
      durationMs: totalDurationMs,
    };
  }

  // Both runs failed — compare digests.
  /** @type {'stable_fail'|'failed'} */
  const verdict = digestsEqual(firstDigest, rerunDigest) ? 'stable_fail' : 'failed';

  return {
    verdict,
    firstAttemptId,
    rerunAttemptId,
    outputDigest: firstDigest,
    outputCapped: firstCapped,
    fullOutputPath: firstArtifact,
    rerunFullOutputPath: rerunArtifact,
    rerunOutputCapped: rerunCapped,
    timedOut: false,
    durationMs: totalDurationMs,
  };
}
