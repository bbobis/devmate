# Resume

`scripts/resume.mjs` is the single canonical entry point for resuming an
interrupted task. It reads the task trace (E6-2), the optional handoff
artifact (E6-3), and the optional compaction artifact (E4-7), then prints a
compact plan and enforces no-repeat-work semantics. No other script may
re-dispatch a completed step.

The trace is the source of truth for the resume *decision*; the handoff and
compaction artifacts enrich it. Both are produced automatically at session
end: the `Stop` hook writes a handoff for an in-progress task, and the
`PreCompact` hook writes a compaction artifact. When a self-sufficient
compaction artifact is present, the plan sets `compactionAvailable` and points
the resuming agent at that richer brief.

## What it guarantees

- A completed step is never re-dispatched as the next step.
- A halted step is never re-run without a deliberate strategy change.
- Malformed trace lines require an explicit confirm before proceeding.
- Only plan fields are printed — never raw trace content.

## Sub-agent concurrency counter reconciliation

A sub-agent hard-interrupted mid-run (host crash, session kill, hook OOM) can
leave the `activeSubagents` counter in task.json incremented forever, since
the pairing decrement only happens on a clean `SubagentStop`. Because
sub-agents never outlive their host session, any nonzero `activeSubagents`
seen at SessionStart is by definition stale. `scripts/session-start.mjs`
resets it to 0 (via `lib/resume/reconcile-subagents.mjs`'s pure
`reconcileActiveSubagents` decision) before the resume plan above is computed,
and appends a `subagent_reconciled` trace event recording the value that was
reconciled away — so the concurrency guard can never deadlock a task across a
hard interrupt, and a clean session always starts with an accurate counter.

## Acceptance-criterion granularity

During implementation (`impl-started`), each completed acceptance criterion is a
first-class trace step (`impl-AC{n}`, recorded by `scripts/complete-ac.mjs`).
`buildResumePlan` joins these completions with the ordered criteria persisted in
`task.json` and attaches an `implProgress` summary to the plan (done, total,
completed ids, and the next incomplete criterion). `session-start` writes it into
`.devmate/state/resume-plan.json`, the resume message reads "Implementation: X/Y
ACs complete, next AC{n}: …", and the `<devmate-state>` anchor shows the same
tally — so a session resumed the next day knows exactly which criteria remain and
implements only those.

## Usage

```
node scripts/resume.mjs --task <taskId> [flags]
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--task <taskId>` | Required. Which task to resume. |
| `--trace-dir <dir>` | Optional. Directory holding the trace file (tests). |
| `--handoff-dir <dir>` | Optional. Directory holding the handoff artifact (tests). |
| `--compaction-dir <dir>` | Optional. Directory holding compaction artifacts (default `.devmate/state/compaction`). |
| `--confirm` | Proceed past a confirm-needed plan (trace has malformed lines). |
| `--strategy-change` | Unblock a halted step by recording a strategy-change marker. |
| `--dry-run` | Print the plan; never write any trace state. |

## Plan actions

| Action | Meaning |
| --- | --- |
| `proceed` | Safe to resume from the next uncompleted step. |
| `confirm_needed` | Trace has malformed lines; re-run with `--confirm`. |
| `blocked_halt` | A step is halted; re-run with `--strategy-change`. |
| `already_complete` | Every recorded step is complete; nothing to resume. |

## Exit code contract

| Code | Meaning |
| --- | --- |
| `0` | Proceed, already complete, or a strategy change was recorded. |
| `1` | Error: missing `--task`, or the trace could not be built. |
| `2` | Blocked: a human decision is required (`--confirm` or `--strategy-change`). |

## Strategy change

When a step is halted, `--strategy-change` appends a new `step_complete`
marker with a fresh `stepId` and a `<label>-strategy-change` label. The new
`stepId` records that a different approach is being taken, rather than
re-dispatching the original halted step as-is.
