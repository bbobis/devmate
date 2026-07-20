// @ts-check
// Pure detection for the #112 state-writer guard. `mutateTaskStateUnderLock` is
// the canonical, atomic way to change task.json; a direct `writeTaskState(` call
// is a blind write that cannot participate in optimistic concurrency and, when
// it follows a `readTaskState`, is exactly the lost-update read-modify-write the
// versioned API exists to end. Every direct caller must therefore be an
// explicitly justified exception in the allowlist. A NEW unlisted caller fails
// CI; an allowlisted path that no longer calls it (a migrated writer) is flagged
// as stale so the registry shrinks as writers move to the API.

/**
 * Matches a CALL to `writeTaskState(` — not an `import { writeTaskState }`
 * (no `(` follows there). The function's own definition matches too, so the
 * defining module is an expected allowlist entry.
 */
const WRITE_CALL_RE = /\bwriteTaskState\s*\(/;

/**
 * Matches a renamed import — `import { writeTaskState as w }` — so a caller
 * cannot dodge the guard by aliasing the primitive and calling it under a name
 * `WRITE_CALL_RE` never sees. Importing the blind writer under any name is
 * intent to call it, so the import alone justifies an allowlist entry.
 */
const ALIAS_IMPORT_RE = /\bwriteTaskState\s+as\s+\w+/;

/** Strip `//` line comments. */
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
/** Strip `/* *\/` block comments (non-greedy, spans lines). */
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * Remove comments so a mention of `writeTaskState(` in prose (this guard's own
 * tooling documents the pattern it hunts) is not mistaken for a call site. Code
 * that genuinely calls the function survives the strip.
 *
 * Deliberately lightweight and string-UNAWARE: a `//` inside a string literal
 * still starts a "comment". In practice a `writeTaskState(` call is on its own
 * line and never trails a URL-bearing string, so the residual false-negative
 * (a real call hidden after an inline `//`-containing string) does not occur in
 * this codebase; a full tokenizer would be overkill for a call-site scan.
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "");
}

/**
 * @typedef {Object} ScannedFile
 * @property {string} path  Repo-relative path (POSIX separators).
 * @property {string} text  File contents.
 */

/**
 * The repo-relative paths (POSIX separators) of files that call `writeTaskState`.
 * @param {ScannedFile[]} files
 * @returns {string[]}  Caller paths, in input order.
 */
export function findWriteTaskStateCallers(files) {
  return files
    .filter((f) => {
      const code = stripComments(f.text);
      return WRITE_CALL_RE.test(code) || ALIAS_IMPORT_RE.test(code);
    })
    .map((f) => f.path);
}

/**
 * @typedef {Object} StateWriterViolations
 * @property {string[]} unlisted  Callers not present in the allowlist — new,
 *                                unjustified direct writers. A hard failure.
 * @property {string[]} stale     Allowlist paths that no longer call
 *                                `writeTaskState` — a migrated writer whose
 *                                exception should be removed. A hard failure so
 *                                the registry cannot rot.
 */

/**
 * Diff the observed callers against the allowlist.
 * @param {string[]} callers  Output of {@link findWriteTaskStateCallers}.
 * @param {Record<string, string>} allowed  path → justification.
 * @returns {StateWriterViolations}
 */
export function computeStateWriterViolations(callers, allowed) {
  const callerSet = new Set(callers);
  const unlisted = callers.filter((p) => !Object.prototype.hasOwnProperty.call(allowed, p));
  const stale = Object.keys(allowed).filter((p) => !callerSet.has(p));
  return { unlisted, stale };
}
