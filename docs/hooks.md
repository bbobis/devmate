# devmate Hook Registration Model

## Supported surface: GitHub Copilot in VS Code

devmate targets **GitHub Copilot running in VS Code**, and nothing else. Copilot
CLI and the Copilot cloud agent are **not** supported surfaces.

This is a load-bearing statement, not a preference. The two surfaces have
*different hook contracts* — different tool names, different payload keys,
different output shapes, different subagent identity fields — and devmate was
accidentally half-built for each, which is exactly how five production defects
(#72, #74, #75, #76, #77) hid in plain sight: three enforcement layers were
registered, documented, and completely inert. Code that "also handles" the CLI
shape is not extra safety. It is a second contract nobody tests, and it is what
lets a wrong assumption look like a working feature.

If you find a CLI-shaped name, key, or output shape anywhere in `hooks/`,
`scripts/`, or `lib/` — `str_replace_editor`, `tool_input.path`, `toolName`,
`agentName` on a subagent event, `{"decision":"deny"}` on PreToolUse — it is a
bug, and `test/conformance/hooks-contract.test.mjs` should have caught it.

## Canonical Model

devmate uses **one** hook registration model: `hooks/hooks.json`.

This is the single source of truth for all Copilot hook registrations. No other
hook scaffolding (`.yml`, `.ps1`, or `.devmate/hooks/`) is used or supported.

Official event names sourced from:
https://code.visualstudio.com/docs/copilot/customization/hooks

**Why not agent-frontmatter hooks?** VS Code supports per-agent `hooks:` in
frontmatter (gated on `chat.useCustomAgentHooks`), which would scope hooks to
devmate's own agents natively. It was evaluated and rejected as structurally
unusable for a *plugin*: the host does **not** expand `${PLUGIN_ROOT}` inside
frontmatter commands, and it runs them with cwd = the *workspace* — so a
plugin-shipped agent has no path form (absolute-via-token or relative) that
resolves to its own scripts. Both forms were verified failing in-host. Only a
plugin-level `hooks/hooks.json` command resolves. Scoping therefore happens at
runtime (next section), not at registration.

---

## Runtime session-scoping

Plugin-level hooks fire in **every** Copilot session, including sessions that
never touch devmate. devmate must not block, write `.devmate/state`, or inject
context in those sessions — so each state-writing or blocking handler scopes
itself at runtime to a *devmate session*.

- **What marks a session.** A session becomes "devmate" the first time a devmate
  agent is dispatched. `hooks/subagent-budget-guard.mjs`, on a `SubagentStart`
  whose `agent_type` is in the frozen roster ([lib/agents/roster.mjs](../lib/agents/roster.mjs)),
  writes a per-`session_id` marker into the OS temp dir via
  [lib/hooks/session-marker.mjs](../lib/hooks/session-marker.mjs). The marker is
  activity-refreshed with a 7-day TTL and is **not** cleared on `Stop`: VS Code
  reuses a chat `session_id` across window reloads, and `Stop` fires per *turn*,
  while a devmate workflow spans many turns (the human spec-approval gate is
  answered in a later turn). An abandoned thread ages out instead.
- **What the marker gates.** `gate-guard` checks it first and emits `allow`
  before reading any `task.json`; `post-tool-use`, `gate-advance`,
  `spec-integrity-guard`, `contract-validator`, and `check-session-budget`
  (hook-shaped invocation only) return inert without it. This is fail-open by
  construction: a session devmate cannot positively identify as its own is never
  blocked.
- **The one marker-independent check.** An implementation dispatch
  (`runSubagent` → `fullstack` or a persona-wrapper) is gate-checked even with no
  marker yet. It self-identifies as devmate (plain Copilot never dispatches those
  agents) and is the highest-risk gate, so `gate-guard` denies it at dispatch
  time on the session's *first* dispatch — otherwise a worker could start at a
  pre-implementation gate before any `SubagentStart` marked the session.
- **Intentionally not gated.** `session-start` (already inert without a
  `.devmate/devmate.config.json`), `approval-listener` (its `<devmate-skills>`
  menu is the bootstrap/discovery surface a first-time user needs), and
  `compact-session` (reads no stdin; also the user-run budget-critical remedy).

Independent of `chat.useCustomAgentHooks`: that setting gates frontmatter hooks
only, so devmate's plugin-level hooks run whether or not it is enabled.

---

## Two roots: plugin root vs repo root

Hook code resolves paths against **two different roots**, and conflating them is
a bug:

| Root | What lives there | How to resolve it |
| --- | --- | --- |
| **Plugin root** | What devmate *ships*: `hooks/hooks.json`, `scripts/`, `agents/`, `skills/`, `config/` | `resolvePluginRoot()` (lib/plugin-root.mjs) |
| **Repo root** | What the *user* owns: `.devmate/` (config, memory, session state), their source | `resolveRepoRoot()` (lib/init/repo-root.mjs) |

A repo that installs devmate has a `.devmate/` directory but **no `hooks/` or
`scripts/` of its own** — those exist only in the plugin's install directory.
So resolving a plugin-shipped artifact against the repo root can only ENOENT.
It is invisible when developing devmate itself, because there the two roots are
the same directory.

This is the same rule the `${PLUGIN_ROOT}` token enforces for hook *commands*
(below), applied to hook *code*. Before #72 the SessionStart readiness check
looked for the plugin's `hooks/hooks.json` inside the consumer's repo; it could
never be found, so readiness failed and the whole initializer was skipped for
every plugin user. Any code reaching for a shipped artifact must go through
`resolvePluginRoot()`.

---

## hooks/hooks.json format

```json
{
  "schemaVersion": 1,
  "hooks": {
    "<EventName>": [
      {
        "type": "command",
        "event": "<EventName>",
        "command": "node \"${PLUGIN_ROOT}/scripts/<hook-script>.mjs\"",
        "windows": "node \"${PLUGIN_ROOT}\\scripts\\<hook-script>.mjs\"",
        "timeout": 10
      }
    ]
  }
}
```

- `type` must always be `"command"` (the only supported type).
- `event` must be one of the **official** VS Code hook event names below.
- `command` is the full command VS Code runs for the hook. It must invoke the
  `.mjs` entrypoint through the `node` runtime. A bare `.mjs` path is not a
  runnable command on every OS (on Windows it is not a recognised executable),
  so the `node` prefix keeps hooks cross-platform. Official command examples
  carry a runtime prefix; see the VS Code hooks doc:
  https://code.visualstudio.com/docs/copilot/customization/hooks
- The script path must use the plugin-root token, not a relative path. When the
  plugin is installed, hooks run from a location outside the consumer's
  workspace, so a relative path like `scripts/session-stop.mjs` resolves against
  the consumer's workspace and fails with MODULE_NOT_FOUND. devmate uses the
  Claude plugin format, whose plugin-root token is `${PLUGIN_ROOT}`. VS
  Code expands this token to the plugin's absolute install path at runtime, so
  `node "${PLUGIN_ROOT}/scripts/session-stop.mjs"` always resolves to the
  shipped script. See the VS Code plugin doc:
  https://code.visualstudio.com/docs/agent-customization/agent-plugins
- `windows` is an OS-specific override that uses backslash separators for the
  same script. `timeout` (seconds) bounds how long the hook may run.
- `matcher` is accepted for forward-compatibility but **ignored at runtime**.
  Hook scripts must filter internally by reading `tool_name` / `hook_event_name`
  from stdin JSON.

### Cross-shell command rules

`scripts/validate-hooks.mjs` now enforces these cross-shell invariants for every
registered hook entry so the same manifest survives PowerShell, cmd.exe, and
POSIX shells after plugin install:

- `command` must be a non-empty string and must invoke `node`.
- `windows` must be a non-empty string and must invoke `node` or `node.exe`.
- Both fields must include `${PLUGIN_ROOT}` so the script resolves from
  the installed plugin directory rather than the consumer workspace.
- Both fields must wrap the script path in double quotes so install paths with
  spaces still resolve.
- `command` must use forward slashes in the script token.
- `windows` must use backslashes in the script token.
- Both resolved script paths must exist on disk in the packaged plugin layout.

The shell-resolution smoke test in `test/hooks/hook-spawn.smoke.test.mjs`
expands the real manifest commands and executes them through the platform's
default shell. This complements the static validator by proving the command
string itself launches successfully, not just that the target file exists.

### Official event names

| Event              | When it fires                     |
| ------------------ | --------------------------------- |
| `SessionStart`     | When a new Copilot session begins |
| `UserPromptSubmit` | When the user submits a prompt    |
| `PreToolUse`       | Before a tool is invoked          |
| `PostToolUse`      | After a tool completes            |
| `PreCompact`       | Before context compaction         |
| `SubagentStart`    | When a sub-agent starts           |
| `SubagentStop`     | When a sub-agent stops            |
| `Stop`             | When the session/agent stops      |

---

## Auto-registered hooks (fire automatically)

These scripts are registered in `hooks/hooks.json` and run automatically on
their respective events:

| Script                                  | Event              | Purpose                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/session-start.mjs`             | `SessionStart`     | Session initialisation: idempotently seeds the .devmate/state layout and the canonical memory file (see below); resets a stale (nonzero) activeSubagents counter to 0 before computing the resume plan, tracing a subagent_reconciled event (see docs/resume.md)                                                                                   |
| `hooks/post-tool-use.mjs`               | `PostToolUse`      | Post-tool processing: audits the action into the task trace and writes task-scoped memory facts. Pre-task (no .devmate/state/task.json yet — before init-task-state runs) it skips quietly with a single memory.skip line, reason pre_task, exit 0 (HITL-3; the dispatch gate owns fail-closed safety for that window). A task state that exists but cannot be read stays loud: memory.error, reason state_unreadable, exit 1 — as does an invalid taskId in a well-formed file. |
| `scripts/check-session-budget.mjs`      | `PostToolUse`      | Measures session context size and warns when the token budget is approached or exceeded (E4-6). Exits 0 within budget, 1 on warn, 2 on critical.                                                                                                                                                                                                    |
| `scripts/compact-session.mjs`           | `PreCompact`       | Writes a typed, high-recall compaction artifact (JSON + Markdown) a fresh session can resume from without trace replay (E4-7).                                                                                                                                                                                                                      |
| `scripts/session-stop.mjs`              | `Stop`             | Session end: promotes + renders memory (`captureMemory`) and writes a resume handoff for an in-progress task (`captureHandoff`), so a fresh session can pick up where this one left off.                                                                                                                                                                                                                                                                                                |
| `hooks/approval-listener.mjs`           | `UserPromptSubmit` | Runs the skill matcher and (on new-task/steer turns) emits the skill menu (see the Skill matching section below); prints the model-visible workflow-state anchor block on every submitted prompt (see the Workflow-state anchor section below); then detects the exact-phrase approval fast path (see table below) and drives gate transitions through gatectl, stamping actor hook-exact-phrase and the raw prompt as evidence on the gate_transition trace event. Free-form approvals are instead classified by the orchestrator, which issues the gatectl advance itself (E10-03). Non-approval prompts pass through otherwise untouched. |
| `hooks/gate-advance.mjs`                | `PostToolUse`      | Advances the workflow gate on EVIDENCE, and authors the lane's scope contract. Projects a subagent's return (carried in tool_response) onto the canonical artifact its gate precondition reads — router-result.json, grill-result.json, critique-result.json, discovery-merged.json, plan.json, diagnosis.json — then walks the lane's chain as far as the artifacts on disk allow, stopping at the first unmet precondition. Derives .devmate/session/&lt;taskId&gt;/scope.md from the planner's file list (feature, chore) or the diagnosis's allowedPaths/allowedGlobs (bug), because no agent that scopes the work has a tool to write a file. Also stamps artifactHashes.spec + specDigest from spec.md, which spec-writer cannot compute, and refuses to re-stamp once the spec is approved. Human gates are never in a chain: the feature lane halts at spec-draft and the bug lane at plan-approved. Best-effort — it never blocks a tool call. |
| `hooks/spec-integrity-guard.mjs`        | `PostToolUse`      | Detects post-approval edits to .devmate/session/spec.md. When the file's SHA-256 differs from the recorded digest and the gate is spec-approved, rolls the gate back to spec-draft, updates the digest, appends spec_invalidated and gate_transition trace events, and prints a stdout warning the human must respond to with another approve spec. |
| `hooks/contract-validator.mjs`          | `PostToolUse`      | Validates routed artifact contracts for worker returns, diagnosis, grill, and critique outputs. Routed contract violations write a `contract_violation` trace event and return exit 2 to block — the only non-zero code VS Code treats as blocking (exit 1 is a non-blocking warning); unrouted payloads are no-ops and malformed hook stdin is swallowed with exit 0.                                                                 |
| `hooks/subagent-budget-guard.mjs start` | `SubagentStart`    | Lane-gated implementation dispatch (HITL-1): for an implementation agent (fullstack and the persona wrappers backend/frontend/editor) the start is denied unless the lane's gate and artifacts exist — impl-started plus recorded spec metadata (feature), a valid diagnosis result and a scope.md (bug), or a scope.md (chore); a missing task.json denies for these agents, while analysis dispatches keep the pre-spec fail-open. Then reads activeSubagents from task.json — if the count is at or above devmate.config.json maxConcurrentAgents (default 3), returns a typed deny and the start is rejected; otherwise persists an incremented count and appends a subagent_start trace event with the active count after the increment. |
| `hooks/subagent-budget-guard.mjs stop`  | `SubagentStop`     | Decrements activeSubagents in task.json (floored at 0 — the counter never goes negative), then appends a subagent_complete trace event carrying the durationMs and the post-decrement active count.                                                                                                                                                 |

---

## Human approval phrases (UserPromptSubmit)

`hooks/approval-listener.mjs` listens on the `UserPromptSubmit` event
(official VS Code hook name) and recognises three case-insensitive phrases.
Anything else passes through untouched, so normal chat is unaffected.

| Phrase                                  | Effect                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approve spec                            | Advances the workflow gate from spec-draft to spec-approved. Persists the new gate to .devmate/state/task.json and appends a gate_transition event to the task trace, stamped with actor hook-exact-phrase and the raw prompt as evidence (E10-03).   |
| approve pr                              | Advances the workflow gate from verification-passed to pr-ready. Same persistence + trace behaviour (and actor/evidence stamp) as above.                                                                                                              |
| revise spec: <feedback>                 | Keeps the gate in spec-draft and appends a spec_revision_requested event whose feedback field carries the verbatim text after the colon. The orchestrator re-runs discovery, grill, plan, and critique on top of that feedback and rewrites the spec. |
| approve no-tdd reason="<justification>" | Appends a no_tdd_override event with the parsed reason and, when a spec.md exists, inserts a one-line note under its Out of scope section. No gate change.                                                                                            |

Unknown prompts return action passthrough — no gate change and no trace
write — but every prompt (matched or not) still gets the workflow-state
anchor block printed to stdout (see the next section), so the model is
re-anchored to the durable state without the conversation being altered.

---

## Workflow-state anchor (UserPromptSubmit + SessionStart)

The orchestrator is re-anchored to the durable workflow state on every turn.
Per the official hooks contract, stdout from the `UserPromptSubmit` and
`SessionStart` events is added to context the model can see and act on (a
`UserPromptSubmit` hook cannot rewrite the user's message). devmate uses that
mechanism to inject a compact anchor block instead of trying to translate
free-form phrasing into commands:

- `hooks/approval-listener.mjs` prints the block on **every** submitted
  prompt, independent of approval-phrase matching, right after the
  skill-match hint write.
- `scripts/session-start.mjs` prints the same block alongside the resume plan
  line, so resumed and compacted sessions re-anchor immediately.

The block is built by the buildStateAnchor helper in
`lib/orchestrator/state-anchor.mjs` from `.devmate/state/task.json`; the
legal next gates are projected from the unified transition table in
`lib/gate-transitions.mjs`, never a duplicated list. One field per line:

```
<devmate-state>
taskId: feat-142
lane: feature
gate: spec-draft
step: 3
legal next gates: spec-approved, spec-draft
reminder: interpret this user message against the workflow state above before acting. Approval must be explicit; treat free-form change requests as revision feedback, and answer questions without advancing the gate.
</devmate-state>
```

A pending line naming the artifact awaiting review is rendered when the
caller supplies one. A fresh session (no task.json) or an unreadable/invalid
state file emits no block and never errors — the anchor is best-effort and
can never block a prompt or a session.

Anchor verbosity is provisional: the full block is emitted on every turn for
now. The intended throttle (full block at human-decision gates and every ~5
turns, a one-liner otherwise) ships as annotated constants and a pure policy
helper in `lib/orchestrator/state-anchor.mjs`, pending usage telemetry and a
persisted turn counter.

---

## Skill matching (UserPromptSubmit)

On every submitted prompt — before the approval fast path — `hooks/approval-listener.mjs`
runs the skill matcher so heavy skills load only when relevant, with no LLM call. It:

- loads the catalog from two roots (plugin skills plus the project's own under
  `.devmate/skills`), merges them, and scores each skill against the prompt;
- re-ranks the top matches using the durable workflow state (lane and gate) and
  force-includes the active lane's skill;
- persists the ranked matches to `.devmate/state/skill-matches.json` — the
  orchestrator consults this file before loading heavy skills;
- appends the full decision (every scored candidate, the selection, the turn
  intent, and a load canary) to `.devmate/state/skill-decisions.jsonl`.

On new-task and steer turns it additionally emits the full skill catalog into the
model-visible stream, so the model can self-select for paraphrases that lexical
and state matching miss. One line per skill, from its description:

```
<devmate-skills>
Available skills for this task — load the one that fits, by its id:
- tdd-debug: TDD and debug skill for implementation agents.
- app-security-handbook: Application security — shift-left, secure design, ...
</devmate-skills>
```

Like the anchor, the menu is best-effort: it emits nothing on approval, question,
status, chat, or deferred turns, and never blocks a prompt. The full pipeline —
scoring weights, phrase-level negatives, trigram morphology, the operating point,
and the eval — is documented in [skill-matching.md](./skill-matching.md).

---

## Lane-gated implementation dispatch (PreToolUse + SubagentStart)

devmate's promise that implementation cannot begin before the human approves the
spec is enforced structurally, not by orchestrator prose (P26). A runSubagent
call that dispatches an implementation agent — fullstack, or the persona wrappers
backend / frontend / editor — is denied unless the lane's gate and artifacts
already exist:

- all lanes: task.json exists and the gate is impl-started;
- feature: recorded spec metadata (spec + specDigest under artifactHashes) — i.e. spec-writer ran and the human ran approve spec;
- bug: a valid diagnosis result at .devmate/state/diagnosis.json AND a scope.md;
- chore: a scope.md.

Both hooks call one pure evaluator (evaluateImplementationDispatch in
lib/workflow/dispatch-gate.mjs) so the two layers cannot drift: the PreToolUse
gate-guard (scripts/gate-guard.mjs) emits a deny decision before its edit-only
rules run, and the SubagentStart budget guard (hooks/subagent-budget-guard.mjs)
returns a typed deny before the concurrency check. A missing task.json denies an
implementation dispatch here — unlike the analysis pre-spec fail-open — because
an implementation dispatch means a gated lane must already be in flight. Each
layer fails open only when it cannot see the dispatched agent name (empty or
unknown), so the other layer covers it, and analysis dispatches (discovery,
tech-design, rubber-duck, planner, and the rest) are never gated. The agent-run
CLI scripts/orch-assert-fullstack.mjs delegates to the same predicate and is the
advisory mirror of this hard hook.

---

## Spec integrity guard (PostToolUse)

`hooks/spec-integrity-guard.mjs` treats the spec-approved gate as a locked
contract. After any tool call that writes to .devmate/session/spec.md the
guard:

- Computes the current SHA-256 of spec.md.
- Compares it to the specDigest recorded under artifactHashes in .devmate/state/task.json (seeded by lib/spec-writer.mjs when the spec was first produced).
- When the digests differ AND the workflow gate is spec-approved, the guard advances the gate spec-approved to spec-draft (a legal rollback in lib/gatectl.mjs), refreshes the recorded specDigest, appends a spec_invalidated and a gate_transition event to the per-task trace, and prints a stdout warning that the human must run approve spec again.
- When the digest is unchanged, when the gate is anything other than spec-approved, or when the written path is not spec.md, the guard returns action no_action and writes nothing.

stdout is captured by VS Code and surfaced in the output panel per the
official PostToolUse hook contract.

---

## Contract validator (PostToolUse)

`hooks/contract-validator.mjs` adds runtime schema validation for routed
agent artifact files. The hook inspects the PostToolUse payload path and
routes only recognized suffixes:

- `.devmate/state/worker-returns/*.json` -> WorkerReturn
- `.devmate/state/diagnosis.json` -> DiagnosisResult
- `.devmate/state/grill-result.json` -> GrillResult
- `.devmate/state/critique-result.json` -> CritiqueResult

Behavior:

- Unrouted paths return exit `0` (no-op).
- Empty/malformed hook stdin returns exit `0` (best-effort, never crashes host).
- Routed path parse/read failure is treated as a contract violation.
- Routed validation failure prints a structured stderr report naming the
  contract, offending path, and field-level errors; appends a
  `contract_violation` trace event; and returns exit `2` to block. Exit `2` is
  the only non-zero code VS Code treats as blocking — exit `1` would be a
  non-blocking warning whose stdout the host never reads.
- Routed valid artifacts return exit `0`.

This keeps PostToolUse resilient for non-contract failures while making routed
contract failures blocking.

---

## Scope enforcement (PreToolUse — gate-guard Rule 6)

`scripts/gate-guard.mjs` runs on `PreToolUse` and enforces the unified
`scope.md` contract introduced in P06. When a scope file is present for the
active task, any source edit to a path outside the contract is blocked before
the tool runs.

### How it works

1. The gate-guard reads the task ID from `.devmate/state/task.json`
   (`state.taskId`).
2. It loads `.devmate/session/{taskId}/scope.md` via `readScopeForTask` from
   `lib/workflow/scope.mjs`. If the file is absent or unreadable the check is
   silently skipped (fail-open — the other guard rules still run).
3. The parsed scope is passed to `evaluateGuard` as `opts.scope`.
4. **Rule 6** (between persona-scope Rule 5 and TDD Rule 7): if the file being
   written matches neither `allowedPaths` nor `allowedGlobs`, the guard denies
   with a reason that **enumerates the contract it was judged against** (capped,
   per the output-cap discipline) rather than pointing at a file to go read:

   ```
   Gate guard: '<path>' is out of scope per scope.md (lane: <lane>). allowedPaths: <...>; allowedGlobs: <...>. Edit a path inside the contract, or have the orchestrator widen scope.md first.
   ```

### scope.md schema (canonical)

Written to `.devmate/session/{taskId}/scope.md` by each lane's producer:

```
---
lane: chore
---
# Scope

## Allowed paths
- package.json
- CHANGELOG.md

## Allowed globs
- docs/**/*.md
```

| Field | Description |
|---|---|
| `lane` | Frontmatter — one of `bug`, `chore`, `feature`. |
| `## Allowed paths` | Bullet list of literal file paths permitted by this scope. |
| `## Allowed globs` | Bullet list of glob patterns permitted by this scope. |

Both sections may be non-empty simultaneously. Enforcement allows the write when
the target path matches **any** entry in `allowedPaths` (literal equality after
path-separator normalisation) **or** any entry in `allowedGlobs`.

### Lane producers

| Lane    | Producer               | Notes |
|---------|------------------------|-------|
| `bug`   | `@diagnose` agent      | Writes `lane: bug` + paths/globs for the diagnosed fix surface. |
| `chore` | `writeChoreScope` in `lib/workflow/lanes/chore.mjs` | Writes `lane: chore` + proposed files as `allowedPaths`. |
| `feature` | *(deferred)*         | Feature-lane per-workstream scope.md writer is a follow-up item. |

### Library surface

`lib/workflow/gates.mjs` re-exports the full scope API:

```js
import { parseScope, validateScope, enforceScope, readScopeForTask } from 'lib/workflow/gates.mjs';
```

---

## Agent-invoked scripts (NOT auto-registered)

These scripts are called explicitly by an agent or orchestrator — they are
**not** registered in `hooks/hooks.json` and will **not** run automatically:

| Script                       | How to invoke        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/validate-hooks.mjs` | CI / manual          | Validates `hooks/hooks.json` shape and event names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `scripts/complete-step.mjs`  | Agent / orchestrator | Writes a validated `step_complete` trace entry with artifact pointers so resume can skip finished steps (E3-6). Trace path from `DEVMATE_TRACE_PATH`, else `.devmate/state/trace.jsonl`. Stores pointers + digests only, never file contents.                                                                                                                                                                                                                                                                                                                                                             |
| `scripts/view-trace.mjs`     | Agent / orchestrator | Summarises a task's unified trace file at `.devmate/state/trace/<taskId>.jsonl` (E6-1): counts by event type, last N events, flags `loop_halt` / `budget_warning`. Flags: `--task <taskId>` (required), `--last <n>` (default 20). Exits 1 when the malformed-line ratio exceeds 5% or any `loop_halt` is present. Read-only.                                                                                                                                                                                                                                                                             |
| `scripts/resume-status.mjs`  | Agent / orchestrator | Reads a task's trace via the canonical read-trace reader (E6-2) and prints a resume summary: last completed step, any blocked step, and the next legal action — all keyed by stable step id, never label-only. Flags: `--task <taskId>` (required), `--trace-dir <dir>`. Exits 1 when any malformed line is present or a step is currently blocked. Read-only.                                                                                                                                                                                                                                            |
| `scripts/create-handoff.mjs` | Agent / orchestrator | Writes a typed handoff artifact (E6-3) after a halt, compaction, or manual trigger — a json brief plus a self-contained markdown brief under `.devmate/state/handoff/<taskId>/`. Carries pointers + metadata only, never raw file content. Flags: `--task <taskId>` (required), `--reason <halt\|compaction\|manual>` (required), `--purpose <string>` (optional). Exits 0 and prints both file paths on success.                                                                                                                                                                                         |
| `scripts/query-memory.mjs`   | Agent / orchestrator | Performs a bounded, read-only query over the repo memory ledger (E3-7) so later tasks can pull only the most relevant prior facts instead of the whole ledger. Streams the ledger line by line, scores each active fact by lane, path prefix, tag overlap, and confidence, then prints the top matches as one json line. Skips stale and malformed entries. Flags: `--ledger <path>` (default `.devmate/state/repo/repo.jsonl`), `--lane <lane>`, `--path-prefix <prefix>`, `--tag <tag>` (repeatable), `--text <text>`, `--top-n <n>`, `--include-expired`, `--verify`. Read-only; exits 1 only on a failed query. |

> Additional agent-invoked scripts will be listed here as they are added by
> subsequent issues.

---

## SessionStart initialisation

The `SessionStart` handler gives devmate a single, predictable point to create
its runtime layout. On session start it:

- Resolves the correct repo root by walking up from the session working
  directory to the nearest repo marker (a git folder, a package manifest, or an
  existing .devmate folder). A working directory that is itself the workspace's
  `.devmate/` folder (the util lists it first in the generated `.code-workspace`,
  so it can become the cwd) is first normalized to its parent via `climbOutOfDevmate`,
  so runtime state never nests at a doubled `.devmate/.devmate/` path. This keeps init
  correct in a multi-root workspace where several devmate-enabled repos are open at
  once — each root seeds its own .devmate folder, never a sibling root or the
  workspace parent.
- Idempotently creates the .devmate/state directory tree (trace, handoff,
  compaction, and repo subdirectories).
- Ensures the canonical memory file exists, creating it with a minimal header
  only when missing. An existing memory file is never overwritten.
- When a task is in flight, prints the resume plan line and the
  workflow-state anchor block (see the Workflow-state anchor section above)
  so a resumed or compacted session re-anchors to the durable gate
  immediately. Fresh sessions emit neither.

The handler is cheap (it skips all work when the layout already exists) and
non-blocking: any failure is logged to stderr and the hook still exits 0 so a
session is never blocked. It does not replace the existing lazy directory
creation used by individual writers — init is purely additive.

Note on the working directory: the VS Code hooks docs describe the working
directory field as optional, so the handler falls back to the process working
directory when it is absent. The docs do not define this field's value in a
multi-root workspace, which is exactly why init resolves the repo root by
walking up rather than trusting the raw value.

---

## What a hook may say back: the output contract

A hook that computes a correct verdict and writes it in a shape the host does not
read has not enforced anything. That single failure mode accounted for three of
devmate's dead enforcement layers, so the contract now lives in exactly one
module — [`lib/hooks/output-schema.mjs`](../lib/hooks/output-schema.mjs) — and
every hook entrypoint ends by calling into it.

### Exit codes are the first half of the contract

| Exit | What VS Code does |
| --- | --- |
| `0` | **Parses stdout as JSON.** This is the only code under which stdout is read at all. |
| `2` | **Blocking error:** stops processing and shows the hook's **stderr** to the model. |
| any other non-zero | **Non-blocking warning.** The run continues. stdout is *not* parsed. |

Two consequences that are easy to get backwards, and that devmate got backwards:

- **Exit 1 does not block.** The contract validator originally returned `1` on a
  malformed worker return, so the lane carried on regardless; it now returns `2`,
  the only non-zero code that blocks.
- **On any non-zero exit, nobody reads stdout.** A message printed to stdout
  alongside a non-zero exit reaches no one. Put it on stderr.

### Per-event channels

| Event | To block | To add context |
| --- | --- | --- |
| `PreToolUse` | `hookSpecificOutput.permissionDecision: "deny"` (+ `permissionDecisionReason`) | `additionalContext` |
| `PostToolUse` | top-level `decision: "block"` + `reason` | `additionalContext` |
| `SubagentStop` / `Stop` | top-level `decision: "block"` + `reason` | — |
| `SessionStart` | — | `additionalContext` |
| `SubagentStart` | **nothing documented** — use `continue: false` **and** exit 2 | `additionalContext` |
| `UserPromptSubmit` / `PreCompact` | common format only (`continue: false`) | see note |

The common output format is valid on every event:
`{ "continue": false, "stopReason": "…", "systemMessage": "…" }`.

**`SubagentStart` has no blocking field.** That is why HITL-1's second layer —
the gate that stops an implementation agent from starting before a human approves
the spec — emits `continue: false` *and* exits 2 with the reason on stderr. Both
are independently documented as stopping the run; using both is what fail-closed
means when the host names neither as the mechanism for this event.

**`additionalContext` on `UserPromptSubmit` is `[UNVERIFIED]`.** The VS Code
reference lists only the common output format for that event. devmate emits it
anyway (it is a real field on four other events, and VS Code states its hook
format is Claude Code-compatible), because the alternative — `systemMessage` —
would push the per-turn state anchor into a user-visible warning on every prompt.
It is benign if the host ignores it, and it is one line to change, in one file.

### Rules of thumb

1. **stdout is for the host.** One JSON document, or nothing. Never raw text:
   on exit 0 that is a parse failure, and the host drops the entire output.
2. **stderr is for diagnostics — and for the model, on exit 2.**
3. **Never invent a field.** If an event documents no channel for what you want
   to say, that is an answer. Say it on stderr.

`validateHookOutput(event, stdout, exitCode)` in the same module checks all of
this and reports what the host will actually *do* (`block` / `ask` / `allow` /
`warn` / `none`). The conformance suite asserts on that effect, not on bytes.

---

## Validation

Run at any time to verify the manifest:

```bash
node scripts/validate-hooks.mjs
```

This is also wired into `npm run verify` and the dedicated cross-OS `hooks-smoke`
CI matrix job.

**The contract itself is tested by spawning it.**
[`test/conformance/hooks-contract.test.mjs`](../test/conformance/hooks-contract.test.mjs)
runs every command in `hooks/hooks.json` as a real subprocess, pipes it a real
captured payload from
[`test/fixtures/hook-payloads/`](../test/fixtures/hook-payloads/), and asserts
that it executes, parses the payload without falling back to an invented key,
emits output the host will honor, and writes only under the resolved workspace
root. Every hook test that imports a function and passes it a hand-authored
payload is testing devmate's beliefs; only this one tests the contract.
