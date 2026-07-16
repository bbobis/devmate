// @ts-check

import path from 'node:path';
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { resolveHookRoot } from '../lib/init/repo-root.mjs';
import { readTaskState } from '../lib/task-state.mjs';
import { TASK_ID_RE } from '../lib/memory/paths.mjs';
import { assertWithinRoot, readTextFile } from '../lib/fs-safe.mjs';
import { EXIT_BLOCK } from '../lib/hooks/output-schema.mjs';
import { firstToolInputPath } from '../lib/hooks/tool-input.mjs';
import { appendTraceEvent } from '../lib/trace/append.mjs';
import {
  validateCritiqueResult,
  validateDiagnosisResult,
  validateGrillResult,
  validateWorkerReturn,
} from '../lib/workflow/contracts.mjs';
import { validateDiscoveryArtifact } from '../lib/workflow/agents/discovery.mjs';
import { verifyPointer } from '../lib/context/evidence-pack.mjs';

/** @typedef {import('../lib/types.mjs').HookPayload} HookPayload */

/** @type {string} */
const STEP_ID = 'contract-validator';

/**
 * @typedef {Object} ContractRoute
 * @property {string} contractName
 * @property {(artifact: unknown) => { ok: boolean, errors: string[] }} validator
 */

/**
 * Path-suffix routing table used by the PostToolUse contract validator hook.
 * @type {Record<string, ContractRoute>}
 */
export const CONTRACT_ROUTES = {
  '.devmate/state/worker-returns/*.json': {
    contractName: 'WorkerReturn',
    validator: validateWorkerReturn,
  },
  '.devmate/state/diagnosis.json': {
    contractName: 'DiagnosisResult',
    validator: validateDiagnosisResult,
  },
  '.devmate/state/grill-result.json': {
    contractName: 'GrillResult',
    validator: validateGrillResult,
  },
  '.devmate/state/critique-result.json': {
    contractName: 'CritiqueResult',
    validator: validateCritiqueResult,
  },
  // FO-5: the merged discovery artifact gets the same live PostToolUse
  // validation (and E9-18 pointer resolution) as every other contract
  // artifact — the fan-in's output is never trusted on shape alone.
  '.devmate/state/discovery-merged.json': {
    contractName: 'MergedDiscoveryArtifact',
    validator: validateDiscoveryArtifact,
  },
};

/**
 * Read the entire stdin stream as UTF-8 text.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function readAll(stream) {
  return new Promise((resolveStream, rejectStream) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on('data', (/** @type {Buffer | string} */ chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    stream.on('end', () => resolveStream(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', rejectStream);
  });
}

/**
 * @param {string} maybePath
 * @returns {ContractRoute|null}
 */
function selectRoute(maybePath) {
  const normalized = maybePath.replace(/\\/g, '/');
  if (normalized.includes('/.devmate/state/worker-returns/') && normalized.endsWith('.json')) {
    return CONTRACT_ROUTES['.devmate/state/worker-returns/*.json'];
  }
  for (const [suffix, route] of Object.entries(CONTRACT_ROUTES)) {
    if (normalized.endsWith(suffix)) return route;
  }
  return null;
}

/**
 * The path of the file the tool just wrote.
 *
 * This read is the whole hook. It looked for `path` — at the top level, then in
 * `tool_input` — and VS Code sends neither: the write tools (`create_file`,
 * `replace_string_in_file`, `insert_edit_into_file`) name their target
 * `tool_input.filePath`. So `extractPath` returned `undefined` on every real
 * payload, `main()` took its `if (!artifactPath) return 0` early-out, and the
 * PostToolUse contract validator — the layer that is supposed to make a
 * malformed worker return impossible to ignore — validated **nothing**, for the
 * plugin's entire life (#77). It was not weakly enforced; it never ran.
 * @param {unknown} payload
 * @returns {string|undefined}
 */
function extractPath(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const p = /** @type {Record<string, unknown>} */ (payload);
  return firstToolInputPath(p['tool_input']);
}

/**
 * Resolve the workspace root for this hook invocation — from `cwd`, the only
 * root-bearing field any hook payload carries.
 *
 * There used to be a `workspaceRoot` override here "for tests". No host sends
 * that key, so it existed solely to let the suite hand this hook a root the
 * production path could never receive — which is precisely how the real
 * resolution stayed broken while the tests stayed green. The suite now passes
 * `cwd`, like VS Code does, and exercises the same code the user runs.
 * @param {unknown} payload
 * @returns {string}
 */
function extractWorkspaceRoot(payload) {
  if (payload !== null && typeof payload === 'object') {
    return resolveHookRoot(/** @type {{ cwd?: string }} */ (payload));
  }
  return resolveHookRoot();
}

