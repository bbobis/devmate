// @ts-check
// E5-1 (with E10 re-spec #90): bug-lane orchestration.
//
// Coordinates the post-diagnosis handoff: validate the @diagnose output, select
// the single generic fixer agent (@fullstack) with the diagnosed persona, and
// persist the routing onto TaskState via dispatchFixer.
//
// Gate model (anti-hallucination): the real WorkflowGate values are used
// (`plan-approved|impl-started|verification-passed|pr-ready|done`). The spec's
// `diagnosis-complete` / `fixer-dispatched` gates do NOT exist in
// lib/gate-transitions.mjs, so no new gate names are invented. Diagnosis is
// expected to have run during the `impl-started` phase; the handoff records the
// fixer routing without adding gate transitions.
//
// P06: edit-scope enforcement is now handled uniformly by the gate-guard reading
// .devmate/session/{taskId}/scope.md — the unified scope contract written by
// @diagnose. The old `enforceBugScope` predicate has been removed. The
// gate-guard's evaluateGuard Rule 6 enforces the scope for all lanes.

import { randomUUID } from 'node:crypto';
import { verifyStep } from '../../loop/verify-step.mjs';
import { assertDiagnosisResult, dispatchFixer } from '../bug-handoff.mjs';

/** @typedef {import('../../types.mjs').DiagnosisResult} DiagnosisResult */
/** @typedef {import('../../types.mjs').TaskState} TaskState */
/** @typedef {import('../../types.mjs').FixerTarget} FixerTarget */

/**
 * Run the bug-lane handoff: validate diagnosis, dispatch the generic fixer with
 * the diagnosed persona, persist routing to TaskState.
 *
 * @param {DiagnosisResult} diagnosis  Validated @diagnose output.
 * @param {TaskState} state            Current task state (lane should be 'bug').
 * @param {object} [opts]
 * @param {string} [opts.statePath]
 * @param {string} [opts.transitionsPath]
 * @returns {Promise<{ target: FixerTarget, persona: string, stateUpdated: boolean }>}
 */
export async function runBugHandoff(diagnosis, state, opts = {}) {
  const validated = assertDiagnosisResult(diagnosis);
  return dispatchFixer(validated, state, opts);
}

/**
 * @param {unknown} value
 * @returns {value is { ok: boolean, errors: string[] }}
 */
function isValidationResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = /** @type {Record<string, unknown>} */ (value);
  return typeof v.ok === 'boolean' && Array.isArray(v.errors);
}

/**
 * Run the bug lane: diagnose -> scope -> implement -> verify.
 * Typed contract seam documenting three in-process steps sequenced by the
 * orchestrator. Accepts injection seam (opts) for test fakes; defaults to real
 * implementations from bug-handoff.mjs and lib/loop/verify-step.mjs.
 *
 * Note: @diagnose and @fullstack are LLM-dispatched by the orchestrator, not
 * called here. This contract seals the validation + dispatch + verify sequence
 * and is suitable for tests, scripts, and documentation. The orchestrator
 * markdown is the runtime sequencer.
 *
 * @param {string} bugDescription      User-provided bug description.
 * @param {TaskState} taskState        Current task state (lane should be 'bug').
 * @param {object} [opts={}]           Injection seam for tests.
 * @param {DiagnosisResult} [opts.diagnosis]
 * @param {Function} [opts.validate]   Defaults to assertDiagnosisResult.
 * @param {Function} [opts.dispatch]   Defaults to dispatchFixer.
 * @param {Function} [opts.verify]     Defaults to a real verify via verifyStep
 *                                     (E9-13) — the bug lane never skips
 *                                     verification.
 * @param {readonly string[]} [opts.verifyArgv]  Command for the default verify
 *                                     (defaults to ["npm", "run", "verify"]).
 * @param {string} [opts.traceFile]    Trace file for the default verify.
 * @param {string} [opts.repoRoot]     Repo root for the default verify.
 * @param {string} [opts.outputDir]    Output dir for the default verify.
 * @returns {Promise<{ status: 'verified' | 'failed', summary: string }>}
 */
export async function runBugLane(bugDescription, taskState, opts = {}) {
  const {
    diagnosis,
    validate = assertDiagnosisResult,
    dispatch = dispatchFixer,
    verify = defaultVerify,
  } = opts;

  // Step 1: Validate diagnosis (in-process schema check)
  if (!diagnosis) {
    return {
      status: 'failed',
      summary: `Bug lane halted: no diagnosis provided for "${bugDescription}".`,
    };
  }

  let validated;
  try {
    const result = validate(diagnosis);
    if (isValidationResult(result)) {
      if (!result.ok) {
        return {
          status: 'failed',
          summary: `Bug lane halted: validation failed — ${result.errors.join('; ')}`,
        };
      }
      validated = diagnosis;
    } else {
      validated = result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      summary: `Bug lane halted: validation failed — ${msg}`,
    };
  }

  // Step 2: Dispatch fixer (in-process handoff)
  let dispatchResult;
  try {
    dispatchResult = await dispatch(validated, taskState, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      summary: `Bug lane halted: fixer dispatch failed — ${msg}`,
    };
  }

  // Step 3: Verify — always runs (E9-13). The default mirrors chore's
  // defaultVerify: a real verifyStep over ["npm", "run", "verify"].
  let verifyResult;
  try {
    verifyResult = await verify({
      taskId: taskState.taskId,
      verifyArgv: opts.verifyArgv,
      traceFile: opts.traceFile,
      repoRoot: opts.repoRoot,
      outputDir: opts.outputDir,
    });
    const verifyStatus = verifyResult?.passed ? 'verified' : 'failed';
    const suffix = verifyStatus === 'verified'
      ? ` Bug diagnosed and dispatched to @fullstack as persona '${dispatchResult.persona}'.`
      : '';
    return {
      status: verifyStatus,
      summary: (verifyResult?.summary || `Verification ${verifyStatus}.`) + suffix,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      summary: `Bug lane halted: verification failed — ${msg}`,
    };
  }
}

/** Default verify command when the caller does not inject one. */
const DEFAULT_VERIFY_ARGV = Object.freeze(['npm', 'run', 'verify']);

/**
 * Real default verify for the bug lane, mirroring chore's defaultVerify:
 * runs verifyStep over the verify command and returns its VerifyResult.
 * @param {{ taskId?: string, verifyArgv?: readonly string[], traceFile?: string, repoRoot?: string, outputDir?: string }} ctx
 * @returns {Promise<import('../../types.mjs').VerifyResult>}
 */
async function defaultVerify(ctx) {
  return verifyStep({
    argv: [...(ctx.verifyArgv ?? DEFAULT_VERIFY_ARGV)],
    traceFile: ctx.traceFile ?? '.devmate/state/trace.jsonl',
    taskId: ctx.taskId ?? 'bug-lane',
    attemptId: randomUUID(),
    ...(ctx.repoRoot !== undefined ? { repoRoot: ctx.repoRoot } : {}),
    ...(ctx.outputDir !== undefined ? { outputDir: ctx.outputDir } : {}),
  });
}
