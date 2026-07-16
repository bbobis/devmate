# AGENTS.md v2

> **Version:** 2.0.0 — reflects the end state after release 0.5.0  
> **Previous version archived at:** `docs/archive/AGENTS.v1.md`  
> **Status:** Authoritative for the agent roster, capabilities, and dispatch contracts. The runtime, orchestrator frontmatter, and docs-sync tests must match this document exactly. See [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) (E9-28) for the integrated end-to-end view.

---

## Purpose

This document is the canonical reference for every agent in devmate. It defines:

- which agents exist and what role they serve,
- which are user-invocable vs subagent-only,
- which may write product code (only `fullstack`),
- what artifacts each agent reads and produces,
- which lanes each agent participates in,
- the VS Code frontmatter conventions each agent must follow.

If this document and the runtime disagree, the runtime has a bug. The `test/docs-sync.test.mjs` CI gate enforces this invariant.

---

## Architecture Model

### One code-writing agent

`fullstack` is the **only agent that writes product code and tests.** Every implementation task — backend, frontend, or chore editing — runs through `fullstack` with a runtime persona loaded from `devmate.config.json`. No other agent may write, overwrite, or delete product code.

### Persona wrappers

`backend`, `frontend`, and `editor` are **thin dispatch contexts**, not independent implementation agents. They do not contain implementation instructions. They exist to give the orchestrator a named dispatch target that loads the correct persona when calling `fullstack`.

### Specialist agents

`discovery`, `tech-design`, `planner`, `rubber-duck`, `ui-ux`, `diagnose`, and `security` are **analysis, planning, critique, and review agents**. They produce typed artifacts. They do not write product code. They may use read tools (search, fetch, codebase traversal) and write tools only for their own output artifacts.

### Deprecated agents

`bsa` (`bsa.agent.md`) is **retired as of 0.5.0**. Its adversarial assumption-surfacing role is absorbed by `rubber-duck` in `mode=grill`. Its file is kept in the repo as a deprecated stub. It must not appear in any active `agents:` frontmatter list.

---

## Agent Roster

| Agent | Type | User-invocable | Writes code | Active lanes | Main output artifact |
|---|---|:---:|:---:|---|---|
| `orchestrator` | Coordinator | ✅ | ❌ | feature, bug, chore | task state, gate transitions |
| `router` | Classifier | ❌ | ❌ | feature, bug, chore | lane classification result |
| `discovery` | Analyst | ❌ | ❌ | feature | discovery report, evidence pointers |
| `tech-design` | Systems design | ❌ | ❌ | feature | design contract (API, data model, layers) |
| `planner` | Planner | ❌ | ❌ | feature | implementation plan, AC/TDD mapping |
| `spec-writer` | Writer | ❌ | ❌ | feature | `spec.md` |
| `rubber-duck` | Critique | ❌ | ❌ | feature, bug | grill/critique artifact |
| `ui-ux` | UI/UX design | ❌ | ❌ | feature | UI brief |
| `diagnose` | Diagnostician | ❌ | ❌ | bug | `DiagnosisResult`, `scope.md` |
| `security` | Reviewer | ❌ | ❌ | feature, bug | security review notes |
| `fullstack` | Implementer | ❌ | ✅ | feature, bug, chore | code diffs, tests, verification output |
| `backend` | Persona wrapper | ❌ | ❌ (routes to fullstack) | feature, bug | — |
| `frontend` | Persona wrapper | ❌ | ❌ (routes to fullstack) | feature, bug | — |
| `editor` | Persona wrapper | ❌ | ❌ (routes to fullstack) | chore | — |
| `frontend-tester` | Verifier | ❌ | Test-only | feature | E2E test results |
| `devmate-init` | Utility | ✅ | ❌ | utility | scaffolded `.devmate/` layout |
| `devmate-update` | Utility | ✅ | ❌ | utility | updated artifacts |
| `devmate-learn` | Utility | ✅ | ❌ | utility | conceptual explanation |
| `bsa` | **DEPRECATED** | ❌ | ❌ | — | retired — do not use |

---

## Model selection

The `model:` frontmatter key is read by the **VS Code Copilot host, not by devmate**. Nothing in this repo resolves it at runtime, so an unresolvable value does not error — VS Code silently falls back to whatever the model picker is set to, and the agent's model becomes unknown at exactly the point the file claims to fix it. `scripts/validate-agents.mjs` is therefore the only place the field can be checked, and it validates every agent against the allowlist in [`config/model-catalog.json`](../config/model-catalog.json) (model names + per-1M-token prices, sourced from [GitHub's models-and-pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), `verifiedAt 2026-07-13`).

