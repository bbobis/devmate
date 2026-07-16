# Parallel dispatch

devmate can dispatch the `backend` and `frontend` personas concurrently when a
spec touches both stacks and there is no overlap on individual files. This page
covers how the partitioner decides between parallel and sequential dispatch, the
join condition that must be satisfied before E2E runs, and the workspace
setting your VS Code installation needs.

## Why parallel?

A typical feature touches an API endpoint on the backend and a panel on the
frontend. If the two personas never write the same file, dispatching them in
parallel halves implementation time. When a shared contract (for example,
`openapi.yaml`, `src/api/types.ts`) exists, the contract must land first so
both downstream workstreams build against the same source of truth — that path
runs sequentially.

## Step 2 analysis fan-out — the two-phase discovery flow (FO-5)

Before the orchestrator partitions implementation workstreams, Feature Lane
Step 2 runs code lookup as a **deterministic scatter → bounded agentic
gather**, and the rest of the lane sees exactly one discovery artifact:

1. **Phase 1 — deterministic candidate scan (zero LLM cost).** The
   orchestrator executes `scripts/discovery-scan.mjs` (which runs its four
   scan strategies in parallel via `lib/orchestrator/fanout.mjs` — see
   [discovery-scan.md](./discovery-scan.md)) and Reads the ranked candidate
   artifact at `.devmate/state/discovery-candidates.json` by its known path.
2. **Branch.** If the scan is insufficient or found nothing, the lane falls
   back to today's single `@discovery` dispatch, unchanged. If the candidate
   list fits within the task's `max_context_sources`, a single `@discovery`
   is dispatched, seeded with the candidate pointers. Otherwise K scoped
   `@discovery` workers run on DISJOINT candidate partitions from
   `partitionCandidates` (`lib/discovery/partition.mjs`) — K by budget class:
   `tiny` never fans out, `standard` = 2, `large` = 3. Every worker prompt is
   built by `buildDiscoveryDispatch`
   (`lib/workflow/build-discovery-dispatch.mjs`), whose completeness
   poka-yoke and structural partition boundaries mirror
   `buildDispatchPayload`.
3. **Waves under the ceiling.** The K workers plus `@tech-design` share the
   `maxConcurrentAgents` (3) ceiling and dispatch in waves of at most 3; the
   orchestrator never leans on the budget guard's deny to do the arithmetic.
   All Phase-2 workers and `@tech-design` are read-only (no `edit` tools) and
   P5-isolated (no shared mutable state), so every wave is safe to
   parallelize; the prompt's inline `<!-- PARALLEL DISPATCH -->` block tells
   the LLM to emit each wave's `agent` tool calls in one response turn, and
   VS Code's native parallel subagent scheduler (v1.109+) fires them
   concurrently.
4. **Phase 2 fan-in.** Worker artifacts persist under
   `.devmate/state/worker-returns/`; `scripts/merge-discovery.mjs` merges
   them (dedup, corroboration, conflicts, rank-before-cap — see
   [discovery-merge.md](./discovery-merge.md)) into
   `.devmate/state/discovery-merged.json`, validated live by the
   contract-validator hook. The `discovery-done` gate advances on the merged
   artifact, and `@tech-design`, `@rubber-duck`, and the planner consume it
   exactly as they consume a single `@discovery` result.

Degradation is explicit, never silent: a contract-violating worker is
dropped and the merge proceeds with the valid remainder; if every worker is
invalid the lane falls back to the single `@discovery` dispatch; a quota
deny mid-wave finishes that wave sequentially.

Note the two kinds of parallelism stay distinct: `lib/orchestrator/fanout.mjs`
parallelizes **library scan workers** (Node thunks inside one process — the
Phase-1 scan); the VS Code subagent scheduler parallelizes **agent workers**
(the Phase-2 scoped `@discovery` dispatches and `@tech-design`). Phase 1 is
therefore fanout-powered, while agent-level dispatch still flows through the
prompt's wave instructions and the sub-agent budget guard.

## The partitioner

`partitionWorkstreams(specFiles, personas)` lives in
`lib/workstream-partitioner.mjs`. It walks every file in the spec's
"Files that will change" section and classifies each one against the
`editableGlobs` and `offLimitsGlobs` declared in `devmate.config.json`.

| Bucket          | Rule                                     |
| --------------- | ---------------------------------------- |
| `backendFiles`  | matches backend persona globs only       |
| `frontendFiles` | matches frontend persona globs only      |
| `sharedFiles`   | matches both personas OR neither persona |

The resulting `mode` is one of four values:

| Mode                        | When it applies                                              |
| --------------------------- | ------------------------------------------------------------ |
| `parallel`                  | both buckets non-empty AND `sharedFiles` is empty            |
| `sequential-shared-first`   | `sharedFiles` non-empty (shared contract or unmatched files) |
| `sequential-backend-first`  | only `backendFiles` non-empty                                |
| `sequential-frontend-first` | only `frontendFiles` non-empty                               |

