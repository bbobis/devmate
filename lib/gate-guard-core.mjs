// @ts-check
// The ONLY import this module may take: a dependency-free policy table. The
// evaluator below is pure (no disk I/O) and must stay that way.
import { isEditAllowedAtGate } from './gate-edit-policy.mjs';

/** @typedef {import('./types.mjs').TaskState} TaskState */
/** @typedef {import('./types.mjs').WorkflowGate} WorkflowGate */
/** @typedef {import('./types.mjs').HookPayload} HookPayload */
/** @typedef {import('./types.mjs').GuardDecision} GuardDecision */
/** @typedef {import('./types.mjs').PersonaEntry} PersonaEntry */
/** @typedef {import('./types.mjs').DevmateConfig} DevmateConfig */
/** @typedef {import('./types.mjs').ConfigResult} ConfigResult */
/** @typedef {import('./types.mjs').TddGuardState} TddGuardState */
/** @typedef {import('./types.mjs').ParsedScope} ParsedScope */
/** @typedef {import('./types.mjs').SessionArtifactWriter} SessionArtifactWriter */

/**
 * Serialize a {@link GuardDecision} into the wire shape VS Code actually honors
 * for a PreToolUse hook.
 *
 * VS Code reads `hookSpecificOutput.permissionDecision` (allow | deny | ask). A
 * bare top-level `{decision}` — which devmate emitted until #74 — is the
 * *PostToolUse/Stop* schema and is silently ignored on PreToolUse, so the tool
 * ran anyway. Every deny the guard computed was thrown away. Keep
 * `{decision, reason}` as the evaluator's internal type; translate to the host's
 * shape here, at the boundary, exactly once.
 *
 * `additionalContext` is the PreToolUse context channel — the one way an ALLOW can
 * still teach the model (a deny teaches through `permissionDecisionReason`). It
 * carries the RC-3 sequencing advisory: the tool is allowed to run, but the model
 * is told the dispatch is out of order. Ignored on a deny (the reason already
 * carries the message) and omitted when empty.
 * @param {GuardDecision} decision
 * @param {string} [additionalContext]
 * @returns {Record<string, unknown>}
 */
export function toPreToolUseOutput(decision, additionalContext) {
  /** @type {Record<string, unknown>} */
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision.decision,
  };
  // permissionDecisionReason is required when denying, and is what the agent is
  // shown — so it is the only channel through which a deny can teach.
  if (decision.decision === 'deny') {
    hookSpecificOutput['permissionDecisionReason'] =
      decision.reason ?? 'Gate guard denied this tool call.';
  } else if (typeof additionalContext === 'string' && additionalContext.trim() !== '') {
    hookSpecificOutput['additionalContext'] = additionalContext;
  }
  return { hookSpecificOutput };
}

/**
 * Default test-file globs applied when devmate.config.json does not declare
 * a `testGlobs` array. Conservative so config-only repos do not trigger the
 * TDD pre-condition on non-source files.
 * @type {readonly string[]}
 */
export const DEFAULT_TEST_GLOBS = Object.freeze([
  '**/*.test.mjs',
  '**/*.spec.mjs',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/*.test.js',
  '**/*.spec.js',
  'test/**',
  'tests/**',
  '**/__tests__/**',
]);

/**
 * Default starting TDD guard state for new tasks.
 * @type {TddGuardState}
 */
export const INITIAL_TDD_GUARD = Object.freeze({
  testFileWritten: false,
  consecutiveNonTestWrites: 0,
  overrideGranted: false,
});

/**
 * Source-file extensions considered subject to the TDD pre-condition. Non-source
 * files (config, docs, JSON, etc.) are not counted as non-test writes even when
 * they fall outside testGlobs.
 * @type {readonly string[]}
 */
const SOURCE_FILE_EXTS = Object.freeze(['.mjs', '.ts', '.tsx', '.js', '.jsx']);

/**
 * VS Code Copilot tool names whose successful call means the agent **read the
 * contents of a file** — the subset of the read-only surface that yields an
 * evidence pointer (TCM-3). PostToolUse derives its read set from here (#95); it
 * must not keep a second, hand-authored one.
 *
 * The names are grounded in captured payloads and the `ToolName` enum, nothing
 * else. `open_file` and `view_file` were previously asserted by PostToolUse
 * alone: they appear in no captured VS Code payload, in no other list, and in no
 * VS Code tool surface — Claude-shaped names, same provenance as the five hook
 * defects #77 fixed. They are dropped rather than added, because a name PostToolUse
 * called a read while PreToolUse would have denied it as an unrecognized edit is a
 * contradiction, not a capability.
 *
 * Every name here is spread into {@link NON_SOURCE_EDIT_TOOLS} below, so a read
 * tool is structurally incapable of also being a source edit.
 * @type {readonly string[]}
 */
export const FILE_READ_TOOLS = Object.freeze([
  'read_file', 'read_notebook_cell_output',
]);

/**
 * True when a successful call to `toolName` means a file's contents were read.
 * The predicate PostToolUse gates evidence-pointer recording on.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isFileReadTool(toolName) {
  return FILE_READ_TOOLS.includes(toolName);
}

/**
 * VS Code Copilot tool names (`tool_name` wire values) that never write source
 * files. Ground truth: the `ToolName` enum in microsoft/vscode-copilot-chat
 * (src/extension/tools/common/toolNames.ts), cross-checked against captured
 * PreToolUse payloads. devmate targets Copilot in VS Code only.
 *
 * Membership here clears a tool outright, without looking at what it names.
 *
 * It is no longer the ONLY escape. A tool devmate has never seen is classified
 * by the **path its input names**, not by its absence from this list (#94): the
 * old rule denied `session_store_sql` and every other MCP/extension-contributed
 * tool on first contact, and told the caller to patch devmate's own library — an
 * instruction a plugin consumer cannot follow.
 *
 * The guarantee that mattered survives intact. An allowlist of *edit* tools fails
 * OPEN — a renamed or newly added edit tool is silently ungated, which is exactly
 * how the guard came to wave through every VS Code edit (#74), and had already
 * happened once with `apply_patch`. Keying on the named path is *stronger* than
 * any name list, because every VS Code edit tool names its target (`filePath`,
 * `dirPath`, `replacements[].filePath`, `files[]`, the `apply_patch` body): a
 * renamed `replace_string_in_file` still carries `filePath` and is still gated.
 * See {@link isSourceEditTool} for the residual hole and why it is narrower than
 * the one it replaces.
 * @type {readonly string[]}
 */
const NON_SOURCE_EDIT_TOOLS = Object.freeze([
  // Read / inspect. The file-content readers are spread in from the list that
  // owns them, so PostToolUse's read set and this allowlist cannot disagree.
  ...FILE_READ_TOOLS,
  'view_image', 'list_dir', 'get_errors', 'read_project_structure',
  'get_changed_files', 'copilot_getNotebookSummary',
  // Search
  'semantic_search', 'file_search', 'grep_search', 'search_workspace_symbols',
  'test_search', 'get_search_view_results', 'tool_search',
  // Terminal / task inspection. Read-only despite the verb — classify by effect,
  // not by name prefix.
  'get_terminal_output', 'terminal_selection', 'terminal_last_command',
  'get_task_output',
  // Test execution: runs tests, never edits source. Gating it would break the
  // verify loop, which is the workflow's own recovery path.
  'runTests', 'test_failure',
  // Web / metadata
  'fetch_webpage', 'github_repo', 'get_vscode_api', 'get_project_setup_info',
  // Control plane — mutates agent/session state, never source files.
  // `runSubagent` MUST stay here: it falls through to evaluateGuard, so
  // classifying it as an edit would make Rule 2 ("no active devmate task") deny
  // every dispatch before a task exists — deadlocking the orchestrator, since
  // dispatch is the only way a task ever starts.
  'runSubagent', 'search_subagent', 'execution_subagent', 'switch_agent',
  'manage_todo_list', 'memory', 'resolve_memory_file_uri',
  'vscode_askQuestions', 'vscode_get_confirmation',
  'vscode_get_confirmation_with_options', 'vscode_get_terminal_confirmation',
]);