Two facts from the host docs drive every choice below:

- **An array is an availability fallback, not a difficulty ladder.** VS Code: *"When you specify an array, the system tries each model in order until an available one is found."* `['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']` means "Sonnet 5 **only if** Opus is unavailable" — it does not escalate on hard tasks.
- **Auto is a model-picker entry, not a `model:` value.** `model: Auto (copilot)` is undocumented and resolves to nothing. The only documented route to Auto is to **omit `model:` entirely** — VS Code: *"If not specified, the currently selected model in model picker is used."* Auto routes on task complexity ("reserving higher-cost reasoning models for problems that truly need it") and carries a **10% discount**. Agents that do this must be listed in the catalog's `inheritPicker` so an absent `model:` stays a reviewed decision rather than an oversight; CI fails otherwise.

> **This means devmate expects the VS Code model picker to be set to Auto.** The unpinned agents inherit it. If the picker is set to a specific model, they inherit that instead.

The rule: **use Auto wherever a mis-route is cheap and recoverable; pin explicitly wherever a silently-cheaper model produces a silently-wrong artifact that a later stage will trust.** The gate agents are exactly the roles whose output nothing downstream re-checks.

Model names below are the **exact qualified strings** the catalog allowlists and the frontmatter must use — the `(copilot)` suffix is part of the value, and CI rejects a name without it.

| Agent | `model:` value | Why |
|---|---|---|
| `router` | *(key omitted → Auto)* | One-shot lane classifier; the orchestrator catches a mis-route. |
| `discovery` | *(key omitted → Auto)* | Read-only grounding — Auto routes grep-style exploration to a cheap model by itself. |
| `spec-writer` | *(key omitted → Auto)* | Mechanically renders an approved plan; the spec digest and human approval gate catch a bad render. |
| `backend`, `frontend`, `editor` | *(key omitted → Auto)* | Pure dispatch shims (`tools: [agent]`) — they emit one re-dispatch and write no code. The model that matters is `fullstack`'s. |
| `frontend-tester` | *(key omitted → Auto)* | Runs a test command and summarizes; the test run, not the model, is the source of truth. |
| `orchestrator` | `Claude Sonnet 5 (copilot)` | Long-horizon coordination across every lane; its context must stay coherent for the whole task, so it cannot be routed per-request. |
| `planner` | `Claude Sonnet 5 (copilot)` | Emits the plan and TDD mappings `fullstack` then executes verbatim. |
| `tech-design` | `Claude Sonnet 5 (copilot)` | Emits the design contract both `planner` and `fullstack` build on. |
| `ui-ux` | `Claude Sonnet 5 (copilot)` | **Must stay pinned:** its `tools` include `read/viewImage`, and Auto may route to a model without vision. |
| `rubber-duck` | `['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']` | The adversarial gate (grill + critique) and the role that catches the inert-layer bug class. Reasoning *is* the deliverable, and the artifact is a small critique — the premium rate lands on few tokens. |
| `security` | `['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']` | A false negative is silent and permanent; nothing downstream re-checks the review. |
| `diagnose` | `['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']` | The bug lane is strict diagnose-before-fix — a wrong root cause poisons every downstream stage, and `fullstack` will faithfully implement the wrong fix. |
| `fullstack` | `GPT-5.3-Codex (copilot)` | The only agent that writes product code, dispatched N times per task. GitHub classes it as "agentic software development"; cheapest input+cache of the serious coders. |

To change an agent's model, edit its `model:` line and keep it inside the catalog — do not add a name to the catalog without confirming it against the source URL and bumping `verifiedAt`.

---

## Per-Agent Contracts

### `orchestrator`

**Role:** Entry point for all three lanes. Classifies the task, owns gate state, writes `OutputContract`, and sequences all specialist and implementation dispatches.

```yaml
---
name: orchestrator
description: Stage-gated workflow coordinator for feature, bug, and chore lanes. Routes tasks to specialist agents and owns workflow state.
user-invocable: true
tools:
  [
    vscode/memory,
    vscode/runCommand,
    vscode/toolSearch,
    execute,
    agent,
    search,
    vscodeGeneral/runCommand,
    vscodeGeneral/toolSearch,
    todo,
  ]
skills: ["tdd-debug"]
agents: ["*"]
---
```