Note: a file that matches neither persona's globs lands in `sharedFiles` so the
orchestrator handles it explicitly rather than skipping it.

## Effort scaling (E10-06)

Fan-out is sized to the task, not to a fixed lane shape. The orchestrator maps
the router's `budgetClass` to a dispatch shape, minimizing concurrent fan-out
first — split into parallel workstreams only when the task genuinely needs it
(delegation itself is never optional; scaling sizes only the parallelism):

| `budgetClass` | Fan-out shape                                                        |
| ------------- | -------------------------------------------------------------------- |
| `tiny`        | Single persona; skip parallel fan-out (collapse parallel steps).      |
| `standard`    | Current partitioned dispatch (at most backend + frontend in parallel).|
| `large`       | Orchestrator-proposed decomposition, bounded — never unbounded.       |

Two bounds keep `large`-class decomposition finite:

1. **Proposal bound.** `partitionWorkstreams` accepts an optional
   `maxParallel` ceiling (default: the exported `MAX_PARALLEL_WORKSTREAMS`
   constant in `lib/workstream-partitioner.mjs`, provisional pending the
   calibration procedure below). A ceiling below 2 downgrades `parallel` mode
   to `sequential-backend-first`, so concurrent dispatch never exceeds the
   bound. FO-8: the feature lane passes the config's `maxConcurrentAgents`
   through as this ceiling, so the proposal bound and the runtime ceiling
   share one source of truth.
2. **Runtime hard ceiling.** The sub-agent budget guard
   (`hooks/subagent-budget-guard.mjs`) denies subagent starts beyond
   `maxConcurrentAgents` regardless of what the orchestrator proposes. Effort
   scaling proposes within this ceiling; it never weakens or bypasses it.

## Calibrating the ceilings (FO-8)

Both concurrency ceilings are provisional and have never been justified by
data: `MAX_PARALLEL_WORKSTREAMS` (`lib/workstream-partitioner.mjs`) bounds
what the orchestrator proposes, and `maxConcurrentAgents`
(`hooks/subagent-budget-guard.mjs` default, `.devmate/devmate.config.json`)
is the runtime hard ceiling. `node scripts/fanout-report.mjs` produces the
evidence for changing either one: it joins a task's trace (subagent
start/complete windows, the discovery-merge counts) with the worker-telemetry
ledger and reports K used, max overlap depth, speedup (serial-equivalent
worker time ÷ wall-clock window), scan-phase latency/violation rates, merge
dedup quality, and completion-token cost.

**The decision rule:**

> Collect ≥ 20 standard/large feature-lane runs
> (`node scripts/fanout-report.mjs --all`). Raise `maxConcurrentAgents` (and
> K for `large`) only if: median speedup at the current ceiling ≥ 1.5×,
> violation rate < 5%, dedup rate < 30% (partitioning is working), and
> session-budget `budget_warning` events did not increase. Lower K if
> speedup < 1.2× or dedup rate > 50%. Record the decision and the report
> snapshot in the CHANGELOG when a constant changes.

Reading the report honestly:

- **Speedup** compares the fan-out window's wall-clock against the
  serial-equivalent sum of worker durations; workers that ran back-to-back
  (interleaved but never overlapping) report a speedup near 1.0×.
- **Dedup rate** is only computed when the merge event's counts are
  comparable. Today the `discovery_merge` event records worker-artifact and
  claim counts, so the report flags that gap instead of inventing a number —
  recording input-claim counts on the event is the follow-up that unlocks
  this metric.
- **Cost** treats completion tokens as a lower bound: the fanout library
  records promptTokens as 0 today, and the report says so rather than
  guessing.
- Report verdicts (GREEN/YELLOW/RED) are advisory heuristics documented in
  `lib/orchestrator/fanout-report.mjs` — they never gate CI or a run.

## Dispatch-payload completeness (E10-06)

Every implementation dispatch prompt is built by `buildDispatchPayload`
(`lib/workflow/build-dispatch-payload.mjs`), which rejects under-specified
payloads: `objective`, `outputFormat`, `toolGuidance`, and `boundaries` are
required, and a missing or empty field throws an error naming that field. A
subagent therefore always knows what to do, what to return, which tools to
use, and where its task ends — the poka-yoke that stops duplicate or drifting
subagent work before dispatch.

### Target AC ids (AC-5)

The payload also carries the dispatch's explicit **global** acceptance-criterion
assignment. The planner's per-task `ac[]` labels are task-local (they restart
at `AC1` in every task); the optional `targetAcs` option renders a
"Target acceptance criteria" section listing `targetAcIds` — the global `AC{n}`
ids matching the `index+1` numbering `spec.md` uses — plus each criterion's
capped text and the instruction to report `completedAcIds` as a subset of those
ids, verbatim. The mapping is computed deterministically by
`deriveTaskAcAssignments` (`lib/workflow/agents/spec-writer.mjs`), the same
flattening that numbers `spec.md`, so a second task's local `AC1` resolves to
its global position (for example `AC3`) and `@fullstack` never infers the
local→global translation. Dispatches with no ACs omit the section cleanly.

