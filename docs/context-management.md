# Context management

This document describes how devmate keeps the agent's working context small and
predictable. Context discipline is enforceable state, not prompt-prose advice:
a budget contract is persisted at the start of every workflow, and a
PostToolUse hook re-measures the live context after each tool call.

## Why budgets exist

Large, unbounded context causes two failures:

- Cost and latency grow with every loaded skill, trace summary, and tool output.
- Quality drops as the most relevant evidence gets diluted by stale material.

A budget that never fires is worse than no budget at all — it lets context
silently overflow. The session-budget hook therefore always prints a status
line, even when the session is within budget.

## Budget classes and thresholds

Every workflow is assigned one of three budget classes when the output contract
is classified (see the E4-1 section below). Each class has a warn threshold and
a critical threshold, measured in estimated tokens:

| Budget class | Warn (tokens) | Critical (tokens) |
|---|---|---|
| tiny | 2,000 | 4,000 |
| standard | 8,000 | 16,000 |
| large | 20,000 | 40,000 |

## What counts as context — and what does not

Two rules decide what the budget is allowed to count. Both were learned the hard
way (#87); the module enforces them structurally, and breaking either one
reintroduces a shipped defect.

**1. A context budget counts what enters the prompt.** Not what sits on disk.

**2. Every counted component must be one that compaction can reduce.** A
`critical` level blocks source edits. A breach that cannot be reduced is not a
guard, it is a livelock — so `measureSession` and `resetContextBudget` live side
by side in the same module, and a component added to the first must be handled
by the second.

The counted components are:

- Session markdown — the loaded session notes file, if the session keeps one.
  Compaction archives it and leaves a pointer stub behind.
- Recent tool output — the most recent recorded tool output. Compaction clears
  the pointer.
- Tool results in context — the running context meter (below). Compaction zeroes
  it.

The token estimate is a rough byte-to-token conversion (bytes / 4, rounded up)
through the one shared estimator, plus the meter's running token count.

The loaded-skill count is recorded for messaging but does not add to the total.

### The context meter

State-file inventory entry: `.devmate/state/context-meter.json`.

The meter is the only counted component with a producer in production, and it is
the honest one: on the surface devmate targets, the `PostToolUse` payload carries
`tool_response` — the text the host feeds back to the model. That is precisely
what enters the context window, so the budget hook sums it across the task and
persists the running total in a sidecar next to the task state file (written on
every tool call, so it deliberately does not contend with the locked task-state
writes). Compaction zeroes it, because the compacted window no longer holds the
tool results it counted.

### The trace is not context

The trace file (`.devmate/state/trace/<taskId>.jsonl`) is an append-only event
log. It is **never injected into the prompt** — it is read on demand, to build a
resume plan and to render the implementation-progress line. Its size therefore
costs the model nothing.

It used to be summed into the context total, and because it was the only counted
component with real bytes in it — and one that only ever grows, since nothing
trims a trace — it drove essentially every budget warning the plugin emitted, on
every tool call, naming itself as the component to trim. At critical it blocked
every source edit, and compaction cleared the marker without shrinking the trace,
so the next tool call re-blocked. That was the livelock.

The trace is still measured, because a trace growing without bound is real
evidence of a loop. It is reported on its own tag, with its own threshold, and it
can never write the critical marker or block a tool call:

```text
[TRACE:size] Trace file is 30,000 tokens (diagnostic threshold: 25,000). The trace
is an on-disk event log, not context — this does not consume the model's window
and nothing is blocked. A trace growing without bound usually means a loop.
```

## Recovery is automatic

A critical breach recovers itself. The budget hook detects the breach, and it
already holds the correct workspace root — it resolved it from the hook payload —
so it runs the compaction **in-process** and reports what it reclaimed. The
edit-blocking marker is written only if the reclaim failed to bring the total back
under the threshold.

This used to be a handoff to the user: write the marker, print "run compaction",
and let a human paste a command into a terminal. That is the wrong component doing
the job. A terminal resolves the workspace root from *its* working directory, and
in a multi-root workspace that is a different directory from the one the hooks
use — so the compaction ran against a task state that was not there, built an
artifact for a sentinel task id, cleared a marker that did not exist at that path,
reported success, and left the real marker and the block exactly where they were.
The user was told to run the fix, ran it, and stayed blocked with no signal why.

Writing the artifact and reclaiming the budget are therefore one function
(`compactAndReclaim`), and both callers — the hook's automatic recovery and the
manual CLI — go through it, so a recovery that writes the artifact but forgets to
reclaim is not a thing that can be written. The CLI additionally **refuses to run**
when it finds no task at the path it resolved, naming the path it checked: the one
way out of a block must never silently do nothing.

## Exit codes

The session-budget hook prints one compact status block and exits with a code
that reflects severity, so an orchestrator can react programmatically:

| Exit code | Level | Meaning |
|---|---|---|
| 0 | ok | Total is below the warn threshold. Nothing to do. |
| 0 | compacted | Total breached critical, and auto-compaction brought it back under. Nothing is blocked. |
| 1 | warn | Total is at or above warn but below critical. |
| 2 | critical | Still at or above critical after auto-compaction — nothing left to reclaim. Source edits are blocked. |

Example output when within budget:

```text
[BUDGET:ok] Within budget.
```

Example output when a critical breach recovers on its own:

```text
[BUDGET:critical] Context is 20,000 tokens (standard critical threshold: 16,000); largest component: Tool results in context at 18,000 tokens
Actions: Run compact-session (scripts/compact-session.mjs) — it archives the session markdown, clears the recorded tool-output pointer, and resets the context meter
[BUDGET:compacted] Auto-compaction reclaimed 19,950 tokens (20,000 → 50). Artifact: .devmate/state/compaction/compaction-feat-12-1783957015300.json
```

## Cleanup actions

Every string the hook emits as an action must name a mechanism that exists.
Advice with no implementation behind it is not an action — the old guard told the
model to "unload unused skills" and "trim the largest component" when neither had
any implementation, and the component it named could not be trimmed at all.

There is exactly one cleanup mechanism, and it reduces every counted component:
`compact-session`. It archives the session markdown, clears the recorded
tool-output pointer, zeroes the context meter, and only then clears the
budget-critical marker so the gate guard lets source edits resume. The hook runs
it for you; the CLI is there for the cases the hook cannot reach.

## Not re-reporting an unchanged breach

The budget check runs on every tool call, so a breach that has not changed since
the last one would otherwise be re-emitted on every turn — which is how a warning
becomes background noise the model learns to ignore. Each report carries an
identity (level + dominant component + a coarse size bucket). An identical warn
is suppressed; a breach that is materially worse re-reports, and a critical is
always emitted, because it is blocking and the model needs the reason each time it
is stopped.

## Workflow boundaries

The budget hook fires on `PostToolUse`: after every tool completes, the tool
result is metered and the live context is re-measured against the class
thresholds. This places the check at the natural boundary where context grows —
right after new tool output lands.

When no output contract has been persisted yet, the hook falls back to the
standard class so it still produces a meaningful signal early in a session.

## Domain context state file (DN-2)

State-file inventory entry: `.devmate/state/domain-context.json`.

On every prompt, the approval-listener hook (the same `UserPromptSubmit`
boundary that writes the skill matches) runs the pure domain resolver
(`lib/context/domain-resolver.mjs`) over the prompt text and the active task's
seed files (its persisted spec file list), ranking the business domains
declared in the config's optional domains section (DN-1, see
[config.md](config.md)). The ranked result is written atomically
(tmp+rename) to `.devmate/state/domain-context.json`:

