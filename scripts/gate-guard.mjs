// @ts-check
import { readSync } from 'node:fs';
import { readTextFileSync } from '../lib/fs-safe.mjs';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { resolve as resolvePath } from 'node:path';
import { readTaskState, writeTaskState } from '../lib/task-state.mjs';
import {
  loadDevmateConfig,
  resolveSessionArtifactPolicy,
} from '../lib/config/devmate-config.mjs';
import { readScopeForTask } from '../lib/workflow/scope.mjs';
import {
  isImplementationDispatch,
  evaluateImplementationDispatch,
} from '../lib/workflow/dispatch-gate.mjs';
import { normalizeLane } from '../lib/workflow/orchestrator.mjs';
import { validateDiagnosisResult } from '../lib/workflow/bug-handoff.mjs';
import {
  evaluateGuard,
  resolveActiveAgent,
  evaluateTddPreCondition,
  applyTddGuardTransition,
  isSourceEditTool,
  toPreToolUseOutput,
  DEFAULT_TEST_GLOBS,
  INITIAL_TDD_GUARD,
} from '../lib/gate-guard-core.mjs';
import { firstToolInputPath, namedPaths } from '../lib/hooks/tool-input.mjs';

/** @typedef {import('../lib/gate-guard-core.mjs').HookPayload} HookPayload */
/** @typedef {import('../lib/gate-guard-core.mjs').GuardDecision} GuardDecision */

/**
 * Reads all of stdin synchronously, returns as a UTF-8 string.
 * @returns {string}
 */
