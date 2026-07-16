// @ts-check
/**
 * Where the target path lives in a VS Code `tool_input` — the single owner of
 * that question.
 *
 * ## Why one module
 *
 * devmate had **five** answers to "which key holds the file this tool is about",
 * in five files, and they disagreed:
 *
 * | Caller | Read | Result in production |
 * | --- | --- | --- |
 * | `scripts/gate-guard.mjs` | `tool_input.path` | every path rule evaluated `''` and never fired (#74) |
 * | `hooks/contract-validator.mjs` | `path`, `tool_input.path` | never located an artifact; validated nothing |
 * | `lib/memory/fact-writer.mjs` | `tool_input.path`, `tool_input.file_path` | no source edit was ever collected into memory |
 * | `scripts/posttool-regex-guard.mjs` | `tool_input.*` scan, Claude tool names | the dynamic-RegExp guard saw only `apply_patch` |
 * | `hooks/post-tool-use.mjs` | `tool_input.filePath` | correct — and alone |
 *
 * VS Code names the target `filePath` (`read_file`, `create_file`,
 * `replace_string_in_file`, `insert_edit_into_file`, `edit_notebook_file`),
 * `dirPath` (`create_directory`), `replacements[].filePath`
 * (`multi_replace_string_in_file`), `files[]` (`edit_files`), and for
 * `apply_patch` the targets are inside the patch body rather than in a field at
 * all. It never sends `path`. Four of the five callers were reading a key that
 * does not exist, so four enforcement layers quietly did nothing — and each was
 * "fixed" separately, because nothing owned the shape.
 *
 * Adding a sixth private parser is how this bug comes back. Import from here.
 */

import { extractApplyPatchPaths, isWriteTargetToken } from '../gate-guard-core.mjs';

/**
 * Every path a `tool_input` targets, in the order VS Code's own tools declare
 * them.
 *
 * Keys are read as literals, never through a computed index: `tool_input` is
 * model-controlled tool output, so a dynamic member read on it is an
 * object-injection sink (the security lint says so, and it is right).
 *
 * @param {unknown} toolInput  Raw `tool_input` from the hook payload.
 * @returns {string[]}  Absolute or workspace-relative paths, in declaration order.
 */
export function toolInputPaths(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return [];
  }
  const ti = /** @type {Record<string, unknown>} */ (toolInput);
  /** @type {string[]} */
  // @bounded-alloc — one entry per file named by a single tool call; a
  // multi_replace_string_in_file edit names a handful, never a tree.
  const out = [];

  // 1. The single-target key the great majority of VS Code tools use.
  for (const v of [ti['filePath'], ti['dirPath']]) {
    if (typeof v === 'string' && v !== '') out.push(v);
  }

  // 2. multi_replace_string_in_file
  const replacements = ti['replacements'];
  if (Array.isArray(replacements)) {
    for (const r of replacements) {
      if (r !== null && typeof r === 'object') {
        const fp = /** @type {Record<string, unknown>} */ (r)['filePath'];
        if (typeof fp === 'string' && fp !== '') out.push(fp);
      }
    }
  }

  // 3. edit_files — a bare string array, per the VS Code hooks-reference example.
  const files = ti['files'];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (typeof f === 'string' && f !== '') out.push(f);
    }
  }

  // 4. apply_patch — the targets are in the patch body, not in a field.
  if (typeof ti['input'] === 'string') {
    out.push(...extractApplyPatchPaths(ti['input']));
  }

  return out;
}

/**
 * The first path a `tool_input` targets, or `undefined` when it names none.
 *
 * `undefined` — not `''` — so a caller can tell "this tool touches no file" from
 * "this tool touches the empty path" and fail closed on the former instead of
 * letting a path-keyed rule silently no-op against `''`. That distinction is the
 * whole of #74.
 *
 * A multi-file edit yields its FIRST target. The completion-time persona-scope
 * check in the PostToolUse hook still vets every changed file, so an edit cannot
 * smuggle an out-of-scope path past the gate behind an in-scope first entry.
 *
 * @param {unknown} toolInput
 * @returns {string|undefined}
 */
export function firstToolInputPath(toolInput) {
  return toolInputPaths(toolInput)[0];
}

/** Deepest nesting level of a `tool_input` the walk below descends into. */
const NAMED_PATHS_MAX_DEPTH = 4;

/** Ceiling on nodes visited by one walk, so a pathological input cannot spin. */
const NAMED_PATHS_MAX_NODES = 200;

/**
 * Longest string still considered a candidate path. Beyond this it is prose,
 * source content, or a diff — not a filename anyone typed.
 */
const NAMED_PATH_MAX_LENGTH = 512;

/**
 * Strip a `file://` scheme (and percent-encoding) so a URI and a plain path
 * reduce to the same token: `file:///c:/dev/lib/a.mjs` → `/c:/dev/lib/a.mjs`.
 * @param {string} value
 * @returns {string}
 */
function stripFileScheme(value) {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  const rest = trimmed.slice('file://'.length);
  try {
    return decodeURIComponent(rest);
  } catch (_err) {
    return rest;
  }
}

/**
 * Every gateable path a `tool_input` NAMES, anywhere in its shape — the signal
 * {@link import('../gate-guard-core.mjs').isSourceEditTool} classifies an
 * unrecognized tool by (#94).
 *
 * Distinct from {@link toolInputPaths}, and deliberately so. That function is the
 * authoritative *target* extractor: it reads the exact keys VS Code's own tools
 * declare, in declaration order, and the scope rules key on its first result.
 * This one is a wider *classification* signal — it also reads keys VS Code never
 * sends (`path`, `uri`, whatever an MCP server invents), because the tools it
 * exists to classify are precisely the ones devmate has no schema for. Neither
 * replaces the other, and `toolInputPaths` is unchanged.
 *
 * **Extension-anchored matching is what keeps this from crying wolf.** A value is
 * a path only if {@link isWriteTargetToken} says so — a source extension, or a
 * location under `.devmate/`. So `{query: "SELECT * FROM sessions"}` yields
 * nothing and `session_store_sql` is allowed, while `{path: "lib/a.mjs"}` and
 * `{uri: "file:///c:/dev/lib/a.mjs"}` both yield a hit and stay gated.
 *
 * Values are read with `Object.values()`, never a computed member read:
 * `tool_input` is model-controlled, so a dynamic index on it is an
 * object-injection sink.
 *
 * @param {unknown} toolInput  Raw `tool_input` from the hook payload.
 * @returns {string[]}  Gateable paths, de-duplicated, in breadth-first order.
 */
export function namedPaths(toolInput) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ value: unknown, depth: number }>} */
  // @bounded-alloc — the walk visits at most NAMED_PATHS_MAX_NODES nodes and
  // descends at most NAMED_PATHS_MAX_DEPTH levels, so both the queue and the
  // result are bounded regardless of how large or how deeply nested the
  // model-controlled tool_input is.
  const queue = [{ value: toolInput, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < NAMED_PATHS_MAX_NODES) {
    const node = queue.shift();
    if (node === undefined) break;
    visited += 1;
    const { value, depth } = node;

    if (typeof value === 'string') {
      if (value.length > NAMED_PATH_MAX_LENGTH || value.includes('\n')) continue;
      const candidate = stripFileScheme(value);
      if (candidate !== '' && isWriteTargetToken(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      continue;
    }

    if (depth >= NAMED_PATHS_MAX_DEPTH) continue;

    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) queue.push({ value: v, depth: depth + 1 });
    }
  }

  return out;
}
