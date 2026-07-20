# Gate Guard — Documentation

`scripts/gate-guard.mjs` is the sole `PreToolUse` hook for source-code edit protection in devmate.
It reads persona boundaries from `devmate.config.json` (E10 re-spec) instead of hardcoded lane scopes.

---

## Fail-Safe Rule

If `devmate.config.json` is **missing or invalid**, the gate guard **blocks ALL source-edit tool calls**
and outputs a `deny` decision with the message:

```
Gate guard: devmate.config.json is missing or invalid.
Run `devmate init` to declare your stack boundaries before making edits.
```

This is stricter than a simple fail-closed policy: the guard actively tells the agent _how to recover_.
Non-edit tools are always allowed (reading, listing, etc.) even without a config.

---

## Tool/Path Extraction Matrix (default-deny, E9-12)

The guard classifies a tool call as a **source-edit operation** by **the path the
call names**: it allows only what it can positively classify as read-only, and
treats every write mechanism — every unclassifiable shell command that references
a source path, and every unrecognized tool whose input names one — as an edit.

> **The polarity is the whole point.** Until #74 this table's *intent* was
> default-deny while the code did the opposite: it kept an allowlist of **edit**
> tools, which fails **open** — any tool not on it was waved through. The list
> held Anthropic-shaped names (`str_replace_editor`, `write_file`,
> `replace_in_file`), none of which VS Code sends, so the guard denied nothing
> for the entire life of the project.
>
> **#74's fix — deny anything not on the read-only allowlist — overshot.** It
> denied every MCP and extension-contributed tool on first contact (the reported
> case: `session_store_sql`, which edits nothing), with a message telling the
> caller to patch `lib/gate-guard-core.mjs` — devmate's own library source, which
> a plugin consumer cannot touch. #94 keys the classifier on the **named path**
> instead. That is *stronger* than a name list, not weaker: every VS Code edit
> tool names its target (`filePath`, `dirPath`, `replacements[].filePath`,
> `files[]`, the `apply_patch` body), so a renamed `replace_string_in_file` still
> carries `filePath` and is still gated. And denying a tool that names no path
> protected nothing in the first place — **every rule below keys on a file
> path**, so such a call has nothing for persona scope, `scope.md`, the
> session-artifact rule, or TDD to check.
>
> The residual hole, stated plainly: an unknown tool that writes source through a
> path the scanner cannot see. The one such tool that demonstrably exists — the
> terminal — is still handled by the shell analyzer, so `sed -i`, redirects,
> `tee`, `patch` and `git apply` stay blocked. That hole is narrower than denying
> the whole MCP ecosystem to paper over it.

