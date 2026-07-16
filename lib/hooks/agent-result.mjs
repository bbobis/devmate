// @ts-check
/**
 * The single owner of "how a subagent's result is read off the wire".
 *
 * Ground truth is `test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json`:
 * a subagent's result reaches PostToolUse as `tool_response`, and that value is
 * a plain STRING holding the agent's final chat text — prose FOLLOWED BY an
 * embedded JSON object:
 *
 *   "Classifying the task by intent and scope now; I'll return a single JSON
 *    object with the lane…\n\n{\"agentName\":\"router\",\"lane\":\"feature\",…}"
 *
 * It is not a structured object, and not a `{ content: "<json>" }` wrapper.
 * Anything that did `JSON.parse(tool_response)` therefore threw and fell back to
 * null on EVERY real dispatch — which is how the TDD/persona-scope tripwire in
 * post-tool-use came to never fire.
 *
 * Identity comes from the `agentName` field INSIDE the returned JSON — devmate's
 * own output contract, which the agents honor (the captured router return carries
 * `"agentName":"router"`). It deliberately does NOT come from `tool_input`: the
 * agent log elides `runSubagent`'s `tool_input` to the literal `"..."`, so no
 * capture can confirm an `agentName` key there, and reading an unverifiable key
 * is exactly the mistake that produced five inert layers.
 */
import { parseJsonSafe } from "../json-io.mjs";
import { getOwn } from "../object-utils.mjs";

/**
 * Index of the `}` closing the object that opens at `start`, or -1.
 *
 * String-aware: a brace inside a JSON string value is not a brace. Written as a
 * scanner rather than a pattern because a regex cannot count nesting, and this repo
 * forbids building a RegExp from runtime values anyway.
 *
 * @param {string} text
 * @param {number} start  Index of the opening `{`.
 * @returns {number}
 */
function matchObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every balanced `{...}` span in the text that parses as a JSON object.
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
function jsonCandidates(text) {
  /** @type {Record<string, unknown>[]} */
  // @bounded-alloc — one entry per balanced brace span in a single agent reply.
  const found = [];

  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    const end = matchObjectEnd(text, i);
    if (end === -1) break;

    const parsed = parseJsonSafe(text.slice(i, end + 1));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      found.push(/** @type {Record<string, unknown>} */ (parsed));
    }
    i = end + 1;
  }
  return found;
}

/**
 * Pull the contract out of an agent's final text.
 *
 * The old implementation took the span from the FIRST `{` to the LAST `}` — which
 * works only for the terse return the captured fixture happens to show. A grill
 * report is not terse: it narrates, it quotes code, and prose like "the guard
 * returns `{}` for anonymous callers" puts a brace before the contract. The span
 * then covered `{}` ... `{real}`, parsed as nothing, and the entire return was
 * dropped on the floor — no worker-return file, no artifact, no gate move, and not
 * one word to the model. That is how a completed `@rubber-duck` dispatch left no
 * trace at all.
 *
 * So: find every balanced object in the message and choose between them.
 *   1. The last one that names an agent — devmate's contracts self-identify, and a
 *      later object is the conclusion where an earlier one is usually an example.
 *   2. Failing that, the richest one — a real contract has many keys; a brace in
 *      prose parses to `{}`. Ties go to the last.
 *
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
function extractEmbeddedJson(text) {
  const whole = parseJsonSafe(text);
  if (whole !== null && typeof whole === "object" && !Array.isArray(whole)) {
    return /** @type {Record<string, unknown>} */ (whole);
  }

  const candidates = jsonCandidates(text);
  if (candidates.length === 0) return null;

  /** @type {Record<string, unknown>|null} */
  let best = null;
  let bestKeys = -1;

  for (const candidate of candidates) {
    const named = typeof getOwn(candidate, "agentName") === "string";
    const bestNamed = best !== null && typeof getOwn(best, "agentName") === "string";

    // A named candidate always beats an unnamed one, however rich the unnamed one is.
    if (bestNamed && !named) continue;

    const keys = Object.keys(candidate).length;
    if (named && !bestNamed) {
      best = candidate;
      bestKeys = keys;
      continue;
    }
    if (keys >= bestKeys) {
      best = candidate;
      bestKeys = keys;
    }
  }
  return best;
}

/**
 * Extract a subagent's typed result from a PostToolUse `tool_response`.
 *
 * Accepts the verified string shape, and — defensively, since hooks are a
 * Preview API and this contract will move — a bare object or a `{ content }`
 * wrapper.
 *
 * @param {unknown} toolResponse  The raw `payload.tool_response`.
 * @returns {{ agentName: string|null, result: Record<string, unknown>|null, empty: boolean }}
 *   `empty` is true when the subagent returned nothing at all — the
 *   "Agent completed with no output" case, which must be surfaced, never
 *   silently routed around.
 */
export function extractAgentResult(toolResponse) {
  if (toolResponse === null || toolResponse === undefined) {
    return { agentName: null, result: null, empty: true };
  }

  /** @type {Record<string, unknown>|null} */
  let obj = null;

  if (typeof toolResponse === "string") {
    if (toolResponse.trim() === "") {
      return { agentName: null, result: null, empty: true };
    }
    obj = extractEmbeddedJson(toolResponse);
  } else if (typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
    const record = /** @type {Record<string, unknown>} */ (toolResponse);
    const content = getOwn(record, "content");
    obj = typeof content === "string" ? extractEmbeddedJson(content) : record;
  }

  if (obj === null) {
    // The agent said something, but not a contract. Not "empty" — a shape
    // violation, which is a different (and louder) failure.
    return { agentName: null, result: null, empty: false };
  }

  const agentName = getOwn(obj, "agentName");
  return {
    agentName: typeof agentName === "string" && agentName !== "" ? agentName : null,
    result: obj,
    empty: false,
  };
}

/**
 * The persona a `@fullstack` dispatch was shaped by, read from the worker's OWN
 * returned contract.
 *
 * This is the only channel that carries the persona to devmate, and the reason
 * is the same one that governs `agentName` above: the dispatch's `tool_input` —
 * where the persona is actually *sent* — reaches PostToolUse as the literal
 * string `"..."` (captured fixture), so `tool_input.persona` was `undefined` on
 * every real dispatch and the completion-time persona-scope check it gated never
 * ran (#99). The persona rides back the same way `changedFiles` already does: in
 * the JSON the worker returns.
 *
 * That makes it work for a persona the host could never name. `backend`,
 * `frontend` and `editor` have wrapper agents, so their names appear on the wire
 * as a `SubagentStart` `agent_type`; a consumer's own personas (`api`, `web`, …)
 * have no wrapper and dispatch as plain `@fullstack`, so no host event mentions
 * them. A self-reported persona is checked identically whatever it is called.
 *
 * Accepted at the top level (the contract's shape) or under `payload` (where a
 * worker is most likely to put it by mistake) — reading both costs nothing and
 * a persona reported in the wrong place should not silently disable a boundary.
 *
 * @param {Record<string, unknown>|null} result  The parsed contract from {@link extractAgentResult}.
 * @returns {string|undefined}  The trimmed persona, or undefined when it declared none.
 */
export function personaFromAgentResult(result) {
  if (result === null || typeof result !== "object") return undefined;

  const top = getOwn(result, "persona");
  if (typeof top === "string" && top.trim() !== "") return top.trim();

  const payload = getOwn(result, "payload");
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const nested = getOwn(/** @type {Record<string, unknown>} */ (payload), "persona");
    if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  }
  return undefined;
}
