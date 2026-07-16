# Memory System

devmate stores cross-task memory as rendered facts in `.devmate/MEMORY.md`.
The runtime pipeline is deterministic and path-safe:

1. PostToolUse writes facts to `.devmate/memory/tasks/<taskId>.jsonl`.
2. Completion, compaction, **and normal session end** promote active facts into
   `.devmate/state/repo/repo.jsonl`.
3. Renderer regenerates `.devmate/MEMORY.md` from the active repo ledger.

This keeps task-local staging separate from shared memory while ensuring the
committed memory file is always generated from current structured state.

### Capture triggers

Promotion + render (the "capture" step) is shared across three triggers via
`lib/memory/capture.mjs` (`captureMemory`) so they never drift:

- **Task completion** — `scripts/complete-task.mjs`.
- **PreCompact** — `scripts/compact-session.mjs`, before context is dropped.
- **Session end (Stop)** — `scripts/session-stop.mjs`, so a session that ends
  without a formal completion or a compaction still persists its facts instead
  of stranding them in the task ledger.

`taskId` is validated (`TASK_ID_RE`) at **creation** in
`scripts/init-task-state.mjs`, not just at write time — a malformed id is
rejected up front instead of silently disabling memory writes for the task.

### Pre-task window (HITL-3)

Before `scripts/init-task-state.mjs` has created `.devmate/state/task.json`
(plain chat, help, the whole discovery → grill → planning analysis phase),
collection is **skipped quietly**: the PostToolUse fact-writer emits a single
memory.skip stderr line with reason pre_task and exits 0 — no fact, audit, or
evidence writes. This window is safe to be quiet because an implementation
dispatch with no task.json is denied structurally by the dispatch gate
(HITL-1, `lib/workflow/dispatch-gate.mjs`). A task.json that **exists but
cannot be read** (malformed JSON / schema-invalid) is a real fault and stays
loud: memory.error with reason state_unreadable, exit 1 — as does a
well-formed file carrying an invalid taskId (memory.error, invalid_task_id).

### Recall (reading memory back)

- **Injection at session start** — in single-root mode, `scripts/session-start.mjs`
  queries the repo ledger and emits a bounded, scored top-N `<devmate-memory>`
  block into context, so an agent starts with relevant prior facts instead of
  re-inferring them. (Multi-root mode injects per-repo memory via `repoMemories`.)
- **On-demand query** — `scripts/query-memory.mjs` / `lib/memory/query.mjs`
  return the top-N most relevant facts for a lane / path prefix / tag, as compact
  pointer+summaries (never raw contents).
- **MCP tool** — `mcp/memory-server.mjs` exposes `query_memory` as a first-class
  Model Context Protocol tool (registered via a plugin-root `.mcp.json`), so the
  model can call recall directly mid-session.
- **Verify-before-use** — session-start injection and the MCP tool verify each
  recalled fact's `source` still resolves to live code and drop drifted facts by
  default; `query-memory --verify` opts into the same check on the CLI.

Rendered memory is a **hint, not ground truth**: verify a fact against current
code before relying on it. When `MEMORY.md` grows past a soft line cap the
renderer emits `memory.render.oversize` (it never clips) so it can be compacted.

### Diagnostics & observability

- **`scripts/devmate-doctor.mjs`** (`diagnoseMemory`) health-checks the three
  stages in sequence and names the first that looks broken — the fastest way to
  triage "memory isn't updating".
- Collection and compaction emit `fact_write` and `compaction` trace events, so
  the pipeline can be reconstructed from `.devmate/state/trace/<taskId>.jsonl`.

## Canonical paths

All memory paths are defined in `lib/memory/paths.mjs`:

- `MEMORY_PATH`: `.devmate/MEMORY.md`
- `TASK_LEDGER_DIR`: `.devmate/memory/tasks`
- `REPO_LEDGER_REL`: `.devmate/state/repo/repo.jsonl`
- `taskLedgerPath(repoRoot, taskId)` validates `taskId` via `TASK_ID_RE` before
  constructing the path (fail-closed).

No other module should hardcode these paths.

## Fact entry shape

Fact lines are JSON objects (`event: "fact"`) with stable identity:

