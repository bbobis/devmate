# Usage-log findings — issue #382 (2026-07-07)

**Source:** a Copilot interaction export (`copilot_all_prompts_2026-07-07.json`,
11 prompt groups / 58 log entries) attached to issue #382, captured from a real
session driving Java test cleanups on a Spring Boot repo (`portals-api`) inside a
**multi-root VS Code workspace** (`portals-api` + `portals-ui` + a workspace-root
`.devmate/`, under a git worktree).

This report records what the logs showed, the four defects they exposed, and the
fixes shipped for each. It is grounded in the log plus a code-level audit.

---

## What the logs actually show (read the noise correctly)

Two things about the export mislead a first read:

- **8 of the 11 prompt groups are not devmate.** Prompt groups 3–10
  (`NES | …ControllerTest.java (v6/v10/v12…)`) are VS Code Copilot **Next Edit
  Suggestions** (`XtabProvider` / `nes.nextCursorPosition`) — inline-autocomplete
  telemetry. The version numbers read like "retries" but are just autocomplete
  cursor positions. Only prompt groups **0, 1, 2** are devmate interactions.
- **All three devmate interactions succeeded** (BUILD SUCCESS, 16 tests green).
  The output was never wrong. The failure is **friction, wasted work, and a
  silently broken gate** — visible only by contrasting the paths that ran the
  *same trivial task* (clean up duplication in one test file):

  | Prompt | Entry point | What happened |
  |---|---|---|
  | 0 | `@fullstack` (direct) | read → patch → test. Clean, ~8 steps. No gate/lane/state. |
  | 2 | `@fullstack` (direct) | tiny polish → test. Clean, ~6 steps. No gate. |
  | 1 | **orchestrator** | 30+ messages, **2 real errors**, redundant re-verify, 2nd dispatch. |

The identical task is fast and clean through a persona, and slow + error-prone
through the orchestrator — which trains users to bypass the gated path entirely.

---

## Findings

### A. Broken gate scripts — enforcement silently no-ops for every consumer *(highest impact)*
- **Log:** `ENOENT: no such file or directory, scandir '…\.devmate\scripts'`
  (prompt 1), then flailing "No files found" globs.
- **Root cause:** the orchestrator agent + all three lane skills told the model
  to run bundled scripts by **bare relative path** (`node scripts/orch-assert-*.mjs`).
  Bundled scripts ship inside the installed plugin, reached everywhere else via
  the `${PLUGIN_ROOT}` token (`hooks/hooks.json`, `.mcp.json`, the user
  skills). The orchestrator was the lone outlier; a bare path resolves against
  the workspace cwd, where no `scripts/` dir exists, so every gate/floor script
  the orchestrator is told to run failed to launch. **The deterministic gate the
  product sells was a no-op outside this dev repo.**

### B. Stale in-flight workflow blocks unrelated new tasks
- **Log:** a bug task (`bug-20260703-e2e-wiremock-hooks`) stuck at gate
  `impl-started` from **4 days earlier** forced a *Park / Abandon / Continue*
  interrogation when the user asked for an unrelated cleanup. The cryptic `"1"`
  prompt in the export is the user answering that menu.
- **Root cause — no age/staleness anywhere:** `TaskState` carried no timestamp;
  the resume planner branched only on trace completeness, never age, so a
  days-old task was silently resurfaced and the orchestrator interrogated
  park/abandon on every new request.

### C. Disproportionate ceremony for a `budgetClass: tiny` chore
- **Log:** the router correctly returned `chore`/`tiny` at 0.97 confidence, yet
  the orchestrator still ran the full flow **and re-read the whole file and
  re-ran the 90-second integration test the subagent had already run green**,
  then chained a *second* polish dispatch.
- **Root cause:** effort scaling collapsed only concurrency, never stage count;
  nothing told the orchestrator to trust the subagent's own verification.

### D. The gate is trivially bypassed by editing through a persona
- **Log:** prompts 0 & 2 went straight to `@fullstack` (edit + test) with zero
  gate/lane/state. Only the orchestrator path applied gates.
- **Root cause:** every floor is an orchestrator-side gate-transition
  precondition; the completion-time persona-scope check only fires on the
  orchestrator's dispatch envelope; and the one universal edit-time backstop —
  the PreToolUse gate-guard — classified edits by tool name against a list that
  **omitted the tools personas actually use** (`apply_patch`, `edit`). A persona
  edit was therefore not classified as a source edit, so the "no active task →
  deny" rule never fired and the edit fell through to the default allow.

---

## Fixes shipped

**A — plugin-root-relative script invocation (+ regression guard).** Every bundled
script reference in `agents/orchestrator.agent.md` and the three
`skills/orchestrator-*-lane/refs/*.md` now uses `node "${PLUGIN_ROOT}/scripts/<name>.mjs"`.
The orchestrator prompt gained an explicit note that bundled scripts live under
`${PLUGIN_ROOT}`, never `.devmate/`. `scripts/complete-task.mjs` resolves
its sibling verifier relative to its own location, not the consumer root. A new
CI lint (`scripts/check-script-refs.mjs` + `lib/script-ref-lint.mjs`, wired into
`npm run verify`) fails when any agent/skill markdown references a bundled script
without the plugin-root token, so this cannot regress.

**B — task-age staleness + auto-park.** A pure evaluator (`lib/task-staleness.mjs`)
computes idle age from the `.devmate/state/task.json` mtime — the state dir is
gitignored, so its mtime reliably reflects last activity and is never reset by a
VCS checkout (this is why an mtime signal was preferred over injecting a
timestamp into `writeTaskState`, whose "parses back identically" contract is
deliberate). A configurable `staleTaskHours` (default 48) drives it. When the
current in-flight task is stale, the state anchor renders a `staleness: STALE`
line, `session-start` leads the resume message with "start fresh recommended",
and the orchestrator auto-parks the stale task on a new unrelated request instead
of interrogating park/abandon.

**C — tiny fast-path + verify-once.** The orchestrator's effort-scaling and the
chore lane gained an explicit `tiny` fast-path (minimal single-file scope, one
dispatch, verify once) that keeps the scope/off-limits safety rails but drops the
ceremony, and folds trivial follow-up polish into the single dispatch rather than
chaining a second one. A "Verify once" rule tells the orchestrator not to
re-read files or re-run the test suite by hand after a passing verify. *(Not
done: broadening the deterministic turn-intent classifier to treat plain
affirmatives as approvals — that would fight the repo's deliberate
"approval must be explicit; never infer it" invariant. The fast-path reduces how
many human gates a tiny chore hits instead.)*

**D — close the persona bypass.** `apply_patch` and `edit` (the tools personas
actually use, verified from the logs) are now recognized source-edit tools, and
the gate-guard extracts an `apply_patch` body's target path so the path-keyed
rules can vet it. With edits correctly classified, the gate-guard's "no active
task → deny" rule fires on an ungated persona edit and steers the user to route
through the orchestrator. The stale PreToolUse/PostToolUse doc mislabels were
corrected (scope enforcement is the **PreToolUse** gate-guard, Rule 6; the
PostToolUse hook hosts the separate completion-time persona-scope re-check).

---

## Verification

All fixes are covered by `node:test` units (`test/script-ref-lint.test.mjs`,
`test/lib/task-staleness.test.mjs`, plus new cases in the gate-guard, state-anchor,
and devmate-config suites) and by the corrected agent-content guards. The full
`npm run verify` pipeline (lint, typecheck, 2250+ tests, contracts, docs-drift,
the new script-ref lint) passes.
