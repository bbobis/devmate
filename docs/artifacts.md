# Artifact Lifecycle: `spec.md`

> Source: Issue #164 (E10-1) — maintained in sync with `lib/spec-writer.mjs`.

## Overview

The `spec.md` artifact is the single human-facing review document produced by
the orchestrator's feature lane **before** the workflow advances to
`spec-approved`. It collapses the original three-artifact model
(`discovery.md`, `plan.md`, `spec.md`) into one compressed, structured document.

## Dual-write principle

| Store                      | What lives there                                           | Who reads it           |
| -------------------------- | ---------------------------------------------------------- | ---------------------- |
| `.devmate/state/task.json` | `artifacts.spec` (path) + `artifacts.specDigest` (SHA-256) | Machines / gate-guard  |
| `.devmate/session/spec.md` | Human-readable review surface                              | Human reviewer / agent |

The JSON state is the **machine truth**. The markdown file is the **human
review surface**. Both are written atomically in the same `writeSpec` call.

## `spec.md` Schema

The written file follows exactly this structure (9 required sections):

```markdown
# Spec: <title>

## What we're building

<summary>

## Why (from discovery)

Current behavior: <currentBehavior>
Gap: <gap>

## Edge cases surfaced during grill

- <edgeCase1>
- <edgeCase2>

## Assumptions — please verify

- [ ] <assumption1>
- [ ] <assumption2>

## Files that will change

- `path/to/file.mjs` — reason
- `path/to/test.mjs` (new) — reason

## Acceptance criteria

- [ ] AC1: <criterion>
- [ ] AC2: <criterion>

## TDD approach

- AC1 → test: `<testName>` in `<testFile>`
- AC2 → test: `<testName>` in `<testFile>`

## Risks

- <risk1>

## Out of scope

- <exclusion1>
```

## Lifecycle

1. **Orchestrator calls `writeSpec(repoRoot, content)`** at step 9 of the
   feature lane, after discovery → grill → plan → critique stages complete.
2. `writeSpec` writes `.devmate/session/spec.md` and records the path + digest
   in `task.json` under `artifacts.spec` and `artifacts.specDigest`.
3. **Human reviews** `.devmate/session/spec.md` and either approves or requests
   changes.
    - **On requested changes**, the orchestrator re-dispatches `@spec-writer`
      with the feedback (`docs/orchestrator-conversation.md`). `spec-writer`
      reads the existing `.devmate/session/spec.md` with its `read` tool,
      applies the feedback, and rewrites the same path — it never creates a
      scratch, backup, or temp file to stage the revision. The gate stays at
      `spec-draft` until an explicit `approve spec`.
4. **Gate-guard (E10-4)** checks `artifacts.spec` exists on disk before
   allowing the `spec-approved` gate transition.
5. **If `spec.md` is modified after `spec-approved`** (E10-3), the gate rolls
   back to `spec-draft` automatically.

## Acceptance-criteria progress (implementation phase)

During implementation (`impl-started`), per-acceptance-criterion progress is
tracked so a resumed session knows exactly which criteria are done and which to
implement next — instead of only the coarse gate.

| Store | What lives there | Role |
| --- | --- | --- |
| `.devmate/state/trace/<taskId>.jsonl` | one `impl-AC{n}` `step_complete` event per completed criterion | **completion truth** |
| `.devmate/state/task.json` (`acceptanceCriteria`) | ordered criterion labels; index+1 is the stable id (`impl-AC{n}`, equal to `TC-00{n}`) | id ↔ label map |
| `.devmate/session/spec.md` (`## Acceptance criteria`) | `- [x] AC{n}:` checkboxes synced from the trace | human-readable view |

Lifecycle:

1. **spec-writer** persists the ordered `acceptanceCriteria` list into `task.json`
   at spec-write time (`lib/workflow/agents/spec-writer.mjs`), so criterion ids are
   stable across sessions.
2. When a workstream reports a criterion GREEN (via the `@fullstack`
   `completedAcIds` payload), the orchestrator runs `scripts/complete-ac.mjs`,
   which appends a canonical `impl-AC{n}` `step_complete` event (`appendTraceEvent`)
   and calls `lib/spec-progress.mjs` to check off `- [ ] AC{n}` → `- [x] AC{n}` and
   refresh `artifactHashes.specDigest` (`recordArtifactHash`). The write is direct
   filesystem I/O and happens at `impl-started`, so the spec-integrity guard (which
   only acts at `spec-approved`) never fires.
3. On resume, `buildResumePlan` joins the trace with the persisted list and reports
   the X/Y tally + next criterion; the orchestrator dispatches only criteria without
   an `impl-AC{n}` completion — completed criteria are never re-implemented.

## Session directory

`.devmate/session/` is a runtime directory — it is listed in `.gitignore` and
never committed. Its contents are ephemeral and scoped to the current VS Code /
Copilot session.

## Error handling

`writeSpec` throws a `SpecWriteError` (typed error class exported from
`lib/spec-writer.mjs`) if any required `SpecContent` field is missing.

## Idempotency

Calling `writeSpec` twice with the same `SpecContent` produces the same
SHA-256 digest. The file is overwritten deterministically.