```json
{
  "schemaVersion": 1,
  "resolvedAt": "2026-07-11T00:00:00.000Z",
  "matches": [
    {
      "domain": "billing",
      "score": 0.7,
      "matchedKeywords": ["invoice"],
      "matchedGlobs": ["packages/billing/src/**"],
      "contextFile": ".devmate/contexts/billing.md",
      "relatedDomains": ["orders"]
    }
  ]
}
```

Scoring is additive and capped at 1.0: 0.2 per keyword hit against the task
text (exact or morphological via the trigram matcher, capped at 0.5), 0.4 when
any seed file matches a domain glob (identical glob semantics to persona glob
matching), and 0.2 when the domain id appears verbatim in the task text.
Matches below 0.25 are dropped and at most the top 2 are surfaced — all four
values are provisional placeholders pending calibration. The file carries the
`contextFile` **path**, never its contents — pointers, not payloads (TCM-3) —
so it stays under ~2 KB.

Rules that keep this a zero-risk addition:

- **No domains declared → guaranteed no-op.** Nothing is written, a stale
  `domain-context.json` left behind by a since-removed config is deleted (state
  never outlives config), and the only added cost is one config read. A
  malformed config is treated the same way — the hook stays fail-open and never
  blocks the prompt turn.
- **Task state carries ids only.** When a task is active and the resolved ids
  changed, they are persisted into the task state file as an optional
  string-id list (readers treat absent as none); an unchanged resolution skips
  the write so the task file is not churned on every prompt.
