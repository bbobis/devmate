// @ts-check
/**
 * The VS Code agent-hook OUTPUT contract — the single place devmate meets the
 * host on stdout.
 *
 * ## Why this module exists
 *
 * devmate computed correct verdicts for years and then threw them away, because
 * it wrote them in shapes the host does not read. #74 fixed that for PreToolUse
 * alone; the same defect was still live on four other events. The fix is not
 * "remember the right shape at each call site" — it is to make the call sites
 * unable to emit a wrong one. Every hook entrypoint now ends in
 * {@link writeHookOutput}, and every blocking verdict is built by a function
 * here.
 *
 * ## Ground truth (VS Code docs, GitHub Copilot in VS Code — the only surface
 * devmate targets)
 *
 * Exit codes — https://code.visualstudio.com/docs/agent-customization/hooks:
 *   - `0`  Success: **stdout is parsed as JSON.**
 *   - `2`  Blocking error: stop processing and **show the error to the model**;
 *          the hook's **stderr** is the channel that reaches it.
 *   - any other non-zero: non-blocking warning shown to the user; the run
 *          continues. **stdout is not parsed.**
 *
 * The single most important consequence, and the bug class this module closes:
 * *a non-zero exit other than 2 does not block anything, and on any non-zero
 * exit nobody reads stdout.* A hook that means to block must either exit 2 or
 * exit 0 with a documented blocking field.
 *
 * Common output format (valid on every event):
 *   `{ "continue": false, "stopReason": "...", "systemMessage": "..." }`
 *   `continue: false` stops processing; `stopReason` is shown to the user when
 *   it does; `systemMessage` is a user-visible warning.
 *
 * Per-event `hookSpecificOutput`
 * (https://code.visualstudio.com/docs/agents/reference/hooks-reference):
 *
 * | Event            | Blocking channel                        | Context channel     |
 * | ---------------- | --------------------------------------- | ------------------- |
 * | PreToolUse       | `permissionDecision: allow\|deny\|ask`   | `additionalContext` |
 * | PostToolUse      | top-level `decision: "block"` + `reason` | `additionalContext` |
 * | SubagentStop     | top-level `decision: "block"` + `reason` | —                   |
 * | Stop             | top-level `decision: "block"` + `reason` | —                   |
 * | SessionStart     | —                                       | `additionalContext` |
 * | SubagentStart    | **none documented**                     | `additionalContext` |
 * | UserPromptSubmit | common format only                      | see note            |
 * | PreCompact       | common format only                      | —                   |
 *
 * Two events therefore have no per-event blocking field. A fail-closed gate on
 * `SubagentStart` (HITL-1) must use the mechanisms that *are* documented for
 * every event: `continue: false` **and** exit 2. It emits both, deliberately —
 * see {@link stopProcessingOutput}.
 *
 * `additionalContext` on `UserPromptSubmit` is the one field devmate emits that
 * the VS Code reference does not list for that event (it says "common output
 * format only"). It is a real field in the host's vocabulary — four other
 * events carry it — and VS Code states it "uses the same hook format as Claude
 * Code and Copilot CLI for compatibility", where the field is honored. It is
 * marked `[UNVERIFIED]` and is benign if ignored: the alternative,
 * `systemMessage`, would push the state anchor into a user-visible warning on
 * every turn. Confirm it with a captured session and drop this note; the change
 * is one line, here.
 */

import { Writable } from 'node:stream';

/**
 * The event names themselves are owned by lib/hooks/registry.mjs
 * (`OFFICIAL_HOOK_EVENTS`) and typed in lib/types.mjs. This module owns only
 * what devmate may *say back* on each one.
 * @typedef {import('../types.mjs').HookEvent} HookEventName
 */

/**
 * What the host will actually DO with a hook's output. The conformance suite
 * asserts on this, not on the bytes — a guard that means to deny must produce
 * `'block'`, whichever documented channel it chose.
 * @typedef {'block'|'ask'|'allow'|'warn'|'none'} HookEffect
 */

