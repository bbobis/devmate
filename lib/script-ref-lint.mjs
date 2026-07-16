// @ts-check
// Pure logic for the bundled-script reference lint (Fix A regression guard).
//
// Agent- and skill-facing markdown instructs the model to run devmate's
// bundled Node scripts from a terminal. Those scripts ship inside the installed
// plugin directory, reachable only through the `${PLUGIN_ROOT}` token
// (the same token hooks.json and .mcp.json use). A bare `scripts/<name>.mjs`
// resolves against the consumer workspace cwd — where no `scripts/` dir exists —
// so the command fails and the orchestrator's gate/floor enforcement silently
// never runs. This module finds those bare references so CI can reject them.

/** The plugin-root placeholder every bundled-script invocation must be anchored to. */
export const PLUGIN_ROOT_PLACEHOLDER = '${PLUGIN_ROOT}';

// A `scripts/<name>.mjs` reference at a path boundary (start of string, or a
// character that is not a word char or `/`). The token form
// `${PLUGIN_ROOT}/scripts/x.mjs` has a `/` immediately before `scripts`,
// so the boundary class `[^\w/]` excludes it — only bare references match.
const BARE_SCRIPT_REF = /(^|[^\w/])(scripts\/[a-z0-9-]+\.mjs)/g;

/**
 * @typedef {Object} ScriptRefViolation
 * @property {string} file  Repo-relative path of the offending file.
 * @property {number} line  1-based line number.
 * @property {string} ref   The bare reference, e.g. `scripts/gatectl.mjs`.
 */

/**
 * Find bundled-script references not anchored to `${PLUGIN_ROOT}/`.
 * @param {string} text  File contents.
 * @param {string} file  Repo-relative path, used for reporting.
 * @returns {ScriptRefViolation[]}
 */
export function findBareScriptRefs(text, file) {
  /** @type {ScriptRefViolation[]} */
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(BARE_SCRIPT_REF)) {
      out.push({ file, line: i + 1, ref: m[2] });
    }
  }
  return out;
}

/**
 * Format violations as a compact fixed-width table for the terminal.
 * @param {ScriptRefViolation[]} violations
 * @returns {string}
 */
export function formatScriptRefTable(violations) {
  const header = '| File | Line | Bare reference | Fix |';
  const sep = '|---|---|---|---|';
  const rows = violations.map(
    (v) => `| ${v.file} | ${v.line} | ${v.ref} | ${PLUGIN_ROOT_PLACEHOLDER}/${v.ref} |`
  );
  return [header, sep, ...rows].join('\n');
}