/**
 * VS Code source-edit tools devmate recognizes by name. Membership makes a tool
 * an edit unconditionally — even when its input names nothing the guard can read,
 * which is what keeps `replace_string_in_file` with an unparseable `tool_input`
 * failing closed.
 *
 * **The gate does not depend on this list.** A tool missing from here is still
 * gated whenever its input names a source path ({@link isSourceEditTool}), so a
 * renamed or newly added VS Code editor is caught by the path it carries rather
 * than by having been enumerated here in time. The list also lets a denial say
 * whether the tool was a known editor or merely unrecognized, which are very
 * different things to debug.
 * @type {readonly string[]}
 */
export const KNOWN_SOURCE_EDIT_TOOLS = Object.freeze([
  'apply_patch', 'insert_edit_into_file', 'create_file', 'replace_string_in_file',
  'multi_replace_string_in_file', 'edit_notebook_file', 'edit_files',
  'create_directory', 'create_new_jupyter_notebook', 'create_new_workspace',
]);

/**
 * True when `toolName` is neither a known read-only tool nor a known source-edit
 * tool — i.e. it is gated purely by the fail-closed default. Used to give such a
 * denial an honest, actionable reason instead of one that asserts it is an edit.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isUnrecognizedTool(toolName) {
  return (
    !NON_SOURCE_EDIT_TOOLS.includes(toolName) &&
    !KNOWN_SOURCE_EDIT_TOOLS.includes(toolName) &&
    !SHELL_TOOLS.includes(toolName)
  );
}

/**
 * Match an apply_patch file-operation header, e.g. `*** Update File: src/a.mjs`
 * or `*** Add File: src/b.mjs`. The path is captured group 1 (greedy to
 * end-of-line; the caller trims). Literal single spaces (the apply_patch format)
 * and a single trailing quantifier avoid any cross-quantifier backtracking.
 * @type {RegExp}
 */
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm;

/**
 * Extract the target file path(s) from an apply_patch body. `apply_patch` puts
 * its targets in the patch text (`*** Update File: <path>`), not in a `path`
 * field, so the gate-guard needs this to attribute the edit to a path the
 * scope.md / persona-scope / TDD rules can vet. Returns [] for non-patch input.
 * @param {unknown} patchText
 * @returns {string[]}
 */
export function extractApplyPatchPaths(patchText) {
  if (typeof patchText !== 'string' || patchText === '') return [];
  /** @type {string[]} */
  const out = [];
  for (const m of patchText.matchAll(APPLY_PATCH_FILE_RE)) {
    const p = m[1].trim();
    if (p !== '') out.push(p);
  }
  return out;
}

/**
 * Session artifacts an agent may NOT hand-write, as globs over the
 * workspace-relative path: the gate itself (`.devmate/state/task.json`), the
 * approved contract (`.devmate/session/spec.md`), and the evidence chain
 * (`plan.json`, `discovery.json`, `diagnosis.json`, `scope.md`, `trace.jsonl`).
 *
 * This is the DEFAULT, applied whenever a caller supplies no
 * `sessionArtifactPaths` — deliberately, because the previous default was `[]`
 * and an empty list is what kept Rule 4 dormant for the plugin's whole life
 * (#93). A rule whose default is "protect nothing" is not a boundary; it is a
 * comment. Fail closed here and let `devmate.config.json` widen or narrow it.
 *
 * Nothing legitimate is lost by protecting these: every one of them is written
 * by a HOOK (`hooks/gate-advance.mjs` advances the gate and derives `scope.md`;
 * `hooks/contract-validator.mjs` and the workflow libs persist worker returns),
 * and a hook is not a tool call, so it is not subject to `evaluateGuard` at all.
 * The single agent that legitimately writes an artifact is `spec-writer` →
 * `spec.md`; see {@link DEFAULT_SESSION_ARTIFACT_WRITERS}.
 * @type {readonly string[]}
 */
export const DEFAULT_SESSION_ARTIFACT_PATHS = Object.freeze([
  '.devmate/state/**',
  '.devmate/session/**',
]);

/**
 * The only identity-gated exception to {@link DEFAULT_SESSION_ARTIFACT_PATHS}:
 * `@spec-writer` writes `spec.md`, which is the one artifact an agent — not a
 * hook — produces. Everything else under the protected globs is a flat deny that
 * needs no identity at all, which is what makes the rule enforceable despite
 * PreToolUse carrying no agent name (#93).
 * @type {readonly SessionArtifactWriter[]}
 */
export const DEFAULT_SESSION_ARTIFACT_WRITERS = Object.freeze([
  Object.freeze({
    glob: '.devmate/session/**/spec.md',
    agents: Object.freeze(['spec-writer']),
  }),
]);

/** The directory every session artifact lives under, slash-normalized. */
const DEVMATE_DIR_MARKER = '.devmate/';

/**
 * Normalize a tool-call path for session-artifact matching.
 *
 * Two shapes reach the guard for the same file: the workspace-relative
 * `.devmate/state/task.json`, and the absolute `c:\ws\.devmate\state\task.json`
 * (the host sends absolute paths for some tools). A glob written against the
 * former does not match the latter, so matching the raw string would leave the
 * absolute form — the easier one for an agent to produce — unprotected. Reduce
 * both to the `.devmate/…` tail.
 *
 * The result is LOWERCASED, and the artifact globs are lowercased to match it.
 * Windows and macOS have case-insensitive filesystems, so `.DEVMATE/state/task.json`
 * opens exactly the same file as `.devmate/state/task.json` — but a case-sensitive
 * glob match sees a different path and waves it through. Case is a spelling of the
 * path, not a different file, and a guard that can be defeated by pressing shift is
 * not a guard. On a case-sensitive filesystem this can only ever over-protect (a
 * genuinely distinct `.DEVMATE/` directory would be denied), which is the right way
 * to be wrong here.
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeArtifactPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const idx = normalized.lastIndexOf(`/${DEVMATE_DIR_MARKER}`);
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Resolve the single agent identity Rule 4 gates on from the sub-agents the host
 * told us are in flight (`state.activeAgents`, stamped at SubagentStart from the
 * captured `agent_type` — see hooks/subagent-budget-guard.mjs).
 *
 * **The parallel-`@fullstack` ambiguity, resolved rather than assumed away.**
 * The feature lane dispatches `@fullstack` ×N concurrently, so more than one
 * sub-agent can be in flight when a PreToolUse arrives — and that event carries
 * no id tying the tool call to one of them. Two honest consequences:
 *
 *  - N instances of the SAME agent collapse to one identity. Rule 4 gates on the
 *    agent's *name*, so two `fullstack` workers are one identity as far as this
 *    rule is concerned; nothing is guessed.
 *  - A MIXED set (`spec-writer` + `fullstack`) is genuinely ambiguous: the guard
 *    cannot tell which one is calling. It returns `ambiguous`, and Rule 4 denies
 *    — an artifact write attributable to nobody is exactly the write to refuse.
 *
 * Zero in flight means the caller is the top-level session (orchestrator or the
 * human's own agent), which is likewise not an allowed artifact writer.
 * @param {TaskState|null} state
 * @returns {{ agent: string, ambiguous: boolean }}
 */
export function resolveActiveAgent(state) {
  const entries = Array.isArray(state?.activeAgents) ? state.activeAgents : [];
  /** @type {Set<string>} */
  const names = new Set();
  for (const entry of entries) {
    const name = typeof entry?.agentName === 'string' ? entry.agentName.trim() : '';
    if (name !== '') names.add(name);
  }
  if (names.size === 1) {
    const [only] = names;
    return { agent: only ?? '', ambiguous: false };
  }
  return { agent: '', ambiguous: names.size > 1 };
}

/** Source file extensions treated as edit targets by the shell analyzer. */
const SHELL_SOURCE_EXTS = Object.freeze([
  '.mjs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.json',
]);

/**
 * Shell tool names whose `command` is analyzed for source writes. VS Code
 * Copilot has exactly one (`run_in_terminal`); `shell` / `bash` / `powershell`
 * were Claude-Code/CLI-shaped names that never appear on this surface. They are
 * not merely dead — listing them made the guard *look* correct while it matched
 * nothing. A tool named `bash` now falls through to the fail-closed default.
 * @type {readonly string[]}
 */
const SHELL_TOOLS = Object.freeze(['run_in_terminal']);

/**
 * First-token commands that are known read-only (never write source on their
 * own; a redirect on the same command line is detected before this list is
 * consulted).
 * @type {readonly string[]}
 */