/**
 * Result of checking one hook's real output against the contract.
 * @typedef {Object} HookOutputCheck
 * @property {boolean}    ok       False when `errors` is non-empty.
 * @property {string[]}   errors   Contract violations — the host would drop or
 *                                 misread this output.
 * @property {string[]}   warnings Tolerated deviations (keys the host ignores).
 * @property {HookEffect} effect   What the host does with it.
 */

/** Exit 0 — the host parses stdout as JSON. */
export const EXIT_OK = 0;
/** Exit 2 — the only exit code that blocks; stderr is shown to the model. */
export const EXIT_BLOCK = 2;

/** Events that block with a top-level `decision: "block"`. @type {readonly string[]} */
const DECISION_BLOCK_EVENTS = Object.freeze(['PostToolUse', 'SubagentStop', 'Stop']);

/** Events whose `hookSpecificOutput` documents `additionalContext`. @type {readonly string[]} */
const CONTEXT_EVENTS = Object.freeze([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  // [UNVERIFIED] — see the module docstring.
  'UserPromptSubmit',
]);

/** Values the host accepts for PreToolUse's permissionDecision. @type {readonly string[]} */
const PERMISSION_DECISIONS = Object.freeze(['allow', 'deny', 'ask']);

/**
 * Build the PreToolUse permission verdict — the only shape VS Code reads on
 * this event. A bare `{decision}` (devmate's shape until #74) is silently
 * ignored, which is how the gate guard denied nothing for the plugin's whole
 * life.
 * @param {{ decision: 'allow'|'deny'|'ask', reason?: string }} verdict
 * @returns {Record<string, unknown>}
 */
export function preToolUseOutput(verdict) {
  /** @type {Record<string, unknown>} */
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: verdict.decision,
  };
  if (verdict.reason !== undefined && verdict.reason !== '') {
    hookSpecificOutput['permissionDecisionReason'] = verdict.reason;
  }
  return { hookSpecificOutput };
}

/**
 * Build a top-level block for the events that document one (PostToolUse,
 * SubagentStop, Stop). `reason` is what the model is shown; `detail` rides
 * along as context when the reason is a terse machine code.
 * @param {HookEventName} event
 * @param {string} reason
 * @param {string} [detail]
 * @returns {Record<string, unknown>}
 */
export function blockOutput(event, reason, detail) {
  if (!DECISION_BLOCK_EVENTS.includes(event)) {
    throw new Error(
      `blockOutput: ${event} documents no top-level decision; use stopProcessingOutput() + exit ${EXIT_BLOCK}`,
    );
  }
  /** @type {Record<string, unknown>} */
  const out = { decision: 'block', reason };
  if (CONTEXT_EVENTS.includes(event)) {
    out['hookSpecificOutput'] = {
      hookEventName: event,
      additionalContext: detail ?? reason,
    };
  }
  return out;
}

/**
 * Build the universal stop — for events with no per-event blocking field
 * (SubagentStart). Emit this on stdout AND exit {@link EXIT_BLOCK} with the
 * reason on stderr.
 *
 * Belt and braces is the correct call here, not hedging: `continue: false` and
 * exit 2 are each independently documented as stopping the run, VS Code
 * documents neither a `permissionDecision` nor a `decision` for SubagentStart,
 * and this is the gate that keeps an implementation agent from starting before
 * a human approves the spec. Every path leads to "blocked"; none leads to
 * "silently allowed".
 * @param {string} reason
 * @returns {Record<string, unknown>}
 */
export function stopProcessingOutput(reason) {
  return { continue: false, stopReason: reason, systemMessage: reason };
}

