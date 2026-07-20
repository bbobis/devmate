// @ts-check

/** @typedef {import('../types.mjs').VerifyResult} VerifyResult */
/** @typedef {import('../types.mjs').VerifyStepOpts} VerifyStepOpts */
/** @typedef {import('../types.mjs').FlakeResult} FlakeResult */

import { join, dirname } from 'node:path';
import {
  ensureDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from '../fs-safe.mjs';
import { validateArgv } from './run-command.mjs';
import { isString } from '../object-utils.mjs';
import { runLoopGuard } from './loop-guard.mjs';
import { runWithFlakeDetection } from './flake-rerun.mjs';

/**
 * Read the approved spec digest from task state, or '' when absent.
 * @param {string} stateDir
 * @returns {Promise<string>}
 */
async function readSpecDigestFromStateDir(stateDir) {
  try {
    const raw = await readTextFile(join(stateDir, 'task.json'));
    const state = JSON.parse(raw);
    const digest = state?.artifactHashes?.specDigest;
    return isString(digest) ? digest : '';
  } catch {
    return '';
  }
}

/**
 * Read the current task id from task state, or '' when absent.
 * @param {string} stateDir
 * @returns {Promise<string>}
 */
async function readTaskIdFromStateDir(stateDir) {
  try {
    const raw = await readTextFile(join(stateDir, 'task.json'));
    const state = JSON.parse(raw);
    const taskId = state?.taskId;
    return isString(taskId) ? taskId : '';
  } catch {
    return '';
  }
}

/**
 * Persist the verify evidence artifact (E9-13) consumed by the
 * pass-verification gate precondition. Atomic tmp+rename.
 *
 * The artifact is stamped with the owning `taskId` (read from task.json unless
 * given) so the gate precondition can refuse a fresh, passing verify-result.json
 * left behind by an EARLIER task — the artifact lives at a fixed path and nothing
 * clears it between tasks, and the specDigest guard is vacuous on the lanes that
 * write no spec (bug/chore). Ownership closes that stale-evidence hole.
 * @param {{ passed: boolean, digest: string, fullOutputPath: string }} result
 * @param {{ repoRoot?: string, stateDir?: string, specDigest?: string, taskId?: string }} [opts]
 *        `stateDir` overrides the artifact directory (defaults to
 *        `<repoRoot>/.devmate/state`); `taskId` overrides the owner stamp.
 * @returns {Promise<string>} the artifact path
 */
export async function persistVerifyResult(result, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const stateDir = opts.stateDir ?? join(repoRoot, '.devmate', 'state');
  const taskId = opts.taskId ?? (await readTaskIdFromStateDir(stateDir));
  /** @type {import('../types.mjs').VerifyResultArtifact} */
  const artifact = {
    passed: result.passed,
    digest: result.digest,
    fullOutputPath: result.fullOutputPath,
    completedAt: new Date().toISOString(),
    specDigest: opts.specDigest ?? (await readSpecDigestFromStateDir(stateDir)),
    // Only stamp a non-empty owner; an empty string reads as "no owner" (absence),
    // which the precondition treats leniently.
    ...(taskId ? { taskId } : {}),
  };
  const artifactPath = join(stateDir, 'verify-result.json');
  const tmpPath = artifactPath + '.tmp';
  await ensureDir(dirname(artifactPath));
  await writeTextFile(tmpPath, JSON.stringify(artifact, null, 2));
  await renamePath(tmpPath, artifactPath);
  return artifactPath;
}

/**
 * Run a verification command, capture output, write artifact, append loop_attempt trace,
 * then run loop-guard. Returns a capped VerifyResult — never raw full output.
 * When the first run fails, delegates to runWithFlakeDetection for the rerun.
 * @param {VerifyStepOpts} opts
 * @returns {Promise<VerifyResult & { flakeResult?: FlakeResult }>}
 */
export async function verifyStep(opts) {
  const {
    argv,
    traceFile,
    taskId,
    attemptId,
    timeoutMs = 120_000,
    outputDir = '.devmate/output',
    tier = 1,
    repoRoot = process.cwd(),
  } = opts;

  // Validate argv up front (throws on metachar in argv[0]).
  validateArgv(argv);

  // Run first attempt via flake-rerun so both runs are always traced.
  const flakeResult = await runWithFlakeDetection({
    argv,
    traceFile,
    taskId,
    firstAttemptId: attemptId,
    timeoutMs,
    outputDir,
    tier,
  });

  // Run loop-guard using first attempt's digest.
  const guardResult = await runLoopGuard({
    traceFile,
    taskId,
    attemptId,
    maxFiles: 50,
    repoRoot,
    currentDigest: flakeResult.outputDigest,
  });

  const passed =
    (flakeResult.verdict === 'passed' || flakeResult.verdict === 'flaky') && guardResult.allowed;

  // E9-13: persist the verify evidence the pass-verification gate requires.
  // Best-effort — an artifact-write failure must not change the verify result.
  try {
    await persistVerifyResult(
      { passed, digest: flakeResult.outputDigest, fullOutputPath: flakeResult.fullOutputPath },
      { repoRoot },
    );
  } catch {
    // non-fatal
  }

  return {
    passed,
    exitCode: flakeResult.verdict === 'passed' ? 0 : 1,
    timedOut: flakeResult.timedOut,
    outputDigest: flakeResult.outputDigest,
    outputCapped: flakeResult.outputCapped,
    fullOutputPath: flakeResult.fullOutputPath,
    durationMs: flakeResult.durationMs,
    flakeResult,
  };
}
