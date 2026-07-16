# Gates Reference

This file is the canonical reference for all gate names, statuses, and subcommand syntax used by `scripts/gatectl.mjs` — authoritative for the gate machinery only. See [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) (E9-28) for the integrated end-to-end view.

---

## Workflow Gates

Workflow gates track numbered pipeline progress for a task. They are stored in `.devmate/state/task.json` (`workflowGate` field).

| Gate name             | Description                                      |
| --------------------- | ------------------------------------------------ |
| `no-lane`             | Pre-router. The gate every task is bootstrapped at. |
| `lane-set`            | The router classified the lane.                  |
| `discovery-done`      | Discovery fan-in merged (feature lane).          |
| `grill-done`          | The grill returned (feature, bug).               |
| `plan-done`           | The plan was critiqued (feature lane).           |
| `plan-approved`       | Plan has been approved; no implementation yet.   |
| `spec-draft`          | Spec written; awaiting human review (feature lane). |
| `spec-approved`       | Human approved the spec (feature lane).          |
| `impl-started`        | Implementation is in progress.                   |
| `verification-passed` | All verification checks pass.                    |
| `pr-ready`            | PR is ready for review (feature/bug lanes only). |
| `done`                | Task complete; terminal gate.                    |
| `parked`              | Task paused (E10-05); the persisted resume pointer records the gate to return to. |
| `abandoned`           | Task deliberately dropped (E10-05); terminal gate. |

### Workflow Gate Events

| Event               | Transitions from      | To                    | Lanes        |
| ------------------- | --------------------- | --------------------- | ------------ |
| `set-lane`          | `no-lane`             | `lane-set`            | all          |
| `finish-discovery`  | `lane-set`            | `discovery-done`      | feature      |
| `finish-grill`      | `discovery-done`      | `grill-done`          | feature      |
| `finish-grill`      | `lane-set`            | `grill-done`          | bug          |
| `finish-plan`       | `grill-done`          | `plan-done`           | feature      |
| `draft-spec`        | `plan-done`           | `spec-draft`          | feature      |
| `present-plan`      | `grill-done`          | `plan-approved`       | bug          |
| `present-plan`      | `lane-set`            | `plan-approved`       | chore        |
| `draft-spec`        | `plan-approved`       | `spec-draft`          | feature      |
| `start-impl`        | `spec-approved`       | `impl-started`        | feature      |
| `start-impl`        | `plan-approved`       | `impl-started`        | bug, chore   |
| `pass-verification` | `impl-started`        | `verification-passed` | all          |
| `mark-pr-ready`     | `verification-passed` | `pr-ready`            | feature, bug |
| `complete`          | `pr-ready`            | `done`                | feature, bug |
| `complete`          | `verification-passed` | `done`                | chore        |
| `revise-scope`      | `impl-started`        | `spec-draft`          | all          |
| `re-plan`           | `impl-started`        | `plan-done`           | all          |
| `new-requirements`  | `spec-draft`          | `grill-done`          | all          |
| `park`              | any in-flight gate    | `parked`              | all          |
| `resume`            | `parked`              | recorded gate (from the resume pointer) | all |
| `abandon`           | any in-flight gate or `parked` | `abandoned`  | all          |

> **Note:** The `chore` lane does not require a `pr-ready` gate — it transitions directly from `verification-passed` to `done` via `complete`.

### Who advances a gate (#91)

**No agent can.** Not the orchestrator, which owns gate state and declares
`tools: ['agent', 'read', 'search', 'todo']` — no `execute`, so no `gatectl`, no
JS function call, no terminal of any kind. Gates move in exactly two places, both
hooks, because a hook is the only part of devmate that can actually run code:

| Mover | Event | What it advances on |
| --- | --- | --- |
| `hooks/gate-advance.mjs` (PostToolUse) | the internal chain | **Evidence on disk.** |
| `hooks/approval-listener.mjs` (UserPromptSubmit) | `approve spec` / `approve plan` / `approve pr` | **An exact human phrase.** |

Before #91 the internal chain had no mover at all: the pre-implementation spine
existed only in the lane-agnostic `LINEAR_SPINE`, reachable by no event, so the
gate a session was bootstrapped at (`no-lane`) was the gate it died at. Every
"advance the gate" line in the orchestrator prompt and both lane skills named a
CLI or a library function it had no tool to invoke.

**Advancement is a pure function of what is on disk.** `gate-advance` walks the
lane's chain, and each step must clear the target gate's precondition
(`lib/gate-preconditions.mjs`) — so a gate cannot move because an agent says the
work happened, only because the artifact proving it landed:

