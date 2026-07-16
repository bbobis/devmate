// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';
import { createTextCapture } from '../lib/hooks/output-schema.mjs';
import { resolveRepoRoot } from '../lib/init/repo-root.mjs';
import { captureMemory } from '../lib/memory/capture.mjs';
import { captureHandoff } from '../lib/handoff/capture-handoff.mjs';
import { loadDelegationAdvisory } from '../lib/orchestrator/delegation-advisory.mjs';

/** @typedef {import('../lib/types.mjs').HookPayload} HookPayload */

/**
 * Read the entire `stdin` stream to a UTF-8 string.
 * Resolves to '' if stdin is closed or empty.
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
 * Normalize an unknown thrown value to a message string.
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the Stop handler using injectable IO (for tests).
 *
 * On a normal session end, promote the active task ledger into
 * `.devmate/state/repo/repo.jsonl` and re-render `.devmate/MEMORY.md`, so facts
 * written during the session are captured even when no PreCompact fired and
 * `complete-task` was never run — the previously-stranded normal-exit path.
 * Best-effort: any failure warns to stderr and returns 0 so a shutdown never
 * hangs or crashes.
 *
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<number>}
 */
export async function runWithIO(stdin, stdout, stderr) {
  let raw = '';
  try {
    raw = await readAll(stdin);
  } catch (/** @type {unknown} */ err) {
    stderr.write(`[session-stop] stdin read error (ignored): ${errMsg(err)}\n`);
  }

  /** @type {Partial<HookPayload>} */
  let payload = {};
  if (raw.trim() !== '') {
    try {
      payload = /** @type {Partial<HookPayload>} */ (JSON.parse(raw));
    } catch (/** @type {unknown} */ err) {
      stderr.write(`[session-stop] malformed stdin JSON (ignored): ${errMsg(err)}\n`);
    }
  }

  // Only act on Stop. Other events (if any are routed here) are no-ops.
  if (payload.hook_event_name && payload.hook_event_name !== 'Stop') {
    return 0;
  }

  const startDir = payload.cwd ?? process.cwd();
  try {
    const repoRoot = await resolveRepoRoot(startDir);
    const warn = (/** @type {string} */ msg) => stderr.write(`[session-stop] ${msg}\n`);

    const result = await captureMemory(repoRoot, { warn });
    if (result.ok && (result.promoted > 0 || result.factsRendered > 0)) {
      stdout.write(
        `${JSON.stringify({
          event: 'memory.rendered',
          promoted: result.promoted,
          factsRendered: result.factsRendered,
        })}\n`,
      );
    }

    // Write a resume handoff for an in-progress task so a fresh session can pick
    // up where this one left off (the resume plan consumes it). Best-effort.
    const handoff = await captureHandoff(repoRoot, { warn });
    if (handoff.written) {
      stdout.write(`${JSON.stringify({ event: 'handoff.written', path: handoff.path })}\n`);
    }

    // Best-effort delegation advisory: a session at a post-analysis gate with
    // zero subagent dispatches almost certainly did the work inline. Surface it
    // so a non-delegating run flags itself at session end. Never affects exit.
    const advisory = await loadDelegationAdvisory(repoRoot);
    if (advisory && advisory.inlineLikely) {
      stdout.write(
        `${JSON.stringify({
          event: 'delegation.warning',
          taskId: advisory.taskId,
          workflowGate: advisory.workflowGate,
          dispatches: advisory.totalDispatches,
        })}\n`,
      );
      warn(
        `delegation: this session is at "${advisory.workflowGate}" with 0 subagent ` +
          `dispatches — work was likely done inline. Review: ` +
          `node scripts/delegation-report.mjs --task ${advisory.taskId}`,
      );
    }
  } catch (/** @type {unknown} */ err) {
    // A capture failure must never crash the session on shutdown.
    stderr.write(`[session-stop] memory capture error (ignored): ${errMsg(err)}\n`);
  }

  return 0;
}

/**
 * Hook handler: Stop.
 * Reads the hook payload from stdin and captures memory on session end.
 * Filters internally on hook_event_name — matchers are not relied upon.
 *
 * A Stop hook has nothing to tell the host: VS Code honors only a
 * `decision: "block"` here, and devmate never blocks a session from ending. Its
 * `{event: "handoff.written"}` lines are diagnostics, so they go to stderr and
 * stdout stays empty — output the host cannot use does not belong on the channel
 * it parses.
 * @param {string[]} _args  CLI args (without node/script).
 * @returns {Promise<number>} exit code
 */
export async function main(_args) {
  const capture = createTextCapture();
  const code = await runWithIO(process.stdin, capture.stream, process.stderr);
  const diagnostics = capture.text();
  if (diagnostics.trim() !== '') process.stderr.write(diagnostics);
  return code;
}

if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