**Input:** User request (free text), lane classification  
**Output:** `OutputContract` (lane, taskId, budgetClass, gate state), handoff artifacts written to `.devmate/session/`  
**Disallowed:** Writing product code, skipping gate validations, advancing gates on empty or malformed dispatch results  
**Procedures:** Feature lane (Steps 1–11), Bug lane, Chore lane — all three must be explicitly written in the agent body

---

### `discovery`

**Role:** Maps current system behavior. Reads code, tests, and docs to establish ground truth before any planning begins. Every claim is backed by an evidence pointer. Unknowns are tagged `[UNVERIFIED]`.

```yaml
---
name: discovery
description: Read-only discovery agent for feature lane grounding. Maps current behavior from code/docs, emits evidence pointers, and marks unknowns as [UNVERIFIED].
user-invocable: false
tools: [read, search]
---
```

**Input:** Task description, optional area-of-interest hint  
**Output:** Discovery report with `EvidencePointer[]` — each with `path`, `lineRange`, `confidence`, `freshness`  
**Disallowed:** Writing code, assuming behavior without file evidence, resolving `[UNVERIFIED]` items by inference  
**Anti-hallucination rule:** Every factual claim about the codebase must include a file path and line range. Claims without evidence must carry `[UNVERIFIED]`.  
**Fan-out (FO-5):** At feature-lane step 2 the orchestrator may dispatch K scoped `discovery` workers (standard 2 / large 3) on disjoint candidate partitions from the deterministic scan; each worker keeps this same contract, and `scripts/merge-discovery.mjs` fans their artifacts into `.devmate/state/discovery-merged.json`, which downstream consumers read exactly like a single discovery report. See [parallel-dispatch.md](./parallel-dispatch.md).

---

### `tech-design`

**Role:** Produces the systems design artifact: proposed data models, API contracts, service/layer boundaries, and integration notes. Runs in parallel with `discovery` at feature-lane step 2.

```yaml
---
name: tech-design
description: Systems design agent for feature lane. Produces typed design contracts with APIs, boundaries, and risks.
user-invocable: false
tools: ['search/codebase', 'search/usages', 'read']
---
```

**Input:** Discovery report, task description  
**Output:** Design contract (typed object with `dataModel`, `apiContracts`, `layerBoundaries`, `assumptions[]`, `risks[]`)  
**Disallowed:** Writing product code, finalizing architecture decisions without referencing discovery output  
**Anti-hallucination rule:** Speculative design decisions must be tagged `[UNVERIFIED]` in the `assumptions[]` array.

---

### `planner`

**Role:** Converts discovery and design outputs into a structured implementation plan with per-acceptance-criteria TDD approach mappings. Passes the plan to `rubber-duck` for critique before spec writing.

```yaml
---
name: planner
description: "Produces a checkbox implementation plan with acceptance criteria and TDD mappings."
user-invocable: false
tools: ['search/codebase', 'search/usages', 'read']
---
```

**Input:** Discovery report, design contract, task description  
**Output:** Implementation plan with `tasks[]` (each task has `description`, `ac[]`, `tddApproach`, `persona`, `files[]`), `assumptions[]`, `openRisks[]`  
**Disallowed:** Writing product code, forwarding a plan with unresolved `openRisks[]` to spec without a rubber-duck critique pass  

---

### `spec-writer`

**Role:** Calls `lib/spec-writer.mjs writeSpec()` to persist the approved plan as `.devmate/session/spec.md`. Triggered after rubber-duck critique is resolved and before the human gate.

```yaml
---
name: spec-writer
description: Writes the approved plan to spec.md for human review and gate approval.
user-invocable: false
tools: ['read', 'edit']
skills: ['tdd-debug']
---
```

**Input:** Approved plan artifact; on revision, human feedback plus the existing `spec.md`  
**Output:** `.devmate/session/spec.md`, updated task state with `plan_stored_at` and spec metadata  
**Disallowed:** Modifying plan content during spec writing, skipping task-state update, creating any scratch/temp file under `.devmate/` to work around reading the current spec (read it directly with the `read` tool and rewrite `spec.md` in place)  

---

### `rubber-duck`

**Role:** Adversarial critique agent. Operates in two modes: `grill` (pre-plan, challenges assumptions and unknowns) and `critique` (post-plan, challenges the implementation plan). Never proposes code. Never resolves uncertainty — it surfaces it.