| Gate | Evidence required |
| --- | --- |
| `lane-set` | `.devmate/state/router-result.json` (valid, `confidence >= 0.75`) |
| `discovery-done` | `.devmate/state/discovery-merged.json` |
| `grill-done` | `.devmate/state/grill-result.json` |
| `plan-done` | `.devmate/state/critique-result.json` |
| `spec-draft` | a non-empty `.devmate/session/spec.md` |

Those artifacts have no agent author — every analyst agent (`router`,
`discovery`, `planner`, `rubber-duck`) is read-only. The hook **projects** them
from the subagent returns the host carries in `tool_response`, which is the only
place a return is ever visible. A malformed return writes nothing, so the gate
stays put: fail-closed by construction.

The chains stop where a human must speak:

| Lane | Chain | Stops at |
| --- | --- | --- |
| feature | `no-lane → lane-set → discovery-done → grill-done → plan-done → spec-draft` | human: `approve spec` |
| bug | `no-lane → lane-set → grill-done → plan-approved` | human: `approve plan` |
| chore | `no-lane → lane-set → plan-approved → impl-started` | nothing — the lane is mechanical |

A human-approval event is never in a chain. `LANE_CHAINS`
(`lib/workflow/gate-advance.mjs`) is asserted not to contain `start-impl` on the
feature or bug lanes: that assertion is what keeps HITL-2 from being deleted by
accident.

Because the walk re-reads disk each time, a hook that fires late — or after a
restart — catches up through every gate whose artifact has since landed. A missed
invocation cannot desync the gate.

### The scope contract (#92)

Advancing the gate says *when* implementation may begin. `scope.md` says *what it
may touch*. It lives at `.devmate/session/<taskId>/scope.md`, and gate-guard
Rule 6 denies any source edit outside it.

Like the gate, **no agent authors it** — the `gate-advance` hook derives it from
the typed return of whichever agent scoped the work:

| Lane | Scope producer | Field |
| --- | --- | --- |
| feature | `@planner` | `tasks[].files` |
| bug | `@diagnose` | `allowedPaths` / `allowedGlobs` on the `DiagnosisResult` |
| chore | `@planner`, dispatched purely to scope | `tasks[].files` |

The chore lane's scoping dispatch exists because it previously dispatched nobody
before `@fullstack`: its `proposedFiles` list was orchestrator prose, and the
orchestrator has no tool that can put prose on disk.

**Absence fails closed.** A source edit at an implementation gate with no parsed
contract is denied, and `LANE_IMPL_REQUIREMENTS`
(`lib/workflow/dispatch-gate.mjs`) refuses the `@fullstack` dispatch itself
without one, on all three lanes. This polarity is the whole point: it used to be
inverted — a *missing* scope.md permitted every edit while an *empty* one denied
every edit — and since no lane could write the file, only the permissive branch
ever ran.

The contract always admits the test-file globs, or the first failing test that
TDD (and the bug lane) require would itself be an out-of-scope edit.

### Feature-lane spec gates (HITL-2)

On the feature lane the only legal move out of `plan-approved` is draft-spec into
`spec-draft` — the former direct `plan-approved` start-impl edge was a spec-gate
bypass and has been removed (bug/chore keep it: their pre-implementation
artifacts are dispatch-time checks, see the P26 dispatch gate). Two preconditions
back the edge change (`lib/gate-preconditions.mjs`):

- **Entering `spec-draft`** requires a non-empty `.devmate/session/spec.md` —
  the human review gate is never entered with nothing to review. The
  revise-scope steering edge back into `spec-draft` trivially satisfies this.
- **Entering `impl-started` on the feature lane** requires recorded spec
  artifacts in task.json (the spec path + digest stamped by spec-writer). This
  check is **always on** — it is NOT gated by the delegationFloor mode, so the
  default-off floor no longer leaves the spec gates unenforced. Bug/chore are
  exempt by design (the bug lane runs @diagnose during `impl-started`).

### AC-coverage precondition (AC-2)

