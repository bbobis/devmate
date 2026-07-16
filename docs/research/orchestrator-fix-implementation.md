# Orchestrator delegation fix — what shipped & how to measure it

Companion to [orchestrator-subagent-dispatch.md](./orchestrator-subagent-dispatch.md)
(the 180-source root-cause study). This is the short "what we did and how to
verify it" reference.

## The problem (recap)

The orchestrator rarely dispatched subagents — it did discovery, design,
planning, and diagnosis inline, filling its own context window and degrading the
model. Dispatch was 100% prompt-driven with no forcing function, and the
loudest guidance ("maximize a single agent first") read as a licence to work
inline.

## What shipped

**Delegation is the default (prompt).**
- `agents/orchestrator.agent.md` gained a top-level **Delegation policy**:
  delegate every substantial unit of work; doing it inline is the exception.
- The `edit` tool was removed from the orchestrator's frontmatter, so it cannot
  write files inline at all.
- Effort scaling now sizes only the *parallel fan-out*, never whether to
  delegate.

**A dispatch floor (guard + script).**
- `assertDispatchFloor` (`lib/workflow/orchestrator.mjs`) and the companion
  `scripts/orch-assert-floor.mjs`: an internal analysis gate/milestone
  (`discovery-done`, `grill-done`, `plan-done`, and the bug-lane
  diagnosis-done) may only advance once a subagent-start trace event proves the
  owning specialist ran. It is the mirror of the existing `assertDispatchResult`
  result guard.

**A fail-open budget guard.**
- `hooks/subagent-budget-guard.mjs` used to *deny* every dispatch when
  `task.json` was missing — the entire pre-spec analysis phase — forcing that
  work inline. It now fails open pre-spec (still recording the trace event) and
  fails closed only on a malformed state file.

**Observability + a regression guard.**
- `scripts/delegation-report.mjs` (`lib/orchestrator/delegation-report.mjs`)
  gives a GREEN/YELLOW/RED verdict from a task's trace.
- `test/agents/delegation-contract.test.mjs` is one high-signal test pinning the
  whole no-inline-work guarantee (no `edit` tool, Delegation policy present, no
  "maximize a single agent first" phrasing, floor script wired, every analysis
  gate covered).

## How to measure delegation

```
# by task id (resolves the trace path + lane from state under --root, default cwd)
node scripts/delegation-report.mjs --task <taskId>

# or an explicit trace + lane
node scripts/delegation-report.mjs --trace .devmate/state/trace/<taskId>.jsonl --lane feature

# machine-readable, and optionally gate a CI on it
node scripts/delegation-report.mjs --task <taskId> --json
node scripts/delegation-report.mjs --task <taskId> --strict   # exit 1 on RED

# fleet-wide dashboard across every task trace under a root
node scripts/delegation-report.mjs --all --root <dir>
```

- **GREEN** — the read-heavy analysis was delegated.
- **YELLOW** — subagents ran but no expected analysis specialist did (confirm it
  was not done inline), or nothing has dispatched yet.
- **RED** — the workflow reached implementation/spec with *no* dispatch: work
  was almost certainly done inline.

The report is lane-aware: a chore lane has no analysis phase, so it is scored on
whether it dispatched at all rather than penalised for skipping discovery/grill.

## Honest limitations / the next lever

The dispatch floor is invoked by the orchestrator (through the
`orch-assert-floor` script), so it shares one weakness with any prompt-driven
rule: a prompt that scrolls out of context. Two things already harden it beyond
prose: the `grill-done`/`plan-done` gates are additionally enforced by their
artifact preconditions, and — now that the orchestrator has no `edit` tool — it
cannot fabricate those artifacts inline, so the artifact *is* proof a subagent
produced it.

## Follow-up hardening — the terminal-as-editor bypass

The first cut removed the orchestrator's `edit` tool so it could not write files
inline. In practice that only moved the inline edit: with no `edit` tool, the
orchestrator reached for its `execute`/terminal tool and edited source with
`sed -i`, `cat > file`, redirects, `patch`, or `git apply` — most visibly on
**follow-up turns**, where the delegation guidance had scrolled out of context.
Users had to keep reminding it to dispatch `@fullstack` for edits.

Two things let this through:

- **The prompt never named the terminal loophole.** "You have no file-modifying
  tool" reads as "no `edit` tool," not "don't hand-edit in the shell." The
  Delegation policy now forbids the `execute`-as-editor pattern outright and says
  a follow-up edit is *not* an exception.
- **The gate-guard classified the shell edit but never acted on it mid-impl.**
  `isSourceEditTool` already flags `sed -i` / redirects / `patch` as source
  writes, but every rule that *acts* on a source edit — persona scope, `scope.md`,
  the TDD pre-condition — keys on `payload.path`, and a shell command carries
  `command`, not `path`. So pre-impl the edit was denied by the gate rule (which
  needs no path), but once the gate reached `impl-started` it fell straight
  through to the default allow. New **Rule 3b** (`isUnscopeableSourceEdit` in
  `lib/gate-guard-core.mjs`) fails such an edit closed at every gate: an edit the
  guard cannot attribute to a path cannot be scope- or TDD-checked, so it is
  denied with a message pointing to the file-edit tool / `@fullstack`.

Unlike the prompt-driven dispatch floor, Rule 3b lives in the `PreToolUse` hook,
so it holds regardless of what has scrolled out of the orchestrator's context.
Benign orchestration commands are unaffected: `npm`/`npx`/`node`/`git` (except
`git apply`) and all read-only commands are not classified as source writes, so
verification, git, and gate/state scripts still run.

## Automatic runtime enforcement (opt-in)

A fully-automatic, prompt-independent floor is available as an opt-in via the
`delegationFloor` mode in `.devmate/devmate.config.json` (`off` | `warn` |
`block`; the legacy boolean `enforceDelegationFloor: true` maps to `block`). The
`impl-started` gate precondition (`lib/gate-preconditions.mjs`) checks that the
lane's analysis was delegated — a subagent-start trace event exists for each
required specialist group:

- **feature** — (discovery OR tech-design) + rubber-duck + planner
- **bug** — diagnose + rubber-duck
- **chore** — none (no analysis phase)

The modes support a graduated rollout:

- **`off`** (default) — no-op; existing behaviour is unchanged.
- **`warn`** — records a `contract_violation` trace event (surfaced by the
  delegation report as a `floorViolations` field that downgrades a would-be-green
  run, and by the Stop advisory) but *allows* the transition. Turn this on first
  to observe how often the floor would fire without breaking any flow.
- **`block`** — refuses to enter `impl-started` until the analysis is delegated.

The required specialists per lane are configurable — set
`delegationFloorRequirements` in the config to a `lane → any-of-groups` map
(e.g. `{ "feature": [["discovery"], ["planner"]] }`) to override the built-in
defaults for any lane; lanes you don't name keep the defaults, and an empty group
list removes a lane's floor.

Because it lives in the state machine rather than the prompt, it holds
regardless of whether the orchestrator remembers to run the floor script — the
pre-spec analysis gates are not event-driven persisted transitions (the task is
initialised at `plan-approved`), so `impl-started` is the enforceable seam.

The remaining hardening — making `block` the default — is a behaviour change
across every lane and belongs in a reviewed change with CI green, not a silent
default flip.