function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(4096);
  let n;
  try {
    while ((n = readSync(0, buf, 0, buf.length, null)) > 0) {
      // Copy, do not view. `buf` is reused on every iteration and
      // Buffer.prototype.slice/subarray return a VIEW over its memory, so
      // retaining one means every earlier chunk shows the LAST read's bytes.
      // Payloads of 4096 bytes or less read in one pass and were unaffected;
      // anything larger — a runSubagent prompt, a big Write — concatenated to
      // garbage of the right length, failed JSON.parse, and hit the fail-closed
      // "malformed JSON in hook payload" deny below. Every tool call over 4KB
      // was blocked.
      // @bounded-alloc — one Buffer per 4KB stdin pass; bounded by the piped
      // hook payload, exactly as in the async readers (scripts/diagnose-handoff.mjs).
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch (_) {
    // EOF or pipe closed — expected
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Extract HookPayload fields from a raw stdin JSON object.
 * @param {unknown} raw
 * @returns {HookPayload}
 */
function extractPayload(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tool_name: '' };
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @type {HookPayload} */
  const payload = {
    tool_name: typeof obj['tool_name'] === 'string' ? obj['tool_name'] : '',
  };
  // cwd: the ONLY root-bearing field a real payload carries (optional even
  // then). The guard used to ignore it entirely and read every .devmate/ path
  // relative to process cwd — so with cwd = the workspace's own .devmate/
  // folder it looked for .devmate/.devmate/devmate.config.json, concluded the
  // repo was uninitialized, and (once #74 made edits recognizable) would have
  // denied every edit in an initialized workspace (#76).
  if (typeof obj['cwd'] === 'string' && obj['cwd'] !== '') payload.cwd = obj['cwd'];

  // Extract path and command from tool_input
  if (
    obj['tool_input'] !== null &&
    typeof obj['tool_input'] === 'object' &&
    !Array.isArray(obj['tool_input'])
  ) {
    const ti = /** @type {Record<string, unknown>} */ (obj['tool_input']);
    // Where the target path lives is owned by lib/hooks/tool-input.mjs — one
    // parser, because five private ones disagreed and four of them were wrong.
    const firstPath = firstToolInputPath(ti);
    if (firstPath !== undefined) payload.path = firstPath;
    // Every gateable path the input names, under ANY key — how an unrecognized
    // tool is classified (#94). Always set (possibly []) when a tool_input
    // exists: an empty list is the positive finding "this call names no file the
    // guard protects", which is what lets an MCP tool run. Left UNSET when the
    // payload carries no tool_input at all, because then nothing was inspected
    // and isSourceEditTool must fail closed rather than read an absence as an
    // all-clear.
    payload.namedPaths = namedPaths(ti);
    if (typeof ti['command'] === 'string') payload.command = ti['command'];
    // HITL-1, first layer: a runSubagent dispatch names its target agent in
    // tool_input. `agentName` is [UNVERIFIED] — it is a field of the *tool's*
    // input schema, not of the hook payload, and no captured runSubagent payload
    // exists yet (test/fixtures/hook-payloads/README.md says how to get one).
    // This layer is therefore best-effort: absent the key it fails open, and the
    // structural gate is the SubagentStart guard, which reads `agent_type` —
    // a field the host demonstrably sends.
    if (payload.tool_name === 'runSubagent' && typeof ti['agentName'] === 'string') {
      payload.agentName = ti['agentName'];
    }
  }

  return payload;
}

/**
 * Read and validate diagnosis.json under the resolved workspace root for the
 * lane-gated dispatch check. Returns false on any read/parse/validation
 * failure — never throws.
 * @param {string} root  Absolute workspace root (resolveHookRoot).
 * @returns {boolean}
 */
function readDiagnosisValid(root) {
  try {
    const raw = readTextFileSync(resolvePath(root, '.devmate/state/diagnosis.json'));
    return validateDiagnosisResult(JSON.parse(raw)).ok;
  } catch (_err) {
    return false;
  }
}

/**
 * Main entrypoint for the gate-guard PreToolUse hook.
 * Reads hook payload from stdin, evaluates the guard, writes GuardDecision JSON to stdout.
 * Always exits 0 — deny is communicated via the JSON payload, not the exit code.
 * @param {string[]} _args  CLI args (unused; hook input comes from stdin).
 * @returns {Promise<number>}
 */
export async function main(_args) {
  let rawInput = '';
  try {
    rawInput = readStdinSync();
  } catch (_) {
    process.stdout.write(
      JSON.stringify(
        toPreToolUseOutput({
          decision: 'deny',
          reason: 'Gate guard: failed to read hook payload from stdin.',
        })
      ) + '\n'
    );
    return 0;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawInput.trim() || '{}');
  } catch (_) {
    process.stdout.write(
      JSON.stringify(
        toPreToolUseOutput({
          decision: 'deny',
          reason: 'Gate guard: malformed JSON in hook payload.',
        })
      ) + '\n'
    );
    return 0;
  }

  const payload = extractPayload(parsed);
  // One root, resolved once from the payload, threaded into every read and
  // write below. Nothing in this hook may touch a cwd-relative .devmate/ path.
  const root = resolveHookRoot(payload);
  const statePath = resolvePath(root, '.devmate/state/task.json');
  const stateResult = readTaskState(statePath);
  let state = stateResult.ok ? stateResult.state : null;
  const configResult = loadDevmateConfig(resolvePath(root, '.devmate/devmate.config.json'), root);

  // No persona is resolved here, and none can be: a PreToolUse payload carries
  // no agent identity at all (captured fixture), so an edit cannot be attributed
  // to one of several concurrent workers. The per-worker boundary is checked at
  // completion instead — hooks/post-tool-use.mjs, where a dispatch's persona and
  // its changedFiles arrive together (#99). What bounds an edit HERE is the
  // task's scope contract (Rule 6), which needs no identity.

  // P06: load the unified scope.md contract for this task (best-effort —
  // any read/parse failure leaves scope undefined, which is a no-op).
  let scope;
  if (state !== null) {
    const loaded = await readScopeForTask(state.taskId, { repoRoot: root }).catch(() => null);
    if (loaded !== null) scope = loaded;
  }

  // E12-2 side effect: persist the next guard state before evaluateGuard so the
  // non-test write counter advances even when the current attempt is denied.
  if (
    state !== null &&
    configResult.ok &&
    state.workflowGate === 'impl-started' &&
    isSourceEditTool(payload.tool_name, payload.command, payload.namedPaths) &&
    typeof payload.path === 'string' &&
    payload.path !== ''
  ) {
    const prev = state.tddGuard ?? { ...INITIAL_TDD_GUARD };
    const testGlobs = configResult.config.testGlobs ?? DEFAULT_TEST_GLOBS.slice();
    const tdd = evaluateTddPreCondition(payload.path, prev, testGlobs);
    const next = applyTddGuardTransition(prev, tdd, payload.path, testGlobs);
    if (next !== prev) {
      try {
        state = { ...state, tddGuard: next };
        await writeTaskState(state, statePath);
      } catch (_err) {
        // Persistence is best-effort; never crash the hook.
      }
    }
  }

  // E9-08: a persisted budget-critical marker blocks non-cleanup source edits
  // until compaction clears it (best-effort read; malformed marker = absent).
  /** @type {import('../lib/types.mjs').BudgetCriticalMarker|null} */
  let budgetCritical = null;
  try {
    budgetCritical = JSON.parse(readTextFileSync(resolvePath(root, '.devmate/state/budget-critical.json')));
  } catch (_err) {
    budgetCritical = null;
  }

  // HITL-1: lane-gated implementation dispatch (PreToolUse layer). A runSubagent
  // call targeting an implementation agent (fullstack + persona wrappers) is
  // denied unless the lane's gate and artifacts exist. Fails open when the
  // payload carries no agent name (isImplementationDispatch → false), so analysis
  // dispatches and non-dispatch tools fall through untouched; the SubagentStart
  // budget guard is the independent second layer.
  if (isImplementationDispatch(payload.agentName)) {
    const scopeFacts = { present: scope != null, nonEmpty: scope != null };
    const diagnosisValid =
      state !== null && normalizeLane(state.lane) === 'bug'
        ? readDiagnosisValid(root)
        : false;
    const verdict = evaluateImplementationDispatch({
      agentName: payload.agentName,
      stateResult,
      scope: scopeFacts,
      diagnosisValid,
    });
    if (verdict.decision === 'denied') {
      process.stdout.write(
        JSON.stringify(
          toPreToolUseOutput({ decision: 'deny', reason: verdict.reason })
        ) + '\n',
      );
      return 0;
    }
  }

  // #93: the session-artifact rule's three inputs, supplied at last. They had NO
  // producer anywhere in the repo — `sessionArtifactPaths` was `[]` and
  // `activeAgent` `undefined` on every real call — so Rule 4 never ran and any
  // agent could rewrite the approved spec and the gate state itself. The paths
  // come from devmate.config.json (protective defaults when unset); the identity
  // comes from the roster the SubagentStart hook stamps onto task.json from the
  // host's own `agent_type`.
  const artifactPolicy = resolveSessionArtifactPolicy(
    configResult.ok ? configResult.config : null,
  );
  const active = resolveActiveAgent(state);

  const decision = evaluateGuard(payload, state, configResult, {
    scope,
    budgetCritical,
    sessionArtifactPaths: artifactPolicy.paths,
    sessionArtifactWriters: artifactPolicy.writers,
    activeAgent: active.agent,
    activeAgentAmbiguous: active.ambiguous,
  });

  process.stdout.write(JSON.stringify(toPreToolUseOutput(decision)) + '\n');
  return 0;
}

// Only run when executed directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