/**
 * Build the context envelope for an event that carries one. Returns `null` when
 * the event documents no context channel, so the caller routes the text to
 * stderr instead of inventing a field.
 * @param {HookEventName} event
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
export function contextOutput(event, text) {
  if (text.trim() === '') return null;
  if (!CONTEXT_EVENTS.includes(event)) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/**
 * Parse stdout the way the host does: exactly one JSON document, or nothing.
 * Two JSON objects on two lines is not "two messages" — it is a parse failure,
 * and the host drops the whole thing.
 * @param {string} stdout
 * @returns {{ json: Record<string, unknown>|null, error: string|null }}
 */
function parseSingleJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === '') return { json: null, error: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { json: null, error: 'stdout is JSON but not an object; the host reads an object' };
    }
    return { json: /** @type {Record<string, unknown>} */ (parsed), error: null };
  } catch {
    const firstLine = trimmed.split('\n', 1)[0] ?? '';
    const hint = trimmed.includes('\n')
      ? 'stdout is not a single JSON document (multiple lines / mixed text+JSON) — the host parses stdout as ONE JSON value and drops everything on failure'
      : 'stdout is not JSON — on exit 0 the host parses stdout as JSON, so this output is dropped';
    return { json: null, error: `${hint}. First line: ${JSON.stringify(firstLine.slice(0, 120))}` };
  }
}

/**
 * Check one hook invocation's real output against the VS Code contract, and
 * report what the host will do with it.
 *
 * Hard errors are reserved for output the host would **drop or misread**:
 * invalid JSON on exit 0, a key from the host's own vocabulary carrying a value
 * or an event it does not honor, or a `reason` with no decision to attach to.
 * Keys the host simply does not know (devmate's internal result objects, e.g.
 * `ok` / `fact`) are warnings: they ride along harmlessly.
 *
 * @param {HookEventName} event
 * @param {string} stdout
 * @param {number} exitCode
 * @returns {HookOutputCheck}
 */