Entry to `verification-passed` and `pr-ready` additionally runs an AC-coverage
check (`lib/gate-preconditions.mjs`'s `acCoveragePrecondition`), gated by the
`acCoverageGate` config mode (`off` default | `warn` | `block` — see
[config.md → AC-coverage gate](./config.md#ac-coverage-gate-optional)). It
parses the approved `spec.md`'s `## Acceptance criteria` section and checks
each item against the trace's recorded `impl-AC{n}` completions:

- On `verification-passed` its `missing` list is merged with the existing
  verify-evidence checks — each fires and reports independently (partial AC
  coverage with valid verify evidence is still refused; full AC coverage with
  stale verify evidence is refused on the verify reason).
- On `pr-ready` it is the only check — a cheap backstop, since re-dispatching
  a fix at that point is already illegal (implementation dispatch requires
  `impl-started`).

### Steering transitions (E10-05)

The last six events are the steering edges: they map mid-workflow scope changes to
legal transitions instead of illegal-transition dead ends, and they always continue
the same task — the taskId and all completed work are preserved, never reset.

- `revise-scope` (scope change mid-build) additionally requires a captured scope-change
  note at `.devmate/state/scope-change.json` for the current task; `re-plan` and
  `new-requirements` re-check the existing critique-result / grill-result preconditions
  of their target gates.
- `park` is refused unless a resume pointer is persisted at
  `.devmate/state/resume-pointer.json` (`taskId`, the gate to resume to, `parkedAt`).
  "Any in-flight gate" means every gate except `no-lane` and the terminals.
- `resume` returns to the exact gate recorded in the pointer and re-checks that
  gate's own precondition on entry. A resume that enters a human-approval gate still
  requires the actor + evidence audit pair (see above).
- `abandon` is issued only after the explicit confirmation required by the gate
  conversation protocol (see [workflow.md](./workflow.md)).

### Subcommand syntax

```
gatectl workflow set <event> [--actor <who> --evidence <msg>]
gatectl workflow approve <gate> --actor <who> --evidence <msg>
```

Example:

```sh
node scripts/gatectl.mjs workflow set draft-spec        # feature: enter spec review
node scripts/gatectl.mjs workflow set start-impl
node scripts/gatectl.mjs workflow set pass-verification
node scripts/gatectl.mjs workflow set complete
```

### Human-gate approvals (actor + evidence)

`spec-approved` and `pr-ready` are the two human-approval gates (see
[workflow.md](./workflow.md)). Any transition that **enters** one of them requires an
audit pair — `--actor` (who issued the transition) and `--evidence` (the verbatim human
message that approved it) — and appends a `gate_transition` trace event carrying both
fields:

```sh
node scripts/gatectl.mjs workflow approve spec-approved --actor orchestrator --evidence "yes, looks good — ship it"
node scripts/gatectl.mjs workflow approve pr-ready --actor orchestrator --evidence "approved, merge it"
node scripts/gatectl.mjs workflow set mark-pr-ready --actor orchestrator --evidence "approved, merge it"
```

- `workflow approve` addresses the target gate directly: `spec-approved` (from
  `spec-draft`) and `pr-ready` (from `verification-passed`). The orchestrator issues it
  after classifying explicit approval (E10-01), with the user's verbatim message as
  evidence.
- `workflow set mark-pr-ready` enters a human gate through the event table, so the same
  flags are required there. The other events (`start-impl`, `pass-verification`,
  `complete`) are internal/auto transitions and take no flags.
- A human-gate transition missing `--actor`/`--evidence` exits non-zero and the gate does
  not move. Edge legality and artifact preconditions are still enforced unchanged by
  `transitionGate` / `checkGatePrecondition`.
- The exact-phrase fast path in `hooks/approval-listener.mjs` (`approve spec` /
  `approve pr`) writes the same audit shape, stamping actor "hook-exact-phrase" with the
  raw prompt as evidence.

---

## Dependency Gates

Dependency gates signal inter-component readiness. They are stored in `.devmate/state/gates.json`.

| Gate name            | Description                                 |
| -------------------- | ------------------------------------------- |
| `backend-unit-pass`  | Backend unit tests all pass.                |
| `backend-ready`      | Backend is fully ready (integration + e2e). |
| `frontend-unit-pass` | Frontend unit tests all pass.               |
| `all-tests-pass`     | All test suites across the repo pass.       |

### Dependency Gate Statuses

| Status    | Meaning                                    |
| --------- | ------------------------------------------ |
| `pending` | Not yet evaluated (default initial state). |
| `pass`    | Gate check succeeded.                      |
| `fail`    | Gate check failed.                         |
| `skipped` | Gate check intentionally skipped.          |

### Subcommand syntax

```
gatectl dependency set <name> <status>
gatectl dependency get <name>
gatectl dependency list
```

Examples:

```sh
node scripts/gatectl.mjs dependency set backend-unit-pass pass
node scripts/gatectl.mjs dependency get backend-ready
node scripts/gatectl.mjs dependency list
```

---

## Deprecated Aliases

The following legacy forms are supported for backwards compatibility but emit a deprecation warning to stderr:

| Deprecated form                               | Canonical form                           |
| --------------------------------------------- | ---------------------------------------- |
| `gatectl set-workflow-gate <event>`           | `gatectl workflow set <event>`           |
| `gatectl set-dependency-gate <name> <status>` | `gatectl dependency set <name> <status>` |

Do not use the deprecated forms in new code. They will be removed in a future issue.