| Vector | Condition | Source-Edit? |
| --- | --- | --- |
| VS Code edit tools: `replace_string_in_file`, `create_file`, `insert_edit_into_file`, `multi_replace_string_in_file`, `apply_patch`, `edit_notebook_file`, `create_directory`, `edit_files` | any — including an input the guard cannot parse | **YES** |
| **an unrecognized tool** (MCP / extension-contributed / a name VS Code adds tomorrow) | its `tool_input` names a source-extension path or any path under `.devmate/`, under **any** key (`path`, `uri`, a `file://` URI, nested in an object or array) — `namedPaths` in `lib/hooks/tool-input.mjs` | **YES** |
| **an unrecognized tool** | its `tool_input` names no such path (`{"query": "SELECT * FROM sessions"}`) | no |
| **an unrecognized tool** | no `tool_input` was inspected at all (e.g. an eval scoring off a trace `actionType`) | **YES** (fail closed) |
| `run_in_terminal` | any `>` / `>>` redirect (including `2>` etc.) onto a source-extension target | **YES** |
| `run_in_terminal` | in-place editor family: `sed -i`, `perl -i`, `git apply`, `patch`, `tee`/`mv`/`cp` onto a source path or session artifact | **YES** |
| `run_in_terminal` | opaque inline interpreters: `python -c`, `python3 -c`, `node -e`/`--eval` (embedded code cannot be analyzed — fail closed) | **YES** |
| `run_in_terminal` | interpreter wrapper heads: `bash`, `sh`, `zsh`, `dash`, `ksh`, `pwsh`, `powershell`, `cmd` (their script argument is opaque — fail closed, #128) | **YES** |
| `run_in_terminal` | any command with an unbalanced quote that references a source-path token anywhere inside it | **YES** (fail closed) |
| `run_in_terminal` | PowerShell write cmdlets: `Set-Content`, `Out-File`, `Add-Content` | **YES** |
| `run_in_terminal` | unclassifiable command referencing a source-path token | **YES** (fail closed) |
| `run_in_terminal` | known read-only commands (`cat`, `grep`, `ls`, `head`, `tail`, `find`, `rg`, …) without a redirect; plain `node`/`node --test`/`npm`/`npx`/`git` (except `git apply`) | no |
| read / search / inspect: `read_file`, `grep_search`, `semantic_search`, `file_search`, `list_dir`, `get_errors`, `get_terminal_output`, … | on the allowlist | no |
| control plane: `runSubagent`, `manage_todo_list`, `switch_agent`, `vscode_askQuestions`, … | on the allowlist | no |

`runSubagent` **must** stay on the allowlist: it falls through to `evaluateGuard`,
so classifying it as an edit would make Rule 2 ("no active devmate task") deny
every dispatch before a task exists — deadlocking the orchestrator, since dispatch
is the only way a task ever starts.

Tool names are the VS Code wire values (`tool_name`), ground-truthed against the
`ToolName` enum in `microsoft/vscode-copilot-chat`
(`src/extension/tools/common/toolNames.ts`) and captured payloads — **not** the
VS Code docs, which do not enumerate them and tell you to read the agent logs.

**What counts as a file read** is owned by `FILE_READ_TOOLS` / `isFileReadTool`
(`lib/gate-guard-core.mjs`) — the subset of the read-only allowlist whose
successful call means a file's contents were read, and the set PostToolUse
records evidence pointers from. It is spread into the allowlist above, so a name
cannot be a read to PostToolUse and a source edit to PreToolUse (#95). PostToolUse
hand-authored its own set until then, and it asserted two names (`open_file`,
`view_file`) that appear in no captured VS Code payload and in no other list; they
were dropped as ungrounded rather than added.

**What counts as a named path** is owned by `isWriteTargetToken`
(`lib/gate-guard-core.mjs`): a source extension (`.mjs`, `.ts`, `.tsx`, `.js`,
`.jsx`, `.cjs`, `.json`), or any location under `.devmate/` whatever the
extension — session artifacts are protected by *where they live*, not by what
they are named (#93). The shell analyzer and the unrecognized-tool classifier ask
the same function, so they cannot drift apart. The walk over `tool_input` is
bounded (depth 4, 200 nodes) and extension-anchored, which is what keeps it from
reading prose or SQL as a filename.

## Output schema

VS Code honors a PreToolUse verdict **only** under
`hookSpecificOutput.permissionDecision` (`allow` | `deny` | `ask`):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
```

A bare top-level `{"decision": "deny"}` is the **PostToolUse/Stop** schema and is
silently ignored on PreToolUse — the tool runs anyway. devmate emitted exactly
that until #74, so every deny the guard computed was discarded. `GuardDecision`
remains the evaluator's internal type; `toPreToolUseOutput` translates it at the
boundary, once.

Pipelines are analyzed per segment, so `echo hack | tee -a lib/app.mjs` is an edit
even though the pipeline starts with a read-only command. Tokenization is
quote-aware (#128): a redirect character, pipeline operator, or cmdlet name
inside a quoted argument is ordinary text, so `git commit -m "renamed > foo.mjs"`
is not a write — while `tee` onto a source path or session artifact, and every
unquoted redirect, stay denied. `tee` onto a non-source target
(`npm test 2>&1 | tee test-results.log`) is not an edit.

> **Fail-closed stance**: the guard allows only what it can positively classify as
> read-only. A shell command it cannot classify that touches a source-path token is
> treated as an edit and becomes subject to gate, scope, persona, and TDD rules.

---

## Session-Artifact Protection

Session artifacts are the files the workflow's trustworthiness reduces to: the
gate itself (`.devmate/state/task.json`), the human-approved contract
(`.devmate/session/spec.md`), and the evidence chain (`plan.json`,
`discovery.json`, `diagnosis.json`, `scope.md`, `trace.jsonl`). **No agent may
hand-edit them.** They are written by devmate's own hooks — and a hook is not a
tool call, so it never meets this guard.

The rule is a **flat path deny with one identity-gated exception**, in that
order:

1. A source-edit whose target matches `sessionArtifactPaths` is denied.
2. Unless the calling agent is a declared writer of that path in
   `sessionArtifactWriters` — in practice `spec-writer` → `spec.md`, the only
   artifact an agent rather than a hook produces.

The exception is also what lets `spec-writer` work at all: it writes `spec.md` at
the `spec-draft` gate, where source edits are otherwise forbidden (Rule 3).

**Why deny-first rather than identity-first.** A VS Code `PreToolUse` payload
carries no agent name — `agent_type` exists only on `SubagentStart`/`SubagentStop`.
A rule that *needs* an identity in order to deny therefore can never deny, which
is exactly what happened: the check was `undefined === allowed`, permanently
false, and (because `sessionArtifactPaths` defaulted to `[]` and no caller ever
passed one) the whole rule was skipped on every real call for the life of the
plugin. Identity here can only ever **permit**; absence of identity denies (#93).

**Where the identity comes from.** `hooks/subagent-budget-guard.mjs` stamps the
host's `agent_type`/`agent_id` onto `task.json` as `activeAgents` at
`SubagentStart` and removes the entry at `SubagentStop`;
`scripts/gate-guard.mjs` reads it back through `resolveActiveAgent`. It is
evidence the host recorded, not a claim the model made.

**Parallel dispatch.** The feature lane runs `@fullstack` ×N concurrently, so
several sub-agents can be in flight when a tool call arrives, and nothing on the
event says which one is calling. Resolved explicitly:

| In flight | Resolved identity | Effect on an artifact write |
| --- | --- | --- |
| One agent (or N instances of the same agent) | that agent's name | permitted only if it is a declared writer |
| Two or more different agents | none — ambiguous | **denied** (unattributable) |
| None (top-level session) | none | **denied** |

**"Ambiguous" is the NORMAL state during implementation — not an edge case.** A
persona wrapper (`@backend`) does not edit; it dispatches `@fullstack`, which
holds the edit tool. Both are sub-agents, so the roster during an implementation
dispatch reads `[backend, fullstack]` — a mixed set — and every parallel
workstream adds another pair (`[backend, fullstack, frontend, fullstack]`). So
`resolveActiveAgent` returns `ambiguous` and Rule 4 denies session-artifact writes
for the whole implementation phase. **That is correct, and nothing is lost by it:**
`@fullstack` has no business writing `task.json` or `spec.md`, and `@spec-writer`
— the one agent with a legitimate artifact write — is dispatched directly, with no
wrapper, so it resolves cleanly to a single identity and its allow path is
untouched. Do not "fix" the ambiguity; it is the rule working (#93, #99).

**Path spelling.** Both the workspace-relative (`.devmate/state/task.json`) and
absolute (`C:\ws\.devmate\state\task.json`) forms are reduced to the `.devmate/…`
tail before matching, so the easier-to-produce spelling is not the unprotected
one.

**Terminal writes.** `.md` is not a source extension, so `echo … > spec.md` used
to be classified as a non-source write and sailed through both this rule and the
terminal-as-editor rule. The shell analyzer now treats **any path under
`.devmate/` as a write target regardless of extension** — session artifacts are
protected by location, not by file type — so redirects, `tee`, and `sed -i`
against them are denied by Rule 3b (a shell command carries `command`, not
`path`, so it is unscopeable and fails closed). Reads (`cat .devmate/state/task.json`)
stay allowed.

Defaults, applied whenever `devmate.config.json` declares nothing — the default
is *protective*, because "the caller forgot the input" is how this rule stayed
dormant:

```json
{
  "sessionArtifactPaths": [".devmate/state/**", ".devmate/session/**"],
  "sessionArtifactWriters": [
    { "glob": ".devmate/session/**/spec.md", "agents": ["spec-writer"] }
  ]
}
```

---

## Guard Decision Rules (applied in order)

**Dispatch pre-check (HITL-1, P26).** Before the edit-only rules below, the
`scripts/gate-guard.mjs` wrapper runs a lane-gated implementation-dispatch check
for `runSubagent` calls. When the dispatched agent is an implementation agent
(`fullstack` + the persona wrappers `backend`/`frontend`/`editor`) and the lane's
gate/artifacts are absent (no `task.json`, gate ≠ `impl-started`, or the lane's
required spec/diagnosis/scope.md missing), the wrapper emits a `deny` and
returns before `evaluateGuard` runs. `evaluateGuard` itself stays pure and
edit-only — a `runSubagent` call is not a source-edit tool, so the rules below
never apply to it. The shared predicate is `evaluateImplementationDispatch`
(`lib/workflow/dispatch-gate.mjs`), also enforced independently at `SubagentStart`
(`hooks/subagent-budget-guard.mjs`) and mirrored by the advisory CLI
`scripts/orch-assert-fullstack.mjs`.

1. **Config fail-safe**: `devmate.config.json` missing or invalid + source-edit → `deny` (init-prompt).
2. **Unreadable state**: `task.json` missing or malformed + source-edit → `deny` (until state is restored).
3. **Gate check**: gate is `plan-approved` + source-edit → `deny` (implementation not started).
3b. **Terminal-as-editor bypass** (every gate): a source-edit with no scopeable target path — i.e. a shell command that writes source (`sed -i`, a `>`/`>>` redirect, `cat > file`, `tee`, `patch`, `git apply`, …) — → `deny`. Such an edit carries `command`, not `path`, so the persona-scope, `scope.md`, and TDD rules below (all keyed on the path) cannot vet it; it fails closed. Pre-impl this is already covered by Rule 3, but Rule 3b extends the same guarantee to `impl-started` and later gates, closing the hole where the orchestrator (which holds no edit tool) edits source through the terminal on follow-up turns. Make code changes with a file-edit tool so they carry a path and are checked; the orchestrator must delegate all code changes to `@fullstack`.
4. **Session artifact**: path matches `sessionArtifactPaths` → `deny`, unless the in-flight agent is a declared writer of that path in `sessionArtifactWriters` (`spec-writer` → `spec.md`) → `allow`. No identity, or an ambiguous one (several different sub-agents in flight), denies. See [Session-Artifact Protection](#session-artifact-protection) — the deny needs no agent identity, which is what makes it enforceable at an event that carries none (#93). Rules 2 and 3 consult the same verdict, so a declared writer may write its artifact even when task state is unreadable or the gate forbids source edits.
5. **Persona scope**: **DELETED (#99).** There is no per-edit persona rule, and there cannot be one on this surface: a `PreToolUse` payload carries **no agent identity of any kind** — `session_id`, `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `transcript_path`, and nothing else (`test/fixtures/hook-payloads/captured/pretooluse.read-file.json`, asserted in `test/conformance/agent-identity.test.mjs`). `agent_type` exists only on `SubagentStart`/`SubagentStop`. So when the feature lane runs backend and frontend workers concurrently, an edit arriving here cannot be attributed to either — not from the `activeAgents` roster, not from a pinned `activePersona`, and not from any parent link the host might add to `SubagentStart` (`agent_id` **is** already a parent link — it is the spawning `runSubagent`'s `tool_use_id` — and it is useless here, because the edit event carries nothing to join it against). The rule shipped dormant for the plugin's whole life (nothing ever wrote `activePersona`), and a rule that reads as a boundary while enforcing nothing is worse than no rule. The per-worker boundary now lives **solely** at completion time — see [Completion-time persona-scope verification](#completion-time-persona-scope-verification), which #99 also made actually fire. Rule numbers 6/7/8 are unchanged so the names in the code, the docs and the issue history still line up.
6. **scope.md enforcement (P06)**: parsed scope present + source-edit outside `allowedPaths`/`allowedGlobs` → `deny`. This is the primary, concurrency-safe per-file boundary. **All three lanes now write a `scope.md`** before implementation — bug (`@diagnose` bugScope), chore (proposed files), and feature (the plan's "Files that will change" list, plus a test-glob floor so TDD can create test files). A file outside the scope is a genuine scope change and re-enters planning, not a silent edit.
   - **Edit-path containment (#187)**: FIRST, before the glob match, an edit whose target **resolves outside the workspace root** — a `..` traversal or an absolute path pointing elsewhere — is denied regardless of `scope.md`. `matchGlob` is fuzzy (a `**` consumes any segments), so a wildcard-leading glob — including the always-on test-glob floor — matches an out-of-workspace path and would otherwise authorize the escaping edit. Write-side scope sanitization (#170 paths / #180 globs) cannot close this; only resolving the target against the root can. The pure evaluator does no path I/O — the runtime guard (`scripts/gate-guard.mjs`) resolves the target (`pathEscapesWorkspace`, `lib/workflow/scope.mjs`) and hands the verdict.
7. **TDD pre-condition (E12-2)**: `impl-started` + non-test source edit with no test evidence → `deny`.
8. **Default**: `allow`.

---

## Deny Message Examples

| Scenario                            | Reason Message                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Config missing                      | `Gate guard: devmate.config.json is missing or invalid. Run 'devmate init' to declare your stack boundaries before making edits.` |
| State unreadable                    | `Gate guard: task state is unreadable. Edit blocked until state is restored.`                                                     |
| Gate is plan-approved               | `Gate guard: implementation not yet started (gate: plan-approved).`                                                               |
| Edit outside the scope contract     | `Gate guard: 'infra/deploy.sh' is out of scope per scope.md (lane: feature). allowedPaths: …` (Rule 6 — the per-file boundary that replaced the persona rule)  |
| Unauthorized session artifact write | `Gate guard: '.devmate/state/task.json' is a devmate session artifact and agent 'fullstack' is not a declared writer of it. … Declared artifact writers: .devmate/session/**/spec.md → spec-writer.` |

---

## Completion-time persona-scope verification

This is the **only** per-worker edit boundary — the sole owner of the guarantee
that a `frontend` worker does not edit a backend file. Rule 5 used to claim it at
the tool call and never enforced it; it was deleted in #99 (a `PreToolUse` payload
carries no agent identity, so an edit cannot be attributed to one of several
concurrent workers). The **per-persona partition and off-limits** are checked at
the *completion* of each `@fullstack` dispatch instead, where `persona` and the
returned `changedFiles` are cleanly paired and parallel-safe.

**Where the persona comes from: the worker's own returned contract.** A
`@fullstack` reply carries `persona` at the top level, next to `agentName`
(`agents/fullstack.agent.md`), and `personaFromAgentResult`
(`lib/hooks/agent-result.mjs`) reads it from `tool_response`. It is **not** read
from `tool_input` — that is where the persona is *sent*, but a `runSubagent`'s
`tool_input` reaches the hook elided to the literal string `"..."`
(`test/fixtures/hook-payloads/captured/posttooluse.run-subagent.json`), so
`tool_input.persona` was `undefined` on every real dispatch. It was also the
condition guarding this entire block, which is how the check — and the TDD
tripwire behind it — spent the plugin's life computing nothing (#99).

Two consequences worth stating:

- **Parallel fan-out is handled.** `tool_response` belongs to one dispatch, so
  concurrent backend and frontend workers are attributed independently. No roster,
  no scalar pin, no guess.
- **Consumer-declared personas are handled.** `backend`/`frontend`/`editor` have
  wrapper agents, so their names appear on the wire as an `agent_type`; a repo whose
  personas are `api` and `web` has no wrapper for them (`PERSONA_MAP` is a hardcoded
  three-name table) and dispatches them as plain `@fullstack`, so no host event ever
  mentions them. Because the persona rides the *reply*, not the wire, both are
  enforced identically. A design keyed on the wrapper's name would have covered the
  default three and silently left everyone else unbounded.
- **A reply that declares no `persona` fails closed** — `persona_missing`, a contract
  violation. If it skipped the check instead, a worker could opt out of its own
  territory by omitting one field.

`filesOutsidePersonaScope(persona, changedFiles, config)` (`lib/gate-guard-core.mjs`,
built on `ownsFile`) reports a changed file as a violation only when it is owned
by a **different** declared persona (a partition breach) or matches this
persona's `offLimitsGlobs` (an explicit breach). A file owned by **no** persona
(shared contracts, docs, root configs) is **not** a violation — `scope.md`
(Rule 6) already governs those, so flagging them would false-positive on
legitimately-planned shared edits.

Two layers call the same check:

- **`scripts/orch-assert-persona-scope.mjs`** — the orchestrator runs it after
  `orch-assert-dispatch` for every `@fullstack` dispatch (clean attribution;
  authoritative halt in `block` mode).
- **`hooks/post-tool-use.mjs`** — a prompt-independent backstop on every
  `runSubagent` completion, and since #99 the layer that actually runs. It reads
  both `persona` and `changedFiles` from `tool_response` (this one dispatch's
  result — **not** the task-wide fact ledger, which interleaves concurrent
  personas), so it stays parallel-safe.

A violation appends a `contract_violation` trace event (`contract:
'persona-scope'`). The `personaScope` config mode governs the response —
`off` (no check) | `warn` (record + surface to the model via `additionalContext`,
do not halt; **default**) | `block` (halt the dispatch with a top-level
`decision: "block"`, the only field VS Code reads on `PostToolUse`). The two modes
were indistinguishable in the code until #99 — both emitted a block — which went
unnoticed only because the check never fired; honoring `warn` is what keeps
switching it on from silently turning every consumer's default into a halt.

The check trusts the subagent's self-reported `persona` and `changedFiles`. That
is the honest limit of this surface: they are the only per-dispatch-attributable
signals a hook receives under parallel dispatch, and `changedFiles` was already
trusted the same way.

| Scenario | Reason id | Message |
| --- | --- | --- |
| Persona edited another persona's file | `persona_scope_violation` | `Persona "backend" edited files outside its territory: src/ui/x.mjs. Revert them, or dispatch the persona that owns those paths.` |
| `@fullstack` reply declares no `persona` | `persona_missing` | `This @fullstack dispatch returned no persona, so devmate cannot check its edits against a territory. Include the persona you were dispatched with at the top level of your JSON reply.` |

## devmate.config.json Format

```json
{
  "schemaVersion": 1,
  "personas": [
    {
      "persona": "backend",
      "editableGlobs": ["src/api/**", "lib/**", "scripts/**"],
      "offLimitsGlobs": ["src/ui/**"]
    },
    {
      "persona": "frontend",
      "editableGlobs": ["src/ui/**", "components/**"],
      "offLimitsGlobs": ["src/api/**", "lib/**"]
    }
  ]
}
```

Create this file in the repo root by running `devmate init`.

---

_Synced with `lib/gate-guard-core.mjs` — `NON_SOURCE_EDIT_TOOLS` (the read-only allowlist), `FILE_READ_TOOLS` (the file-read subset PostToolUse derives from), `KNOWN_SOURCE_EDIT_TOOLS`, `SHELL_TOOLS`, and `isWriteTargetToken` (what counts as a named path) — and with `namedPaths` in `lib/hooks/tool-input.mjs`._