/**
 * Best-effort taskId for a violation trace: prefer the artifact's own claim,
 * else the active task.json under the resolved root, else null — and a null
 * means SKIP the trace append. The old code laundered the literal 'unknown'
 * through it, minting `unknown.jsonl` (#76); the violation itself still
 * reaches stderr and the exit code either way.
 *
 * The artifact is a WORKER-WRITTEN file — untrusted input. Its taskId becomes
 * a filename (`traceFilePath` path-joins `${taskId}.jsonl`), so a crafted id
 * carrying separators or `..` would write outside the trace directory. Only an
 * id matching the canonical filesystem-safe TASK_ID_RE is accepted; anything
 * else falls through to task.json, then to skipping the trace.
 * @param {unknown} parsed  Parsed artifact (may carry its own taskId).
 * @param {string} workspaceRoot
 * @returns {string|null}
 */
function violationTaskId(parsed, workspaceRoot) {
  if (parsed !== null && typeof parsed === 'object') {
    const claimed = /** @type {Record<string, unknown>} */ (parsed)['taskId'];
    if (typeof claimed === 'string' && TASK_ID_RE.test(claimed) && claimed !== 'unknown') {
      return claimed;
    }
  }
  const stateResult = readTaskState(path.resolve(workspaceRoot, '.devmate/state/task.json'));
  if (!stateResult.ok) return null;
  // Same rule for the state-sourced id: it is devmate-written, but the trace
  // path must never be buildable from anything that fails the canonical shape.
  return TASK_ID_RE.test(stateResult.state.taskId) ? stateResult.state.taskId : null;
}

/**
 * @param {string} contractName
 * @param {string} artifactPath
 * @param {string[]} errors
 * @returns {string}
 */
function formatViolation(contractName, artifactPath, errors) {
  return [
    '[contract-validator] contract violation',
    `contract: ${contractName}`,
    `path: ${artifactPath}`,
    ...errors.map((e) => `- ${e}`),
  ].join('\n');
}

/**
 * @param {string} workspaceRoot
 * @param {string} taskId
 * @param {string} contractName
 * @param {string} artifactPath
 * @param {string[]} errors
 * @returns {Promise<void>}
 */
async function appendViolationTrace(
  workspaceRoot,
  taskId,
  contractName,
  artifactPath,
  errors,
) {
  await appendTraceEvent(
    {
      type: 'contract_violation',
      taskId,
      stepId: STEP_ID,
      ts: new Date().toISOString(),
      schemaVersion: 1,
      contract: contractName,
      path: artifactPath,
      errors,
    },
    { root: workspaceRoot },
  );
}

/**
 * True when a value looks like an EvidencePointer-bearing claim:
 * a string `path` plus a `lineRange` that is null or a [start, end] pair.
 * Non-file kinds (url/trace/tool-output) are not file-verifiable and are
 * skipped.
 * @param {unknown} value
 * @returns {value is { path: string, lineRange: [number, number]|null, kind?: string }}
 */
function isFilePointerShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v['path'] !== 'string' || v['path'] === '') return false;
  if (!('lineRange' in v)) return false;
  const lr = v['lineRange'];
  const validRange =
    lr === null ||
    (Array.isArray(lr) && lr.length === 2 && lr.every((n) => typeof n === 'number'));
  if (!validRange) return false;
  const kind = v['kind'];
  if (kind !== undefined && kind !== 'file') return false;
  return true;
}

/**
 * Recursively collect every file-pointer-shaped object in an artifact.
 * @param {unknown} node
 * @param {Array<{ path: string, lineRange: [number, number]|null }>} acc
 * @returns {Array<{ path: string, lineRange: [number, number]|null }>}
 */
function collectFilePointers(node, acc = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectFilePointers(item, acc);
    return acc;
  }
  if (node === null || typeof node !== 'object') return acc;
  if (isFilePointerShape(node)) {
    acc.push({ path: node.path, lineRange: node.lineRange });
    return acc;
  }
  for (const value of Object.values(/** @type {Record<string, unknown>} */ (node))) {
    collectFilePointers(value, acc);
  }
  return acc;
}

/**
 * E9-18 read-before-assert: verify every file pointer in the artifact
 * resolves to a real, in-range slice. Relative paths resolve against the
 * workspace root. Returns human-readable errors naming each bad pointer.
 * TODO: confirm reject-vs-tag policy after E7 grounding evals — provisional
 * (current policy: reject the write).
 * @param {unknown} artifact
 * @param {string} workspaceRoot
 * @returns {Promise<string[]>}
 */