const READ_ONLY_COMMANDS = Object.freeze([
  'cat', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'head', 'tail', 'wc',
  'find', 'less', 'more', 'stat', 'file', 'diff', 'echo', 'pwd', 'which',
  'type', 'printf', 'du', 'df', 'tree',
]);

/**
 * True when a path-like token ends with a source extension.
 * @param {string} token
 * @returns {boolean}
 */
function isSourcePathToken(token) {
  const cleaned = token.replace(/^['"]|['"]$/g, '').toLowerCase();
  return SHELL_SOURCE_EXTS.some((ext) => cleaned.endsWith(ext));
}

/**
 * True when a path-like token points inside `.devmate/` — a session artifact,
 * whatever its extension.
 *
 * `spec.md` is the reason this exists. The shell analyzer classified writes by
 * source extension only, and `.md` is not one, so `echo … > spec.md` was not a
 * "source write" — it sailed past the terminal-as-editor rule and past the
 * session-artifact rule alike, and rewrote the human-approved contract (#93).
 * Extension is the wrong axis for these files: what makes `task.json` and
 * `scope.md` protected is *where they live*, not what they are named.
 * @param {string} token
 * @returns {boolean}
 */
function isSessionArtifactToken(token) {
  const cleaned = token
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return cleaned.startsWith(DEVMATE_DIR_MARKER) || cleaned.includes(`/${DEVMATE_DIR_MARKER}`);
}

/**
 * True when a token names something a write would land on that the guard cares
 * about: a source file, or any session artifact under `.devmate/`.
 *
 * The single owner of "is this string a path worth gating". Two callers ask it,
 * and they must never answer differently: the shell analyzer below, deciding
 * whether a `run_in_terminal` command writes source, and `namedPaths`
 * (lib/hooks/tool-input.mjs), deciding whether an unrecognized tool's input names
 * a path the gate can vet (#94). #93 settled the definition — extension for
 * source files, *location* for session artifacts, because `spec.md` is protected
 * by living under `.devmate/`, not by how it is named — and the classifier keys
 * on that same definition rather than inventing a second one.
 * @param {string} token
 * @returns {boolean}
 */
export function isWriteTargetToken(token) {
  return isSourcePathToken(token) || isSessionArtifactToken(token);
}

/**
 * True when a tool call may write to a source path.
 *
 * Classification by **what the call names**, not by name-membership (#94):
 *
 * | Tool | Verdict |
 * | --- | --- |
 * | in {@link NON_SOURCE_EDIT_TOOLS} | not an edit |
 * | `run_in_terminal` | analyze the `command` |
 * | in {@link KNOWN_SOURCE_EDIT_TOOLS} | edit |
 * | unknown, `namedPaths` names a gateable path | edit |
 * | unknown, `namedPaths` names none | not an edit |
 * | unknown, `namedPaths` omitted | edit (fail closed) |
 *
 * The old rule — anything not on the read-only allowlist is an edit — denied
 * every MCP and extension-contributed tool on first contact, `session_store_sql`
 * included, and that surface grows every release. It also protected nothing:
 * **every rule in {@link evaluateGuard} keys on a file path**, so a tool naming
 * no path has nothing for persona scope, scope.md, the session-artifact rule, or
 * TDD to check. Denying it was a pure false positive.
 *
 * This is not a revert of #74's polarity. #74's real guarantee was "any call that
 * names a source file is gated, whatever the tool is called", and keying on the
 * path is strictly stronger than a name list — a renamed `replace_string_in_file`
 * still carries `filePath`. The residual hole, stated plainly: an unknown tool
 * that writes source through a path {@link namedPaths} cannot see. The one such
 * tool that demonstrably exists — the terminal — is handled above by
 * {@link shellWritesSource}, so `sed -i`, redirects, `tee`, `patch` and
 * `git apply` stay blocked. That hole is narrower than denying the whole MCP
 * ecosystem to paper over it.
 *
 * **Omitting `namedPaths` fails closed**, deliberately: `evals/trajectory/scorer.mjs`
 * classifies off a trace `actionType` with no `tool_input` to offer, and a caller
 * with nothing to inspect must not be handed an allow.
 *
 * @param {string} toolName
 * @param {string} [command]  Raw shell command, when toolName is a shell tool.
 * @param {readonly string[]} [namedPaths]  Every gateable path the `tool_input`
 *   names, from `namedPaths()` in lib/hooks/tool-input.mjs. Omit only when there
 *   is no `tool_input` to read — omission is treated as an edit.
 * @returns {boolean}
 */
export function isSourceEditTool(toolName, command, namedPaths) {
  // (a) Known read-only / control-plane tools: cleared without looking further.
  if (NON_SOURCE_EDIT_TOOLS.includes(toolName)) return false;

  // (b) The one shell tool: refine by analyzing the command it will run, so a
  // provably read-only command (`ls`, `npm test`) is still allowed. A shell tool
  // arriving with no command to analyze cannot be cleared, so it stays gated.
  if (SHELL_TOOLS.includes(toolName)) {
    return typeof command === 'string' ? shellWritesSource(command) : true;
  }

  // (c) A known editor is an edit whatever its input says — including an input
  // the guard cannot parse, which must not become an escape hatch.
  if (KNOWN_SOURCE_EDIT_TOOLS.includes(toolName)) return true;

  // (d) An unrecognized tool is an edit iff it names a path a rule could gate.
  // No `namedPaths` at all means nothing was inspected — fail closed.
  if (!Array.isArray(namedPaths)) return true;
  return namedPaths.some((p) => typeof p === 'string' && isWriteTargetToken(p));
}

/**
 * True when a tool call is a source edit the guard cannot attribute to a
 * concrete target path. Shell tools carry their `command` (not a `path`), so a
 * shell command classified as a source write has no path for the persona-scope,
 * scope.md, or TDD rules to vet — every one of them keys on `payload.path`.
 * Such an edit must fail closed regardless of gate: it is the vector the
 * orchestrator (which holds no edit tool) uses to edit source via `sed -i`,
 * `cat > file`, a redirect, `tee`, `patch`, or `git apply`.
 * @param {HookPayload} payload
 * @returns {boolean}
 */
export function isUnscopeableSourceEdit(payload) {
  const path = typeof payload.path === 'string' ? payload.path : '';
  if (path !== '') return false;
  return isSourceEditTool(payload.tool_name, payload.command, payload.namedPaths);
}

/**
 * PowerShell cmdlets that write file content. Matched as standalone tokens by
 * {@link shellWritesSource} (lower-cased), never inside a quoted argument.
 * @type {readonly string[]}
 */
const POWERSHELL_WRITE_CMDLETS = Object.freeze(['set-content', 'out-file', 'add-content']);

/**
 * Quote-aware shell command scanner (#128). Splits a command line into
 * pipeline segments of whitespace-separated tokens, keeping single- or
 * double-quoted spans inside the current token — the naive
 * `split(/\s+/)` tokenizer read `git commit -m "renamed > foo.mjs"` as a
 * bare `>` redirect onto a source path and denied an ordinary commit.
 *
 * Outside quotes, `|`, `||`, `&&`, and `;` end the current segment — the same
 * operator set the previous regex-based splitter used; a single `&` stays an
 * ordinary character so `2>&1` survives as one token. An unclosed quote
 * swallows the rest of the command into the current token AND is reported via
 * the `unbalanced` flag, so the analyzer treats the whole command as
 * unclassifiable (fail closed) instead of trusting a read-only head whose
 * redirect vanished into the open span.
 *
 * Backslash escapes are honored POSIX-style outside single quotes: `\X`
 * contributes both bytes to the current token and strips X of any scanner
 * significance. Inside double quotes this keeps `\"` from prematurely closing
 * the span (`git commit -m "say \"renamed > foo.mjs\" now"` stays one token);
 * outside quotes it keeps `\"` from OPENING one — otherwise
 * `echo \"x\" > lib/app.mjs`, a real write, would swallow its redirect into a
 * quoted span and walk past the scan (fail-open). Inside single quotes a
 * backslash is literal, as in POSIX.
 * @param {string} command
 * @returns {{ segments: string[][], unbalanced: boolean }} Tokens grouped per
 *   pipeline segment, plus whether a quote was left unclosed.
 */
function splitShellSegments(command) {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  // @bounded-alloc — one token/segment list per analyzed command line.
  let segment = [];
  // Named `word`, not `token`: security/detect-possible-timing-attacks flags
  // any comparison against an identifier literally named `token`.
  let word = '';
  let quote = '';
  const endWord = () => {
    if (word !== '') {
      segment.push(word);
      word = '';
    }
  };
  const endSegment = () => {
    endWord();
    if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote === "'") {
      // Inside single quotes every byte is literal (POSIX): no escapes.
      word += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\') {
      // POSIX escape (outside single quotes): keep both bytes, strip the next
      // character of scanner significance so `\"` can neither close nor open
      // a quoted span.
      word += ch;
      if (i + 1 < command.length) {
        word += command.charAt(i + 1);
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      word += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      word += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    if (ch === ';') {
      endSegment();
      continue;
    }
    if (ch === '|') {
      endSegment();
      if (command.charAt(i + 1) === '|') i += 1;
      continue;
    }
    if (ch === '&' && command.charAt(i + 1) === '&') {
      endSegment();
      i += 1;
      continue;
    }
    word += ch;
  }
  endSegment();
  return { segments, unbalanced: quote !== '' };
}

/**
 * Shell heads that run an embedded script or command string. Their payload is
 * a quoted argument the analyzer cannot see into — the same opacity as
 * `python -c` / `node -e`, which already fail closed — and, since quoting
 * keeps that payload inside one token now, the fail-closed source-token net
 * no longer reliably sees a path buried mid-script. `bash -c "sed -i …
 * lib/app.mjs && npm test"` is the canonical orchestrator escape hatch, so
 * every one of these fails closed unconditionally: devmate itself never
 * wraps its commands in an interpreter, and the guard allows only what it can
 * positively classify as read-only.
 * @type {readonly string[]}
 */
const INTERPRETER_WRAPPER_HEADS = Object.freeze([
  'bash', 'sh', 'zsh', 'dash', 'ksh',
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe',
]);

/**
 * True when a token names a write target anywhere inside it — not only at its
 * tail. A quoted span keeps its content inside one token, so a source path
 * buried mid-token (`"unterminated lib/app.mjs extra`) evades the plain
 * `endsWith`-based {@link isWriteTargetToken}. Used ONLY by the fail-closed
 * unclassifiable-command net; the positive classifiers (redirect targets,
 * tee/mv/cp arguments) keep exact-token semantics so quoted prose stays
 * benign under a benign head.
 * @param {string} shellToken
 * @returns {boolean}
 */
function tokenNamesWriteTarget(shellToken) {
  if (isWriteTargetToken(shellToken)) return true;
  return shellToken
    .split(/["'\s\\]+/)
    .some((frag) => frag !== '' && isWriteTargetToken(frag));
}

/**
 * Default-deny shell analyzer (E9-12). Returns true when a shell command can
 * write a source file:
 *  - any `>`/`>>` redirect whose target has a source extension;
 *  - the in-place editor family (`sed -i`, `perl -i`, `git apply`, `patch`,
 *    `tee`/`mv`/`cp` onto a source path or session artifact);
 *  - opaque inline interpreters (`python -c`, `python3 -c`, `node -e`) and
 *    every interpreter wrapper head (`bash`, `sh`, `pwsh`, `powershell`,
 *    `cmd`, …) — their embedded code cannot be analyzed, so they fail closed;
 *  - PowerShell write cmdlets (`Set-Content`, `Out-File`, `Add-Content`);
 *  - any command that is not a known read-only command but references a
 *    source-path token (unclassifiable → fail closed).
 * Tokenization is quote-aware (#128, {@link splitShellSegments}): a redirect
 * character, pipeline operator, or cmdlet name inside a quoted argument is
 * ordinary text, so `git commit -m "renamed > foo.mjs"` and
 * `grep "> some/path.mjs" README.md` are not writes.
 * A write target is a source-extension path OR any path under `.devmate/`
 * (session artifacts are protected by location, not by extension — #93), so
 * `echo … > .devmate/session/spec.md` is a write here and is denied by Rule 3b.
 * Known read-only commands (`cat`, `grep`, `ls`, …) and `node --test` /
 * plain `node script.mjs` execution remain allowed.
 * @param {string} command
 * @returns {boolean}
 */
function shellWritesSource(command) {
  // TODO: extend as new write mechanisms surface — provisional list
  const { segments, unbalanced } = splitShellSegments(command);
  // @bounded-alloc — flattens the tokens of one command line back into a list.
  const tokens = segments.flat();
  if (tokens.length === 0) return false;

  // 1) Any redirect (`>`, `>>`, `1>`, `2>>`, …) onto a source-extension target
  //    or a session artifact, regardless of the command producing the output.
  //    Runs over quote-aware tokens (#128): a `>` inside a quoted argument
  //    (`git commit -m "renamed > foo.mjs"`) is part of that token, never a
  //    redirect operator.
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i] ?? '';
    if (/^\d*>{1,2}$/.test(tok) && isWriteTargetToken(tokens.at(i + 1) ?? '')) {
      return true;
    }
  }
  // Attached form: `>file.mjs` / `>>file.mjs`.
  for (const tok of tokens) {
    const m = tok.match(/^\d*>{1,2}(.+)$/);
    if (m && m[1] !== undefined && isWriteTargetToken(m[1])) return true;
  }

  // PowerShell write cmdlets as a standalone (unquoted) token. Token equality
  // instead of a raw-string regex (#128), so a cmdlet NAME quoted inside an
  // ordinary argument (`git commit -m "document Out-File"`) is not a write.
  if (tokens.some((t) => POWERSHELL_WRITE_CMDLETS.includes(t.toLowerCase()))) {
    return true;
  }

  // 2) Analyze each pipeline segment independently so `... | tee file.mjs`
  //    and `... | patch` are caught regardless of the first command.
  let sawUnknownSegment = false;
  for (const segTokens of segments) {
    const head = (segTokens[0] ?? '').toLowerCase();
    const rest = segTokens.slice(1);

    // Interpreter wrappers run an embedded script the analyzer cannot see
    // into — opaque, so fail closed (mirrors python -c / node -e below).
    if (INTERPRETER_WRAPPER_HEADS.includes(head)) return true;

    // In-place editor family and opaque interpreters.
    if (head === 'sed' && rest.some((t) => t.startsWith('-i'))) return true;
    if (head === 'perl' && rest.some((t) => t.startsWith('-i'))) return true;
    if ((head === 'python' || head === 'python3') && rest.includes('-c')) return true;
    if (head === 'node' && rest.some((t) => t === '-e' || t === '--eval')) return true;
    if (head === 'git' && (rest[0] ?? '').toLowerCase() === 'apply') return true;
    if (head === 'patch') return true;
    // `tee` is a write only when its actual target names a source path or a
    // session artifact — mirroring the mv/cp check below (#128). A benign
    // capture (`npm test 2>&1 | tee test-results.log`) is not an edit.
    if (head === 'tee' && rest.some((t) => isWriteTargetToken(t))) return true;
    if ((head === 'mv' || head === 'cp') && rest.some((t) => isWriteTargetToken(t))) return true;

    // Known read-only commands (and plain node/npm/git execution) are benign.
    if (READ_ONLY_COMMANDS.includes(head)) continue;
    if (head === 'node' || head === 'npm' || head === 'npx' || head === 'git') continue;

    sawUnknownSegment = true;
  }

  // 3) Fail closed: an unclassifiable command referencing a source path or a
  //    session artifact is treated as an edit. An unbalanced quote makes the
  //    WHOLE command unclassifiable — a read-only head must not vouch for a
  //    line whose redirect may have vanished into the open span — and the
  //    scan looks inside quoted tokens, where a mid-token path evades the
  //    tail-anchored isWriteTargetToken.
  if ((sawUnknownSegment || unbalanced) && tokens.some((t) => tokenNamesWriteTarget(t))) {
    return true;
  }

  return false;
}

/**
 * Simple glob matcher supporting '*' (single path segment) and '**' (any path depth).
 * Uses only Node built-ins; no third-party dependency.
 * @param {string} pattern  Glob pattern (e.g. 'src/**\/*.mjs').
 * @param {string} filePath File path to test.
 * @returns {boolean}
 */
export function matchGlob(pattern, filePath) {
  const p = pattern.replace(/\\/g, '/');
  const f = filePath.replace(/\\/g, '/');

  const pSegs = p.split('/');
  const fSegs = f.split('/');
  return matchGlobSegments(pSegs, fSegs, 0, 0);
}

/**
 * Recursive segment matcher for glob paths supporting `*`, `?`, and `**`.
 * @param {string[]} patternSegs
 * @param {string[]} pathSegs
 * @param {number} pi
 * @param {number} si
 * @returns {boolean}
 */
function matchGlobSegments(patternSegs, pathSegs, pi, si) {
  if (pi >= patternSegs.length) return si >= pathSegs.length;

  const p = patternSegs.at(pi);
  if (p === '**') {
    for (let k = si; k <= pathSegs.length; k++) {
      if (matchGlobSegments(patternSegs, pathSegs, pi + 1, k)) return true;
    }
    return false;
  }

  if (si >= pathSegs.length) return false;
  if (!matchSegment(p ?? '', pathSegs.at(si) ?? '')) return false;
  return matchGlobSegments(patternSegs, pathSegs, pi + 1, si + 1);
}

/**
 * Match one path segment supporting `*` and `?` wildcards.
 * @param {string} patternSeg
 * @param {string} pathSeg
 * @returns {boolean}
 */
function matchSegment(patternSeg, pathSeg) {
  /** @type {Set<string>} */
  let states = new Set([`0,0`]);
  while (states.size > 0) {
    const [state] = states;
    if (state === undefined) break;
    const [iRaw, jRaw] = state.split(',');
    const i = Number(iRaw);
    const j = Number(jRaw);
    states.delete(state);

    if (i === patternSeg.length && j === pathSeg.length) return true;
    if (i > patternSeg.length || j > pathSeg.length) continue;

    const pc = patternSeg[i];
    if (pc === '*') {
      states.add(`${i + 1},${j}`);
      if (j < pathSeg.length) states.add(`${i},${j + 1}`);
      continue;
    }
    if (pc === '?') {
      if (j < pathSeg.length) states.add(`${i + 1},${j + 1}`);
      continue;
    }
    if (pc !== undefined && j < pathSeg.length && pc === pathSeg[j]) {
      states.add(`${i + 1},${j + 1}`);
    }
  }

  return false;
}

/**
 * Check whether a persona from devmate.config.json owns the given filePath.
 * Ownership requires matching at least one editableGlob and no offLimitsGlob.
 *
 * B8 — multi-root anchoring: a persona's globs are authored relative to its own
 * sub-repo (e.g. `src/**`), but the gate-guard receives workspace-relative paths
 * (e.g. `api/src/x.ts`, per B5). When the persona carries a `repo` (multi-root
 * only), the path is also tested with that prefix stripped, so repo-relative globs
 * match the intended tree. This mirrors `enforceScope`'s `repoPrefix` handling
 * (lib/workflow/scope.mjs). Single-root personas have no `repo`, so `repoRelative`
 * stays null and matching is byte-for-byte identical to before.
 *
 * @param {string} persona
 * @param {string} filePath
 * @param {DevmateConfig} config
 * @returns {boolean}
 */
export function ownsFile(persona, filePath, config) {
  const entry = config.personas.find((pe) => pe.persona === persona);
  if (!entry) return false;
  if (!personaGlobMatch(entry, filePath, entry.editableGlobs)) return false;
  return !personaGlobMatch(entry, filePath, entry.offLimitsGlobs ?? []);
}

/**
 * Render a glob/path list for a deny reason, capped so a large config cannot
 * bloat the hook's stdout (TCM-9: cap tool output at the boundary).
 * @param {readonly string[]} globs
 * @param {number} [max]
 * @returns {string}
 */
function formatGlobList(globs, max = 8) {
  if (globs.length === 0) return 'none declared';
  const shown = globs.slice(0, max).join(', ');
  return globs.length > max ? `${shown}, +${globs.length - max} more` : shown;
}

/**
 * Explain *why* {@link ownsFile} rejected an edit, naming the globs that decided
 * it. The guard already holds the config that produced the verdict, so telling
 * the caller to go read devmate.config.json is a needless round trip for a human
 * and an impossible one for an agent — which then guesses, and retries wrong.
 * Distinguishes the three distinct causes: persona not declared, path off-limits,
 * path simply not editable.
 * @param {string} persona
 * @param {string} filePath
 * @param {DevmateConfig} config
 * @returns {string}  Reason fragment (no trailing period).
 */
export function explainOwnership(persona, filePath, config) {
  const entry = config.personas.find((pe) => pe.persona === persona);
  if (!entry) {
    const declared = config.personas.map((pe) => pe.persona);
    return (
      `persona '${persona}' is not declared in .devmate/devmate.config.json ` +
      `(declared personas: ${declared.length > 0 ? declared.join(', ') : 'none'})`
    );
  }
  const offLimits = entry.offLimitsGlobs ?? [];
  if (personaGlobMatch(entry, filePath, offLimits)) {
    return (
      `'${filePath}' is off-limits for persona '${persona}' ` +
      `(offLimitsGlobs: ${formatGlobList(offLimits)})`
    );
  }
  return (
    `persona '${persona}' does not own '${filePath}' ` +
    `(editableGlobs: ${formatGlobList(entry.editableGlobs ?? [])})`
  );
}

/**
 * Repo-prefix-aware glob match for a persona entry. Shared by `ownsFile` and
 * `filesOutsidePersonaScope` so every persona-boundary check uses identical
 * multi-root semantics: the path is tested as-is and, when the persona carries
 * a `repo` (multi-root), also with that prefix stripped (mirrors `enforceScope`).
 * @param {PersonaEntry} entry
 * @param {string} filePath
 * @param {readonly string[]} globs
 * @returns {boolean}
 */
function personaGlobMatch(entry, filePath, globs) {
  const normalized = filePath.replace(/\\/g, '/');
  const repoPrefix =
    typeof entry.repo === 'string' && entry.repo
      ? (entry.repo.endsWith('/') ? entry.repo : `${entry.repo}/`)
      : '';
  const repoRelative =
    repoPrefix && normalized.startsWith(repoPrefix)
      ? normalized.slice(repoPrefix.length)
      : null;
  return globs.some(
    (g) => matchGlob(g, normalized) || (repoRelative !== null && matchGlob(g, repoRelative)),
  );
}

/**
 * Files a persona changed that violate its edit boundary (empty = all clear).
 *
 * A changed file `f` is a violation for `persona` P when P does NOT own it AND
 * either (a) `f` matches P's `offLimitsGlobs` — an explicit breach — or (b) `f`
 * is owned by a *different* declared persona — a partition breach (P edited Q's
 * file). A file owned by **no** declared persona (shared contracts, docs, root
 * configs — which `partitionWorkstreams` routes to `sharedFiles`) is NOT a
 * violation: the flat `scope.md` (Rule 6) already governs those, and flagging
 * them here would false-positive on legitimately-planned shared edits.
 *
 * Built on `ownsFile`/`personaGlobMatch`, so `changedFiles` (workspace-relative,
 * exactly like `payload.path`) match with the same multi-root handling.
 *
 * @param {string} persona
 * @param {readonly string[]} changedFiles
 * @param {DevmateConfig} config
 * @returns {string[]}
 */
export function filesOutsidePersonaScope(persona, changedFiles, config) {
  if (!Array.isArray(changedFiles)) return [];
  const entry = config.personas.find((pe) => pe.persona === persona);
  /** @type {string[]} */
  const violations = [];
  for (const f of changedFiles) {
    if (typeof f !== 'string' || f.trim() === '') continue;
    if (ownsFile(persona, f, config)) continue;
    const offLimits = entry ? personaGlobMatch(entry, f, entry.offLimitsGlobs ?? []) : false;
    const ownedByOther = config.personas.some(
      (q) => q.persona !== persona && ownsFile(q.persona, f, config),
    );
    if (offLimits || ownedByOther) violations.push(f);
  }
  return violations;
}

/**
 * Pure pre-condition check for the TDD gate. No I/O. Caller persists the
 * resulting guard-state transition via `applyTddGuardTransition`. Same inputs
 * always return the same output.
 *
 * @param {string}        filePath     The file the agent wants to write.
 * @param {TddGuardState} guardState   Current TDD state for this task.
 * @param {string[]}      testGlobs    Globs that match test files.
 * @returns {'allow'|'block'}
 */
export function evaluateTddPreCondition(filePath, guardState, testGlobs) {
  // Override always wins.
  if (guardState.overrideGranted) return 'allow';

  const normalized = filePath.replace(/\\/g, '/');

  // Test file write: always allowed; the caller updates testFileWritten=true.
  if (testGlobs.some((g) => matchGlob(g, normalized))) {
    return 'allow';
  }

  // Non-source files (config, docs, JSON, etc.) are not policed.
  const dotIdx = normalized.lastIndexOf('.');
  const ext = dotIdx === -1 ? '' : normalized.slice(dotIdx);
  if (!SOURCE_FILE_EXTS.includes(ext)) {
    return 'allow';
  }

  // Source file write with prior test evidence: allow and let the caller reset the counter.
  if (guardState.testFileWritten) return 'allow';

  // No test evidence yet. Block immediately on first non-test source write.
  return 'block';
}

/**
 * Pure helper that computes the next TDD guard state given a decision and the
 * file that was attempted. The hook entry script calls this after invoking
 * `evaluateTddPreCondition` to know what to persist.
 *
 * @param {TddGuardState}              prev       Current guard state.
 * @param {'allow'|'warn'|'block'}     decision   Decision returned by evaluateTddPreCondition.
 * @param {string}                     filePath   The file path that triggered the decision.
 * @param {string[]}                   testGlobs  Globs that match test files.
 * @returns {TddGuardState}
 */
export function applyTddGuardTransition(prev, decision, filePath, testGlobs) {
  const normalized = filePath.replace(/\\/g, '/');
  const isTestPath = testGlobs.some((g) => matchGlob(g, normalized));
  const dotIdx = normalized.lastIndexOf('.');
  const ext = dotIdx === -1 ? '' : normalized.slice(dotIdx);
  const isSourcePath = SOURCE_FILE_EXTS.includes(ext);

  if (isTestPath) {
    return { ...prev, testFileWritten: true, consecutiveNonTestWrites: 0 };
  }
  if (isSourcePath && !prev.testFileWritten) {
    return { ...prev, consecutiveNonTestWrites: prev.consecutiveNonTestWrites + 1 };
  }
  if (decision === 'allow' && prev.testFileWritten && prev.consecutiveNonTestWrites > 0) {
    return { ...prev, consecutiveNonTestWrites: 0 };
  }
  return prev;
}

/**
 * Verdict of the session-artifact check for one edit target. `'not-artifact'`
 * means the path is not protected and the caller's other rules decide.
 * @typedef {'not-artifact'|'allow'|'deny'} SessionArtifactVerdict
 */

/**
 * Decide whether an edit to `filePath` is a permitted write to a session
 * artifact. Shared by Rules 2, 3 and 4 so the *exception* (an allowed writer may
 * write its artifact even when state is unreadable or the gate forbids source
 * edits) and the *rule* (nobody else may, ever) can never drift apart.
 *
 * @param {string} filePath                        Raw payload path (relative or absolute).
 * @param {readonly string[]} sessionPaths         Protected globs.
 * @param {readonly SessionArtifactWriter[]} writers  Per-artifact allowed writers.
 * @param {string} activeAgent                     Resolved agent name; '' when unknown/ambiguous.
 * @returns {SessionArtifactVerdict}
 */
function sessionArtifactVerdict(filePath, sessionPaths, writers, activeAgent) {
  if (filePath === '') return 'not-artifact';
  // Both sides lowercased: the path by normalizeArtifactPath, the globs here.
  // See normalizeArtifactPath for why case cannot be allowed to decide this.
  const normalized = normalizeArtifactPath(filePath);
  if (!sessionPaths.some((g) => matchGlob(g.toLowerCase(), normalized))) return 'not-artifact';
  if (activeAgent === '') return 'deny';
  const permitted = writers.some(
    (w) => matchGlob(w.glob.toLowerCase(), normalized) && w.agents.includes(activeAgent),
  );
  return permitted ? 'allow' : 'deny';
}

/**
 * Build the deny reason for an unpermitted session-artifact write. Names the
 * identity the guard resolved (or why it could not), so the caller is not left
 * guessing at a boundary it cannot see.
 * @param {string} filePath
 * @param {readonly SessionArtifactWriter[]} writers
 * @param {string} activeAgent
 * @param {boolean} ambiguous
 * @returns {string}
 */
function sessionArtifactDenyReason(filePath, writers, activeAgent, ambiguous) {
  const who = ambiguous
    ? 'several sub-agents are in flight, so the caller cannot be attributed'
    : activeAgent === ''
      ? 'no sub-agent is in flight, so this call comes from the top-level session'
      : `agent '${activeAgent}' is not a declared writer of it`;
  const permitted = writers
    .map((w) => `${w.glob} → ${w.agents.join(', ')}`)
    .join('; ');
  return (
    `Gate guard: '${filePath}' is a devmate session artifact and ${who}. ` +
    'Session artifacts (the gate in .devmate/state/task.json, spec.md, and the ' +
    'evidence chain) are written by devmate\'s own hooks, never by hand — editing ' +
    'them forges the workflow\'s record of what happened, including the human ' +
    'spec approval. Let the workflow advance the gate on evidence instead. ' +
    `Declared artifact writers: ${permitted === '' ? 'none' : permitted}.`
  );
}

/**
 * Core guard decision function. Pure — no disk I/O.
 *
 * Rule order (first match wins):
 *   1. Config missing/invalid (E10 fail-safe): deny all source edits, return init-prompt.
 *   2. Unreadable state + source-edit → deny (session-artifact exception below).
 *   2b. Budget-critical marker present (E9-08) + non-cleanup source-edit → deny (compact to continue).
 *   3. Gate is plan-approved + source-edit → deny (session-artifact exception below).
 *   3b. Terminal-as-editor bypass: source-edit with no scopeable path (shell command) → deny (every gate).
 *   4. Session-artifact enforcement: protected path + agent is not its declared writer → deny; declared writer → allow.
 *   5. Persona scope: DELETED (#99) — PreToolUse carries no agent identity, so an
 *      edit cannot be attributed to a worker. The per-worker boundary is enforced
 *      at completion (hooks/post-tool-use.mjs). The number is retained so 6/7/8
 *      keep the names the code, docs and issues use.
 *   6. scope.md enforcement (P06): parsed scope present + source-edit outside allowedPaths/allowedGlobs → deny.
 *   7. TDD pre-condition (E12-2): impl-started + non-test source edit + no test evidence → deny.
 *   8. Default: allow.
 *
 * @param {HookPayload}   payload
 * @param {TaskState|null} state         Null when state file is missing or unparseable.
 * @param {ConfigResult}  configResult   Result of loading devmate.config.json.
 * @param {{ sessionArtifactPaths?: readonly string[], sessionArtifactWriters?: readonly SessionArtifactWriter[], activeAgent?: string, activeAgentAmbiguous?: boolean, scope?: ParsedScope, budgetCritical?: import('./types.mjs').BudgetCriticalMarker|null, editEscapesWorkspace?: boolean }} [opts]
 *   `activeAgent` is the identity Rule 4's *exception* gates on. It is an
 *   **input**, not a payload field: no VS Code PreToolUse event carries the
 *   calling agent's name (`agent_type` exists only on SubagentStart/Stop). #77
 *   named the input honestly and left the rule dormant; #93 gives it a producer
 *   — `hooks/subagent-budget-guard.mjs` stamps the host's `agent_type` onto
 *   `state.activeAgents` at SubagentStart, and `scripts/gate-guard.mjs` reads it
 *   back through {@link resolveActiveAgent}. The rule itself no longer *depends*
 *   on that identity: absent or ambiguous, it denies. Identity can only ever
 *   permit the one legitimate agent write (`spec-writer` → `spec.md`).
 * @returns {GuardDecision}
 */
export function evaluateGuard(payload, state, configResult, opts) {
  const isEdit = isSourceEditTool(payload.tool_name, payload.command, payload.namedPaths);
  // Defaults are the PROTECTIVE ones. `?? []` (what stood here) meant every
  // caller that forgot the input silently disabled the rule — and every caller
  // forgot (#93).
  const sessionPaths = opts?.sessionArtifactPaths ?? DEFAULT_SESSION_ARTIFACT_PATHS;
  const sessionWriters = opts?.sessionArtifactWriters ?? DEFAULT_SESSION_ARTIFACT_WRITERS;
  const activeAgent = opts?.activeAgent ?? '';
  const agentAmbiguous = opts?.activeAgentAmbiguous === true;
  const filePath = payload.path ?? '';
  const artifactVerdict = isEdit
    ? sessionArtifactVerdict(filePath, sessionPaths, sessionWriters, activeAgent)
    : /** @type {SessionArtifactVerdict} */ ('not-artifact');

  // Rule 1 — E10 fail-safe: config missing/invalid blocks all source edits
  if (!configResult.ok) {
    if (isEdit) {
      return {
        decision: 'deny',
        reason:
          'Gate guard: .devmate/devmate.config.json is missing or invalid. ' +
          'Run `devmate init` to declare your stack boundaries before making edits. ' +
          `(${configResult.error})`,
      };
    }
    return { decision: 'allow' };
  }

  // Rule 2 — unreadable state + source-edit
  if (state === null && isEdit) {
    // Session-artifact exception: a declared writer may write its own artifact.
    if (artifactVerdict === 'allow') return { decision: 'allow' };
    if (artifactVerdict === 'deny') {
      return {
        decision: 'deny',
        reason: sessionArtifactDenyReason(filePath, sessionWriters, activeAgent, agentAmbiguous),
      };
    }
    return {
      decision: 'deny',
      reason:
        'Gate guard: no active devmate task — source edits are only allowed inside a ' +
        'gated workflow. Start the task through the orchestrator (@orchestrator) so it ' +
        'classifies the lane and delegates the edit to @fullstack; do not edit source ' +
        'directly with a persona or by hand. (If a task should exist, its state file is ' +
        'unreadable — restore .devmate/state/task.json.)',
    };
  }

  // Rule 2b — E9-08: a critical session-budget breach blocks further source
  // edits until compaction clears the marker. Cleanup writes into .devmate/**
  // (compaction artifacts, session state) stay allowed so the recovery path
  // itself is never blocked.
  // TODO: calibrate after E7-2 evals — cleanup-allowlist during budget-critical is provisional
  const budgetCritical = opts?.budgetCritical ?? null;
  if (budgetCritical !== null && isEdit) {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const isCleanupPath = normalized.startsWith('.devmate/');
    if (!isCleanupPath) {
      return {
        decision: 'deny',
        reason:
          'Gate guard: session budget is CRITICAL ' +
          `(${budgetCritical.current} estimated tokens >= ${budgetCritical.limit} limit since ${budgetCritical.at}). ` +
          'Compact the session before continuing (run scripts/compact-session.mjs); ' +
          'compaction clears .devmate/state/budget-critical.json and edits resume.',
      };
    }
  }

  // Rule 3 — gate check: source edits are denied at EVERY gate before
  // impl-started, not just at plan-approved.
  //
  // This used to read `state.workflowGate === 'plan-approved'` — a single
  // hard-coded gate string — so every other gate fell through to the default
  // allow at the bottom of this function. With the gate frozen at `no-lane`
  // (nothing could advance it — #91), Rule 3 never fired at all, and the human
  // spec-approval gate was unenforced against direct source edits in every
  // session that ever ran. `spec-draft` and `spec-approved` were open too: a
  // spec awaiting review, or approved and not yet started, did not stop an edit.
  //
  // `isEditAllowedAtGate` is the fail-closed allowlist that has existed in
  // lib/gate-guard.mjs since v0.0.01, asserting exactly this policy in eight
  // green unit tests — while being imported by no production module at all. The
  // rule was written down and wired to nothing. It is wired now.
  if (state !== null && isEdit && !isEditAllowedAtGate(state.workflowGate)) {
    // Session-artifact exception. This is the one that matters in practice:
    // @spec-writer writes spec.md at `spec-draft`, a gate where source edits are
    // forbidden. A protected path with no declared writer falls through to the
    // artifact deny, which is more specific than the gate deny below.
    if (artifactVerdict === 'allow') return { decision: 'allow' };
    if (artifactVerdict === 'deny') {
      return {
        decision: 'deny',
        reason: sessionArtifactDenyReason(filePath, sessionWriters, activeAgent, agentAmbiguous),
      };
    }
    // Every deny names a next action; this one used to state the gate and stop,
    // leaving the caller (often an agent, which cannot ask) to guess. The move
    // out of here is lane-dependent — HITL-2 forbids the feature lane from
    // jumping straight to impl-started — so the recovery has to be lane-aware or
    // it would send half of callers the wrong way.
    //
    // The gates now advance on their own, on evidence, as each artifact lands
    // (hooks/gate-advance.mjs). So the honest recovery is no longer "run a
    // transition" — a caller has no tool that could — but "let the workflow
    // reach implementation": finish the stage whose artifact is missing, then
    // give the human approval the lane requires.
    // `state.lane` is already a normalized Lane in TaskState; compared inline
    // rather than importing normalizeLane, which would pull lib/workflow into
    // this module and create the import cycle Rule 6 also avoids.
    const lane = String(state.lane).toLowerCase();
    const nextMove =
      lane === 'feature'
        ? 'spec.md must be written (gate: spec-draft), then a human approves it with `approve spec`'
        : lane === 'bug'
          ? 'the diagnosis and grill must complete (gate: plan-approved), then a human approves with `approve plan`'
          : 'the chore lane advances to impl-started on its own once the router result is on disk';
    return {
      decision: 'deny',
      reason:
        `Gate guard: implementation has not started (gate: ${state.workflowGate}, lane: ${state.lane}). ` +
        `Source edits are allowed only from impl-started. To proceed, ${nextMove}. ` +
        // #177: name @fullstack as the editor ONCE the gate opens — never as an
        // action to take now. The dispatch gate refuses an @fullstack dispatch
        // before impl-started, so an unqualified "delegate to @fullstack" reads as
        // an immediately-available move that is itself blocked. The available
        // recovery is the lane next move above; @fullstack is who edits after it.
        'Do not edit source directly: @fullstack makes the edit once the gate reaches ' +
        'impl-started — it is not dispatchable before then.',
    };
  }

  // Rule 3b — terminal-as-editor bypass (fail closed, every gate). A source
  // edit with no concrete target path (shell commands carry `command`, not
  // `path`) cannot be checked by the persona-scope, scope.md, or TDD rules
  // below — all of which key on the edited path. Denying it uniformly closes
  // the hole where, once the gate reaches impl-started, the orchestrator (which
  // has no edit tool) edits source through the terminal (`sed -i`, `cat > file`,
  // a redirect, `tee`, `patch`, `git apply`) and slips past every path-keyed
  // rule straight to the default allow. Pre-impl this was already blocked by
  // Rule 3; this extends the same guarantee to impl-started and beyond. The
  // config-missing, unreadable-state, budget-critical, and plan-approved
  // denials above still take precedence with their more specific guidance.
  if (isUnscopeableSourceEdit(payload)) {
    // An unrecognized tool reaches here for a different reason than a terminal
    // edit does: it is gated by the fail-closed default, not because it is known
    // to write. Saying "terminal edits are blocked" would be a lie and would send
    // the caller chasing a shell command that does not exist.
    if (isUnrecognizedTool(payload.tool_name)) {
      // Name the path the tool asked for. The old reason told the caller to add
      // the tool to NON_SOURCE_EDIT_TOOLS in lib/gate-guard-core.mjs — devmate's
      // own library source, which a plugin consumer cannot touch (#94). A deny is
      // only worth emitting if the recipient can act on it.
      const named = Array.isArray(payload.namedPaths) ? payload.namedPaths : [];
      // Worded without the literal word "in-put" (spelled here as `arguments`):
      // the security lint's GraphQL heuristic reads `input <Word>` in any string
      // as a schema definition and flags the whole expression. Not worth an
      // eslint-disable — the sentence reads the same.
      const what =
        named.length > 0
          ? 'it names a file the guard protects: ' + formatGlobList(named)
          : 'the guard could read no arguments for it, so nothing about the call can be vetted';
      return {
        decision: 'deny',
        reason:
          `Gate guard: '${payload.tool_name}' is not a tool devmate recognizes, and ${what} — ` +
          'so it is treated as a source edit and denied (fail-closed). Route the change ' +
          'through @fullstack under an active task, using a file-edit tool (create_file, ' +
          'replace_string_in_file) whose target the persona-scope, scope.md and TDD rules ' +
          'can check. A tool that names no protected path is not gated at all.',
      };
    }
    return {
      decision: 'deny',
      reason:
        'Gate guard: source edits made through the terminal are blocked — the guard ' +
        'cannot verify their target against persona scope, scope.md, or the TDD gate, ' +
        'all of which key on the edited file path. Make code changes with a file-edit ' +
        'tool (e.g. replace_string_in_file / create_file) so they can be checked. The ' +
        'orchestrator has no edit tool and must delegate every code change to @fullstack ' +
        '— on the first turn and every follow-up alike — never editing source with sed, ' +
        'redirects, tee, patch, or git apply.',
    };
  }

  // Rule 4 — session-artifact enforcement (runs before persona scope).
  //
  // A flat path deny, not an identity check: `.devmate/state/**` and
  // `.devmate/session/**` are hook-written, so NO agent has a legitimate reason
  // to edit them, and the one that does (`spec-writer` → `spec.md`) is named in
  // `sessionArtifactWriters`. That inversion is what makes the rule enforceable
  // at all — PreToolUse carries no agent identity, so a rule that *needs* one to
  // deny can never deny (#93). Identity here can only permit, never gate.
  //
  // Closing this hole is what makes every other gate mean anything: with
  // task.json writable, an agent forges `"workflowGate": "impl-started"` and the
  // human spec approval that SubagentStart checks for is a file the agent wrote
  // itself.
  if (artifactVerdict === 'allow') return { decision: 'allow' };
  if (artifactVerdict === 'deny') {
    return {
      decision: 'deny',
      reason: sessionArtifactDenyReason(filePath, sessionWriters, activeAgent, agentAmbiguous),
    };
  }

  // Rule 5 — persona scope ownership. DELETED (#99). Deliberately, and with the
  // guarantee moved somewhere it can actually be kept — not dropped.
  //
  // The rule was dormant from the day it shipped: it needed a persona pinned on
  // task state, and nothing ever pinned one. #77 documented that and left it in
  // place; #92's comment here argued to keep it, on the grounds that Rule 6
  // bounds edits to the TASK's contract while only Rule 5 could bound them to the
  // WORKER's territory — true, and the reason a task-wide scope.md cannot stop a
  // parallel frontend worker editing a backend file that is legitimately in the
  // task's scope.
  //
  // What settles it is the captured payload. **A PreToolUse event carries no
  // agent identity of any kind** — `session_id`, `tool_name`, `tool_input`,
  // `tool_use_id`, `cwd`, and nothing else
  // (test/fixtures/hook-payloads/captured/pretooluse.read-file.json). `agent_type`
  // exists only on SubagentStart/Stop. So an edit arriving at this hook cannot be
  // attributed to one of several concurrent workers — not from a roster, not from
  // a persona pin, not from any parent link the host might add to SubagentStart
  // (`agent_id` is the spawning `runSubagent`'s `tool_use_id` — a real parent
  // link, and useless here, because the edit event carries nothing to join it
  // against). Every design that gates an edit on the persona is unimplementable
  // on this surface; a scalar `activePersona` would have to be a guess, and a
  // wrong guess does not fail open — it feeds a non-persona string to `ownsFile`
  // and denies EVERY edit (#77's trap).
  //
  // A rule that reads as a boundary and enforces nothing is worse than no rule:
  // it is why three consecutive issues found "enforced" layers that never ran. So
  // the per-worker boundary lives — solely and honestly — at COMPLETION time,
  // where a dispatch's `persona` and its `changedFiles` are paired cleanly and
  // parallel-safely: `filesOutsidePersonaScope` (this module) via
  // `assertPersonaScope`, enforced by `hooks/post-tool-use.mjs` on every
  // `runSubagent` return and by `scripts/orch-assert-persona-scope.mjs`. #99 made
  // that layer actually fire (it read the persona from `tool_input`, which arrives
  // as the literal string "..."), which is the precondition for deleting this one.
  //
  // Rule 6 (below) remains the edit-time per-file boundary, and it needs no
  // identity — the task's scope contract binds every worker in it. The numbering
  // is kept so the rule names in the code, the docs and five issues still line up.

  // Rule 6 — scope.md enforcement (P06). The per-file boundary: a source edit
  // outside the lane's contract is denied. Uses the already-available matchGlob
  // from this module — no import cycle.
  //
  // FAIL-CLOSED once implementation has started (#92). This used to be
  // `if (… && opts?.scope)`: no scope, no check, edit allowed — so an ABSENT
  // contract was maximally permissive while an EMPTY one was maximally
  // restrictive (both arrays empty → every edit denied). The polarity was
  // exactly backwards, and since no lane ever wrote a scope.md, the permissive
  // branch was the only one that ever ran.
  if (isEdit && filePath !== '' && state !== null && isEditAllowedAtGate(state.workflowGate)) {
    // #187: contain the EDIT TARGET first — an edit whose path resolves OUTSIDE
    // the workspace root is denied REGARDLESS of the scope contract. matchGlob is
    // fuzzy: a wildcard-leading glob (incl. the always-on test-glob floor) matches
    // an out-of-workspace path segment-by-segment, so #170/#180's write-side scope
    // sanitization cannot close this — only resolving the target against the root
    // can. The caller resolves it (pathEscapesWorkspace in lib/workflow/scope.mjs)
    // and hands the verdict, keeping this evaluator pure. The runtime PreToolUse
    // guard always provides it; absent, the check is skipped (unchanged behavior).
    if (opts?.editEscapesWorkspace === true) {
      return {
        decision: 'deny',
        reason:
          `Gate guard: '${filePath}' resolves OUTSIDE the workspace root — denied regardless ` +
          'of scope.md. Source edits must target a file inside the workspace; a `..` traversal ' +
          'or an absolute path pointing elsewhere is never in scope, even if a glob would match it.',
      };
    }
    if (!opts?.scope) {
      return {
        decision: 'deny',
        reason:
          `Gate guard: no scope contract for this task (gate: ${state.workflowGate}, lane: ${state.lane}). ` +
          'Implementation may not edit source without .devmate/session/<taskId>/scope.md — ' +
          "the lane's scope producer (@planner, or @diagnose on the bug lane) must return its " +
          'file list before implementation begins.',
      };
    }

    const scope = opts.scope;
    const normPath = filePath.replace(/\\/g, '/');
    const inPaths = scope.allowedPaths.some(
      (p) => p.replace(/\\/g, '/') === normPath,
    );
    const inGlobs = scope.allowedGlobs.some((g) => matchGlob(g, normPath));
    if (!inPaths && !inGlobs) {
      return {
        decision: 'deny',
        reason:
          `Gate guard: '${filePath}' is out of scope per scope.md (lane: ${scope.lane}). ` +
          `allowedPaths: ${formatGlobList(scope.allowedPaths)}; ` +
          `allowedGlobs: ${formatGlobList(scope.allowedGlobs)}. ` +
          'Edit a path inside the contract, or re-plan to widen the scope — do not edit around it.',
      };
    }
  }

  // Rule 7 — TDD pre-condition (E12-2): only enforced during impl-started.
  if (
    state !== null &&
    isEdit &&
    state.workflowGate === 'impl-started' &&
    filePath !== ''
  ) {
    const guardState = state.tddGuard ?? {
      testFileWritten: false,
      consecutiveNonTestWrites: 0,
      overrideGranted: false,
    };
    const testGlobs = configResult.config.testGlobs ?? DEFAULT_TEST_GLOBS.slice();
    const tdd = evaluateTddPreCondition(filePath, guardState, testGlobs);
    if (tdd === 'block') {
      return {
        decision: 'deny',
        reason:
          `Gate guard: TDD pre-condition denied write to '${filePath}'. ` +
          'Write a test file first, or override with: approve no-tdd reason="<justification>".',
      };
    }
    // allow flows through; the caller persists the next guard state.
  }

  // Rule 8 — default allow
  return { decision: 'allow' };
}