```json
{
  "event": "fact",
  "key": "lib/auth.mjs:abcd1234",
  "source": "lib/auth.mjs",
  "tool": "write_file",
  "lane": "feature",
  "tags": ["ext:mjs"],
  "summary": "write_file edited auth.mjs",
  "confidence": 0.8,
  "ts": 1782812345678,
  "stepId": "1",
  "firstEdit": true,
  "contentDigest": "abcd1234..."
}
```

`key` is conflict identity (`source + digest-prefix` or `source + ts` fallback).
Within-task stale marking remains source-scoped; cross-task conflict resolution
is key-scoped.

## Discovery facts (FO-6)

Edit facts capture *what changed*; discovery facts capture *what discovery
established about the repo* — so a later session recalls prior findings
instead of re-deriving them from scratch. They flow through an **explicit
API only** (`writeDiscoveryFacts` in `lib/memory/discovery-facts.mjs`), never
a PostToolUse hook: `scripts/merge-discovery.mjs` calls it after writing the
merged discovery artifact, and emits one `fact_write` trace event per
non-empty batch. The fact-writer's edit-only PostToolUse policy is unchanged.

### Write path

- Each merged claim becomes a normal ledger fact (`event: "fact"`) matching
  the schema above exactly, with `tool: "discovery-merge"` as the kind marker
  so queries can distinguish discovery facts from edit facts.
- Confidence maps `high` → 0.9, `low` → 0.6; the summary is the claim text
  (capped at 120 chars); tags come from the shared tagger in
  `lib/memory/fact-writer.mjs`.
- `key` is `path` + the first 8 hex of the claim text's digest — identity is
  (file, claim), so the same claim re-discovered by a later task hits the
  same key and promotion's `keep-incoming` policy replaces it.
- **Freshness anchor:** `contentDigest` is the referenced file's 16-hex
  content digest at write time. Claims flagged `needsReview: true`
  (unadjudicated conflicts) and claims whose file does not exist are skipped
  and counted, never written.
- **Idempotent per task:** a re-run stales the prior discovery batch before
  appending the new one (one lock, one critical section). Edit facts are
  never touched. Promotion (`promoteLedger`) carries discovery facts through
  its transactional promote unchanged.

### Staleness semantics

Staleness is **check-on-read**, not invalidation-on-edit: `query-memory
--stale-check` (or `queryMemory` with `staleCheckRoot`) recomputes each
recalled discovery fact's file digest and annotates `stale: true` on mismatch
or a missing file. Stale facts are annotated, never dropped — the caller
decides. The check is opt-in (digesting files costs IO) and bounded by the
top-N output cap.

### Recall usage

`query-memory` returns discovery facts visibly typed (`kind: "discovery"`,
`[discovery]` summary prefix). The feature-lane procedure passes the paths of
recalled **fresh** discovery facts to `scripts/discovery-scan.mjs
--seed-files`, where they seed the by-imports / by-test-mirror strategies and
boost seed-proximity scoring. Recall hints seed the scan; they never replace
it — stale or unverified hints are re-verified by the normal discovery flow,
and memory never bypasses evidence.

## Rendered MEMORY.md format

`renderMemory()` rewrites only the generated section between markers:

```md
<!-- devmate:facts:start -->
## lib/auth.mjs
- write_file edited auth.mjs (task: task-1, added: 2026-06-30T12:00:00.000Z)
<!-- devmate:facts:end -->
```

If markers are missing, they are appended after the existing header text.
Writes are atomic (`.tmp` then rename).

## What is intentionally not stored

The memory pipeline stores concise pointers and summaries, not raw session data.
It never stores:

- full chat history,
- full file contents,
- full test output blobs.

This preserves recall while minimizing token and leakage risk.

## Stale invalidation

Within task ledgers, stale markers invalidate superseded source facts.
At promotion, active facts are conflict-resolved by `key`:

- same key: conflict policy applies (`keep-existing`, `keep-incoming`, `keep-both`),
- same source but different key: both facts may coexist.

## Migration and CI guardrails

Legacy path migration remains available:

```powershell
node scripts/migrate-memory-path.mjs
node scripts/migrate-memory-path.mjs --dry-run
```

`scripts/check-memory-path-refs.mjs` enforces canonical path usage in source
and docs, excluding files that must legitimately reference historical paths.