```yaml
---
name: rubber-duck
description: Adversarial reasoning agent. Runs in two modes — grill (pre-plan) and critique (post-plan). Read-only — never modifies source. Surfaces assumptions, edge cases, corner cases, and plan weaknesses.
user-invocable: false
tools: ['search/codebase', 'search/usages', 'read']
---
```

**Input:** Discovery report (grill mode) or implementation plan (critique mode)  
**Output:** `GrillResult` / `CritiqueResult` with `blockingQuestions[]`, `assumptions[]`, `edgeCases[]`, `unverifiedItems[]`  
**Disallowed:** Writing code, resolving questions itself, advancing the workflow — only the orchestrator may advance after rubber-duck output  
**Special rule:** Must explicitly hunt every item tagged `[UNVERIFIED]` in upstream artifacts and include it as a blocking or tracked question.

---

### `ui-ux`

**Role:** Produces a UI/UX brief before frontend implementation begins. Defines screen states, component behavior, edge cases, and error states for the feature. Runs before or at spec approval stage.

```yaml
---
name: ui-ux
description: Produces a UI/UX brief for frontend implementation scope.
user-invocable: false
tools: [read/readFile, read/viewImage, search, web/fetch, browser]
---
```

**Input:** Implementation plan, tech design contract, task description  
**Output:** UI brief with `screens[]`, `interactions[]`, `errorStates[]`, `components[]`  
**Disallowed:** Writing code, writing CSS/markup directly, making decisions about backend APIs  

---

### `diagnose`

**Role:** Bug-lane diagnostician. Reproduces the bug, identifies the root cause, determines the minimal affected scope, and writes a `DiagnosisResult` plus `scope.md`. Hands off to `fullstack` with a bounded edit scope.

```yaml
---
name: diagnose
description: Bug-lane diagnosis agent. Reproduces the bug, identifies the responsible persona/layer, and hands off to the generic full-stack fixer with the persona pre-filled.
user-invocable: false
tools: ['search/codebase', 'read/problems', 'execute']
handoffs:
  - label: 'Fix as diagnosed persona (@fullstack)'
    agent: fullstack
    prompt: 'Implement the fix for the diagnosed bug. Act as the persona named in the diagnosis bugScope; respect that persona''s editable globs from .devmate/devmate.config.json. Use the reproCommand to verify, then follow Red-Green-Refactor.'
    send: false
---
```

**Input:** Bug report, reproduction steps  
**Output:** `DiagnosisResult` with `bugScope` (persona-from-config or 'unknown'), `suspectedLayer`, `reproCommand`, `fixerRecommendation`, `taskId`, `schemaVersion` (must equal 1); `scope.md` with `allowedFiles[]`  
**Disallowed:** Writing a fix, guessing root cause without evidence (must tag `[UNVERIFIED]`)  

---

### `security`

**Role:** Pre-PR security review. Diffs the changes produced by `fullstack` and checks for common security risks: injection, auth bypass, sensitive data exposure, unsafe dependencies, and unsafe file operations.

```yaml
---
name: security
description: Read-only pre-PR security review agent for feature and bug diffs. Produces typed findings with evidence pointers.
user-invocable: false
tools: ['search/codebase', 'search/usages', 'read']
skills: ['app-security-handbook']
---
```

**Input:** Diff summary or list of changed files  
**Output:** Security review artifact with `findings[]` (each with `severity`, `description`, `path`), `passed` (true when no critical/high findings), and `unverified[]` tagged `[UNVERIFIED]`  
**Disallowed:** Writing code fixes, blocking the lane based on findings it cannot substantiate  

---

### `fullstack`

**Role:** The only product-code-writing agent. Loads a runtime persona from `devmate.config.json` to adapt its behavior to backend, frontend, or editor context. Follows TDD for all implementation. Respects `scope.md` for edit boundaries. Runs verification loops before reporting completion.

```yaml
---
name: fullstack
description: Generic, language/tool-agnostic implementation agent. Dispatched N times with a persona supplied at dispatch; edit boundaries come from .devmate/devmate.config.json.
user-invocable: false
tools: ["search/codebase", "read/problems", "edit", "execute", "agent"]
agents: ["fullstack", "backend", "frontend", "editor"]
skills: ["tdd-debug", "pragmatic-programmer", "app-security-handbook"]
---
```