export function validateHookOutput(event, stdout, exitCode) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const { json, error } = parseSingleJson(stdout);

  if (exitCode !== EXIT_OK && stdout.trim() !== '') {
    // Not fatal on its own, but it means the payload is inert: the host only
    // parses stdout on exit 0. This is how the budget guard's critical warning
    // reached nobody.
    warnings.push(
      `exited ${exitCode} with output on stdout — the host only parses stdout on exit 0; use stderr for a non-zero exit`,
    );
  } else if (error !== null) {
    errors.push(error);
  }

  if (json !== null) {
    const decision = json['decision'];
    if (decision !== undefined) {
      if (!DECISION_BLOCK_EVENTS.includes(event)) {
        errors.push(
          `top-level "decision" is not honored on ${event} (documented on ${DECISION_BLOCK_EVENTS.join('/')}); this verdict is dropped`,
        );
      } else if (decision !== 'block') {
        errors.push(`decision must be "block" on ${event}, got ${JSON.stringify(decision)}`);
      }
    }
    if (json['reason'] !== undefined && decision !== 'block') {
      errors.push('"reason" without decision:"block" does nothing — the host reads it only when blocking');
    }

    const hso = json['hookSpecificOutput'];
    if (hso !== undefined) {
      if (hso === null || typeof hso !== 'object' || Array.isArray(hso)) {
        errors.push('hookSpecificOutput must be an object');
      } else {
        const h = /** @type {Record<string, unknown>} */ (hso);
        const name = h['hookEventName'];
        if (name !== undefined && name !== event) {
          errors.push(
            `hookSpecificOutput.hookEventName is ${JSON.stringify(name)} but the event is ${event}`,
          );
        }
        const pd = h['permissionDecision'];
        if (pd !== undefined) {
          if (event !== 'PreToolUse') {
            errors.push(`permissionDecision is only honored on PreToolUse, not ${event}`);
          } else if (typeof pd !== 'string' || !PERMISSION_DECISIONS.includes(pd)) {
            errors.push(
              `permissionDecision must be one of ${PERMISSION_DECISIONS.join('|')}, got ${JSON.stringify(pd)}`,
            );
          }
        }
        if (h['additionalContext'] !== undefined && !CONTEXT_EVENTS.includes(event)) {
          warnings.push(`additionalContext is not documented on ${event}; it may be ignored`);
        }
      }
    }

    // @bounded-alloc — one entry per top-level key of a hook's own stdout JSON.
    const known = ['continue', 'stopReason', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput'];
    for (const key of Object.keys(json)) {
      if (!known.includes(key)) {
        warnings.push(`unknown key ${JSON.stringify(key)} — the host ignores it (harmless)`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, effect: hookEffect(event, json, exitCode) };
}

/**
 * What the host does with this output. Exit 2 blocks regardless of stdout,
 * because on a non-zero exit stdout is never parsed.
 * @param {HookEventName} event
 * @param {Record<string, unknown>|null} json
 * @param {number} exitCode
 * @returns {HookEffect}
 */
function hookEffect(event, json, exitCode) {
  if (exitCode === EXIT_BLOCK) return 'block';
  if (exitCode !== EXIT_OK) return 'warn';
  if (json === null) return 'none';
  if (json['continue'] === false) return 'block';
  if (DECISION_BLOCK_EVENTS.includes(event) && json['decision'] === 'block') return 'block';
  const hso = json['hookSpecificOutput'];
  if (event === 'PreToolUse' && hso !== null && typeof hso === 'object') {
    const pd = /** @type {Record<string, unknown>} */ (hso)['permissionDecision'];
    if (pd === 'deny') return 'block';
    if (pd === 'ask') return 'ask';
    if (pd === 'allow') return 'allow';
  }
  return 'none';
}

/**
 * A WritableStream that keeps what was written to it.
 *
 * The hook handlers print human-readable text (state anchors, skill menus,
 * warnings) to an injected stream, and their suites assert on that text. Rather
 * than rewrite every handler and its tests, the *entrypoints* hand them one of
 * these and wrap the result in the documented envelope. The contract is applied
 * exactly where the process meets the host, and nowhere else.
 * @returns {{ stream: NodeJS.WritableStream, text: () => string }}
 */
export function createTextCapture() {
  /** @type {string[]} */
  // @bounded-alloc — one entry per write() by the hook itself; hooks emit a
  // handful of lines and the process exits immediately after.
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * Emit a hook's output in the shape the host reads, and return the exit code to
 * exit with. This is the boundary: an entrypoint calls it and returns its
 * value, so no hook can hand the host a shape it will drop.
 *
 * Routing:
 *   - non-zero exit → the text goes to **stderr** (on exit 2 the model sees it;
 *     on any other non-zero the user does), and stdout stays empty, because the
 *     host does not parse stdout on a non-zero exit.
 *   - exit 0, and the hook already produced one JSON document → pass it through
 *     untouched. Hooks that compute a verdict (gate guard, contract validator)
 *     build their own conforming JSON with the helpers above.
 *   - exit 0, and the hook produced human text → wrap it in the event's context
 *     envelope. If the event documents no context channel, the text goes to
 *     stderr rather than into an invented field.
 *
 * @param {HookEventName} event
 * @param {string} text          Everything the hook wrote to its stdout stream.
 * @param {number} exitCode
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {number} The exit code to return from main().
 */
export function writeHookOutput(event, text, exitCode, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  if (exitCode !== EXIT_OK) {
    if (text.trim() !== '') stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    return exitCode;
  }
  if (text.trim() === '') return exitCode;

  const { json } = parseSingleJson(text);
  if (json !== null) {
    stdout.write(`${JSON.stringify(json)}\n`);
    return exitCode;
  }

  const envelope = contextOutput(event, text);
  if (envelope === null) {
    stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    return exitCode;
  }
  stdout.write(`${JSON.stringify(envelope)}\n`);
  return exitCode;
}