async function verifyArtifactPointers(artifact, workspaceRoot) {
  /** @type {string[]} */
  const errors = [];
  const base = path.resolve(workspaceRoot);
  for (const pointer of collectFilePointers(artifact)) {
    /** @type {string} */
    let absPath;
    if (path.isAbsolute(pointer.path)) {
      absPath = pointer.path;
    } else {
      // Containment: a relative pointer must stay inside the workspace —
      // traversal outside it fails verification (fail closed).
      // assertWithinRoot resolves against the root and throws on escape.
      try {
        absPath = assertWithinRoot(base, pointer.path);
      } catch {
        errors.push(
          `read-before-assert: pointer "${pointer.path}" escapes the workspace root — refusing to verify.`
        );
        continue;
      }
    }
    const verdict = await verifyPointer(
      /** @type {import('../lib/types.mjs').EvidencePointer} */ ({
        path: absPath,
        lineRange: pointer.lineRange,
        reason: 'read-before-assert verification',
        confidence: 1,
        freshness: new Date().toISOString(),
        kind: 'file',
      })
    );
    if (!verdict.ok) {
      const range = pointer.lineRange === null ? 'whole file' : `lines ${pointer.lineRange.join('-')}`;
      errors.push(
        `read-before-assert: pointer "${pointer.path}" (${range}) does not resolve: ${verdict.error}`
      );
    }
  }
  return errors;
}

/**
 * Validate the artifact a tool just wrote, and **halt the lane** when it fails.
 *
 * Exit codes are the contract here, and they were wrong. VS Code reads exit `2`
 * as "blocking error: stop processing and show the error to the model" — and any
 * *other* non-zero as a non-blocking warning that the run simply continues past.
 * This hook returned `1`. So even in the counterfactual where it had found the
 * artifact (it could not — see {@link extractPath}), a malformed worker return
 * would have produced a warning in a log and a lane that carried on regardless.
 * Fail-closed was the entire point of the layer.
 *
 * The violation detail goes to **stderr**, which is exactly the stream the host
 * shows the model on a blocking exit — so the agent can see what to fix.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} _stdout  Unused: on a non-zero exit the host does not parse stdout.
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<number>}
 */
export async function runWithIO(stdin, _stdout, stderr) {
  let payload;
  let raw = '';
  try {
    raw = await readAll(stdin);
    if (raw.trim() === '') return 0;
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }

  try {
    const artifactPath = extractPath(payload);
    if (!artifactPath) return 0;

    const route = selectRoute(artifactPath);
    if (!route) return 0;

    const workspaceRoot = extractWorkspaceRoot(payload);
    const absolutePath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(workspaceRoot, artifactPath);

    let parsed;
    try {
      parsed = JSON.parse(await readTextFile(absolutePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errors = [`artifact could not be read/parsed: ${message}`];
      stderr.write(formatViolation(route.contractName, absolutePath, errors) + '\n');
      const readFailTaskId = violationTaskId(null, workspaceRoot);
      if (readFailTaskId !== null) {
        await appendViolationTrace(
          workspaceRoot,
          readFailTaskId,
          route.contractName,
          absolutePath,
          errors,
        ).catch(() => {});
      }
      return EXIT_BLOCK;
    }

    const result = route.validator(parsed);
    if (result.ok) {
      // E9-18: shape-valid artifacts must also pass read-before-assert —
      // every cited file pointer has to resolve to a real, in-range slice.
      const pointerErrors = await verifyArtifactPointers(parsed, workspaceRoot);
      if (pointerErrors.length === 0) return 0;
      stderr.write(formatViolation(route.contractName, absolutePath, pointerErrors) + '\n');
      const pointerTaskId = violationTaskId(parsed, workspaceRoot);
      if (pointerTaskId !== null) {
        await appendViolationTrace(
          workspaceRoot,
          pointerTaskId,
          route.contractName,
          absolutePath,
          pointerErrors,
        ).catch(() => {});
      }
      return EXIT_BLOCK;
    }

    stderr.write(
      formatViolation(route.contractName, absolutePath, result.errors) + '\n',
    );
    const taskId = violationTaskId(parsed, workspaceRoot);
    if (taskId !== null) {
      await appendViolationTrace(
        workspaceRoot,
        taskId,
        route.contractName,
        absolutePath,
        result.errors,
      ).catch(() => {});
    }
    return EXIT_BLOCK;
  } catch {
    return 0;
  }
}

/**
 * @param {string[]} _args
 * @returns {Promise<number>}
 */
export async function main(_args) {
  return runWithIO(process.stdin, process.stdout, process.stderr);
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