- **Consumers read it by known path.** `.devmate` is excluded from editor
  search; downstream consumers (DN-3 dispatch injection, DN-5 skill re-rank)
  read `.devmate/state/domain-context.json` directly — the same note
  [parallel-dispatch.md](parallel-dispatch.md) makes for the discovery
  candidate artifact.

### Dispatch injection (DN-3)

The first consumer of the state file is worker dispatch:
`loadDomainContextForDispatch` (`lib/context/domain-context-load.mjs`)
resolves each match's `contextFile` pointer into an elastic, budgeted entry
for the payload builder — full file content only when it fits, otherwise a
digest (first lines + heading list) plus an explicit pointer to the file,
never a silent large paste (TCM-9). The budget is
`DOMAIN_CONTEXT_MAX_TOKENS` (1500 across all domains combined, provisional)
measured through the single token estimator (E9-09); fitting runs in rank
order so the top-ranked domain gets priority. Missing files are fail-open:
the entry is marked missing, the rendered section says so, and dispatch
proceeds — session-start additionally emits a non-blocking warning for any
domain whose declared context file is absent on disk, mirroring the persona
instruction-file warning. See
[parallel-dispatch.md](parallel-dispatch.md) for the payload-side rendering.

## OutputContract and budget classification (E4-1)

Every workflow begins with a typed, persisted budget contract. Before the first
discovery, planning, or coding tool call — and before invoking any subagent,
loading evidence, or running verification — a workflow MUST call
`classifyBudget(input)` from `lib/context/output-contract.mjs` to derive an
`OutputContract`, then `persistBudget(taskStatePath, contract)` to write it into
`TaskState` (`task.json`). The contract assigns a `BudgetClass`
(`tiny` | `standard` | `large`) and a `max_context_sources` cap so every
downstream module enforces the same limits without re-deriving them. The `large`
class is unbounded and requires the ContextReducer (E4-3); it is only entered by
an explicit router decision (`explicitLarge: true`). This makes token/context
discipline enforceable state (TCM-1, TCM-11) rather than prompt-prose advice.

## External code-graph MCP servers (optional, consumer-side)

devmate's own navigation stack is deliberately deterministic and
path/glob-anchored: the discovery scan + merge (FO epic) derives the file
cluster, and the business-domain map (DN epic) carries budgeted domain
context into dispatch and skill ranking. Symbol-level navigation (call
graphs, reference resolution) is a different tool class — external code-graph
MCP servers — which devmate documents but will **never bundle**: it would
break the zero-runtime-dependency rule and the USER_GUIDE's "no MCP server to
set up" promise. Consumers who want one wire it into their own repo's MCP
host configuration; devmate neither requires nor notices it. The evaluation
record — verified verdicts, dates, sources, and a warning about tool names
the original proposal fabricated — is
[research/external-code-graph-mcp.md](research/external-code-graph-mcp.md).