### Domain context (DN-3)

On repos with a confirmed domain map (the optional domains config section,
see [config.md](config.md)), the payload can also carry a **budgeted**
per-domain context section so the worker starts with high-precision domain
knowledge instead of rediscovering it via tool calls. The caller reads the
DN-2 state file at `.devmate/state/domain-context.json` by its known path
(the same way persona context gets its inputs from the loaded config) and
passes the parsed state plus an injected file reader as the optional
`domainContext` option; the builder itself never touches the filesystem for
domain context, so repos without domains produce **byte-identical** payloads.

Per active domain (already ranked and capped by the resolver's top-N), the
section renders the domain id, the globs the task's seed files matched, the
related-domain ids, and the domain's context-file content — capped by the
single token estimator (`lib/context/estimate-tokens.mjs`) under a total
budget of `DOMAIN_CONTEXT_MAX_TOKENS` (1500, provisional) across all domains,
enforced by `loadDomainContextForDispatch`
(`lib/context/domain-context-load.mjs`). Degradation is loud, never silent
(TCM-9): an over-budget file renders a digest (first lines + heading list)
plus an explicit pointer naming the file to read; a missing file renders a
"context file missing" note, and session-start warns about
declared-but-missing domain context files the same way it warns for persona
instruction files. Budget fitting runs in rank order — the first domain gets
priority, later ones absorb the truncation.

## Dispatch flow after `spec-approved`

After the human approves the spec and the workflow lands on `impl-started`:

1. The orchestrator reads the file list from `spec.md`.
2. It calls `partitionWorkstreams` with the file list and the persona array
   from `devmate.config.json`.
3. The returned `mode` decides the dispatch order:
   - `parallel` — dispatch backend and frontend simultaneously, then wait for
     the join condition (see below) before dispatching E2E.
   - `sequential-shared-first` — dispatch the shared contract first as an
     `editor` or `fullstack` work item, then dispatch backend and frontend.
   - `sequential-backend-first` / `sequential-frontend-first` — single
     persona, dispatched in the obvious order.
4. If the join condition fails after two retries, the orchestrator escalates
   to the human via a chat message rather than dispatching E2E with broken
   units.

## Join condition

E2E and integration tests dispatch only after both unit suites land green.
`checkJoinCondition(statePath)` reads `.devmate/state/gates.json` and returns:

```js
{ backendUnitPass: boolean, frontendUnitPass: boolean, met: boolean }
```

The two dependency gates `backend-unit-pass` and `frontend-unit-pass` are
already registered in `lib/dependency-gates.mjs`. The orchestrator polls
`checkJoinCondition` after each fullstack dispatch returns, and only advances
to E2E once `met === true`.

## Required workspace setting

Sub-agent dispatches require this VS Code workspace setting:

```jsonc
{
  "chat.subagents.allowInvocationsFromSubagents": true,
}
```

Without it, the orchestrator's `agent` tool calls into `@fullstack` are
silently dropped and your dispatch never starts. Add the setting to
`.vscode/settings.json` in your repo.

Sub-agent dispatches also require:

```jsonc
{
  "chat.customAgentInSubagent.enabled": true
}
```

Without this setting, custom `.agent.md` agents (such as `@discovery` and
`@tech-design`) cannot be invoked as subagents even if
`allowInvocationsFromSubagents` is enabled. Add both settings to
`.vscode/settings.json` in your repo.

## When parallel is unsafe

> **Analysis fan-out (Step 2) is always safe regardless of `sharedFiles` — the
> sequencing rules below apply only to implementation dispatch (Step 12).**

There are three cases where the partitioner deliberately falls back to
sequential dispatch:

1. **Shared contract present.** Any file matching both personas' editable globs
   ends up in `sharedFiles`. The shared contract dispatches first; backend and
   frontend run only against the post-contract tree.
2. **Files matching neither persona.** Docs, configs, and CI files have no
   persona ownership — those land in `sharedFiles` so the orchestrator routes
   them through the `editor` persona explicitly.
3. **Off-limits collision.** If a file is owned by one persona and explicitly
   off-limits to the other, only the owning persona writes it. The partitioner
   already honors `offLimitsGlobs` so this case resolves to the correct
   single-persona dispatch.

## Trace events

Each dispatch produces structured trace events under `.devmate/trace/<task>/`.
The orchestrator emits one `action` event per agent dispatch and one
`gate_transition` event when the join condition is satisfied. Inspect with
`node scripts/view-trace.mjs --task <id>` to confirm a parallel run actually
ran in parallel rather than sequentially.

---

_Grounding: VS Code custom agents and sub-agent invocation docs; see
[Copilot Extensibility Overview](https://code.visualstudio.com/docs/copilot/copilot-extensibility-overview)._