**Input:** Implementation plan or `DiagnosisResult`, `scope.md`, persona context, UI brief (frontend persona)  
**Output:** Code and test diffs, verification output, completion summary  
**TDD rule:** Write a failing test first. Implementation follows. Never report completion before verification passes.  
**Scope rule:** Only edit files listed in `scope.md`. Gate guard enforces this via `PostToolUse` hook.  
**Disallowed:** Editing files outside scope, skipping failing-test-first on new behavior, calling implementation complete without verification  

---

### `backend` / `frontend` / `editor` (Persona wrappers)

These three files exist as thin dispatch contexts. Each tells the orchestrator how to invoke `fullstack` with the correct persona. They contain no implementation instructions.

```yaml
---
name: backend
user-invocable: false
tools: [agent]
agents: [fullstack]
---
Dispatch to @fullstack with persona=backend from devmate.config.json.
```

---

### `frontend-tester`

**Role:** Runs E2E and component tests after backend-ready gate is reached. Invoked by `fullstack` (frontend persona) when the backend API is confirmed stable.

```yaml
---
name: frontend-tester
description: Runs E2E and component tests after backend stabilizes.
user-invocable: false
tools: ['execute', 'search', 'codebase']
agents: []
---
```

**Input:** Backend-ready confirmation, test file scope  
**Output:** E2E/component test results, pass/fail summary  
**Disallowed:** Editing product source code  

---

### Utility agents (`devmate-init`, `devmate-update`, `devmate-learn`)

Each utility agent is a user-invocable slash-command entry point; the backing skill, where one exists, is listed below.

| Agent | Skill | What it does |
|---|---|---|
| `devmate-init` | `devmate-init` | Scaffolds `.devmate/` layout, installs all default agent wrappers |
| `devmate-update` | — | Updates devmate artifacts to the latest plugin version |
| `devmate-learn` | — | Explains devmate concepts and workflow to new users |

---

## Invocation Rules

1. **Always start with `@orchestrator`** for feature, bug, and chore work. Direct invocation of `@fullstack` is supported but bypasses all workflow gates, artifact generation, and TDD enforcement.
2. Agents marked `user-invocable: false` will not appear in the VS Code chat dropdown and cannot be invoked directly by users.
3. Handoff buttons in VS Code are the primary UX for agent-to-agent transitions. The orchestrator uses subagent dispatch for automated transitions.
4. `rubber-duck` may be invoked directly by the user at any time for an ad hoc critique pass without starting a full lane.
5. `diagnose` may be invoked directly by the user for isolated bug diagnosis without a full bug-lane run.

---

## Artifact Map

| Artifact | Path | Written by | Read by |
|---|---|---|---|
| Discovery report | `.devmate/session/{taskId}/discovery.json` | `discovery` | `planner`, `rubber-duck`, `tech-design` |
| Merged discovery artifact (fan-out runs) | `.devmate/state/discovery-merged.json` | `scripts/merge-discovery.mjs` | `planner`, `rubber-duck`, `tech-design` |
| Design contract | `.devmate/session/{taskId}/design.json` | `tech-design` | `planner`, `fullstack` |
| Implementation plan | `.devmate/session/{taskId}/plan.json` | `planner` | `rubber-duck`, `spec-writer`, `fullstack` |
| Grill/critique result | `.devmate/session/{taskId}/critique.json` | `rubber-duck` | `planner`, `orchestrator` |
| UI brief | `.devmate/session/{taskId}/ui-brief.json` | `ui-ux` | `fullstack` (frontend persona) |
| `spec.md` | `.devmate/session/spec.md` | `spec-writer` | human (gate review), `fullstack` |
| `scope.md` | `.devmate/session/{taskId}/scope.md` | `diagnose` (bug), orchestrator (feature/chore) | `fullstack`, gate-guard hook |
| DiagnosisResult | `.devmate/session/{taskId}/diagnosis.json` | `diagnose` | `fullstack`, orchestrator |
| Task state | `.devmate/state/task.json` | `gate-advance` + `approval-listener` hooks (the only writers) | all agents |
| Trace log | `.devmate/session/{taskId}/trace.jsonl` | session hooks | debugging, devmate-doctor |
| Security review | `.devmate/session/{taskId}/security.json` | `security` | orchestrator (pre-PR gate) |

---

## docs-sync Invariant

The CI gate `test/docs-sync.test.mjs` must assert:

- every agent in this document has a corresponding `.agent.md` file in `agents/`,
- every agent listed in `orchestrator.agent.md` frontmatter appears in this document as active (not deprecated),
- no deprecated agent appears in any active `agents:` frontmatter list.
