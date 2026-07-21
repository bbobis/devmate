# Feature Lane — Full Procedure

## Steps (must be followed in order)

**0. Lane classification** — handled by common step 0 in the orchestrator.

**1. Ingest and classify.** Record `budgetClass` from the router output contract.

> **Recall first.** Consult the devmate-memory recall block injected at session
> start (it already contains the facts recalled for the paths in scope) before
> re-deriving known facts. Treat recalled facts as
> hints — verify each against current code before relying on it. Collect the
> `source` paths of recalled `[discovery]` facts that are NOT marked `stale` and
> pass them to the Step 2 candidate scan via `--seed-files` — they seed the
> by-imports / by-test-mirror strategies and boost seed-proximity scoring.
> Recall hints seed the scan; they never replace it: stale or unverified hints
> are re-verified by the normal discovery flow, and memory never bypasses
> evidence.

> **Effort scaling.** Pre-spec fan-out (steps 2 and 6) and implementation
> partitioning (step 11) scale with the recorded `budgetClass`: `tiny` may
> collapse parallel steps into a single dispatch, `standard` follows the
> partitioned dispatch below, and `large` proposes a bounded decomposition
> capped by `MAX_PARALLEL_WORKSTREAMS` from `lib/workstream-partitioner.mjs`.
> The sub-agent budget guard remains the hard concurrency ceiling. See
> "Effort scaling (all lanes)" in `agents/orchestrator.agent.md`.

**2. Parallel discovery + design — fan-out.** Both `@discovery` and
`@tech-design` are read-only. You have no terminal: do not try to run a scan or a
merge script, and do not go looking for one. Step by step:

1. **Size the fan-out** from `budgetClass`: `tiny` → a single `@discovery`;
   `standard` → 2 scoped workers; `large` → 3. Scope each worker to a DISJOINT
   area of the codebase so their contexts do not overlap.
2. Dispatch the workers and `@tech-design` in waves of <= `maxConcurrentAgents`
   (3) — they share that ceiling; never rely on the budget guard's deny. If the
   guard denies a start mid-wave, finish the wave sequentially.
3. **Each result is persisted for you** by the PostToolUse hook at
   `.devmate/state/worker-returns/discovery.<toolUseId>.json`. A worker whose
   return is missing or malformed is dropped — proceed with the valid remainder.
   If ALL workers came back empty, that is a HALT: re-dispatch. An agent that
   returned nothing is never a licence to do the discovery yourself.
4. **Fan in by Reading those returns** and synthesizing the merged picture: keep
   the claims, collapse duplicates, flag conflicts. They are small typed
   artifacts, so this is synthesis of returned summaries — the one kind of
   reading this role is for — not the read-heavy analysis the Delegation policy
   forbids.

**3. [INTERNAL GATE] `discovery-done`** — advance automatically on the merged
artifact (fan-out path) or on the single validated `@discovery` result
(fallback branches). `@tech-design`, `@rubber-duck`, and the planner consume
the merged artifact exactly as they consume today's single artifact.

**4. Grill.** Dispatch `@rubber-duck` with `mode: 'grill'`. The result is a `GrillResult`.
Blocking questions become assumption checkboxes in `spec.md` — they do not block this gate.

**5. [INTERNAL GATE] `grill-done`** — advance automatically.

**6. Plan + UI brief.** Dispatch `@planner` and `@ui-ux` in the same response turn.
The planner must emit `alignment[]` (`reuse | extend | add` evidence) on every
task; `validatePlannerArtifact` fails closed without it (#238).

**7. [INTERNAL GATE] `plan-done`** — advance automatically.

**8. Critique.** Dispatch `@rubber-duck` with `mode: 'critique'` and `iterationNumber: 1`.
Verdict is `APPROVE_PLAN` or `REQUEST_REVISION:<reason>`. On revision: re-dispatch `@planner`
(emit `plan_revised` with `revision: 1`), then re-dispatch `@rubber-duck` with
`iterationNumber: 2`. After two revisions, fold remaining open items into risks and proceed.

**9. Spec.** Dispatch `@spec-writer` with compressed discovery + grill + plan + critique output.
`spec-writer` produces `.devmate/session/spec.md` and updates `task.json` with spec artifact
metadata. The spec-integrity-guard hook advances the gate to `spec-draft` when the spec is written — on the feature
lane this is the only legal move out of `plan-approved` (HITL-2); start-impl is legal only
from `spec-approved`, and entering `impl-started` requires the recorded spec artifacts.

**10. [HUMAN GATE] `spec-draft`** — the human reviews `spec.md`. Present the gate options
(1. Approve  2. Request changes  3. Ask a question  4. Abandon) and classify the next
message per the orchestrator's "Human gates — input handling" protocol BEFORE any other
action. Explicit approval advances; ANY requested change, correction, addition, or
concern — regardless of phrasing — IS revision feedback: re-dispatch `@spec-writer` with
the feedback, stay at the gate, re-present. Questions are answered from the artifacts
without advancing. Never infer approval; never stop dispatching subagents because the
phrasing was unexpected.

**11. Implementation.** On human approval, advance gate to `impl-started`. Partition the spec
file list by persona. Build each dispatch via `buildDispatchPayload(..., lane: "feature")`,
which renders the `## Codebase alignment evidence` section and fails closed if any task
lacks `alignment` (#238). Dispatch order:
- `parallel` — dispatch backend and frontend in the same turn.
- `sequential-shared-first` — dispatch the shared-contract persona first, then the others.
- Single-persona — dispatch once.

After parallel dispatches complete, confirm both `backend-unit-pass` and `frontend-unit-pass`
dependency gates pass before dispatching `@frontend-tester`. If the join condition is not met
after two retries, escalate to the human.

**Track per-AC progress.** Each `@fullstack` return is persisted for you by the PostToolUse hook under `.devmate/state/worker-returns/`; its `payload.completedAcIds` records which ACs that dispatch finished. On resume (a fresh session mid-implementation), read the
`implProgress` in `.devmate/state/resume-plan.json` and dispatch `@fullstack`
only for acceptance criteria that are not yet complete — never re-implement an
AC whose `impl-AC{n}` completion already exists.

**AC coverage before advancing.** After the implementation dispatches return and before firing `pass-verification`, Read those returns and compare `completedAcIds` against the task's `acceptanceCriteria`. Re-dispatch `@fullstack` for only the missing ACs — the gate is still `impl-started`, where re-dispatch is legal — at most 2 re-dispatches per AC (TODO: calibrate after Phase 1 — provisional). If an AC is still missing after that bound, park the task and escalate to the human. This prose is guidance; the AC-coverage
gate precondition is the guarantee.

**12. Security.** Evaluate security requirements from grill + discovery output. If a security
review is required and `agents/security.agent.md` exists, dispatch `@security`. If optional,
record the skip reason.

**13. [HUMAN GATE] `pr-ready`** — the human reviews the PR. Classify the reply per the
orchestrator's "Human gates — input handling" protocol: only explicit approval completes
the lane; any requested change — regardless of phrasing — is revision feedback (stay at
the gate, re-present); questions are answered without advancing or abandoning the gate.
