# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What devmate is

devmate is a **GitHub Copilot plugin for VS Code** that turns ad-hoc AI coding into a deterministic, stage-gated, resumable workflow. The plugin itself — hooks, agents, skills, and the Node scripts behind them — is what this repo builds. Its core differentiator is **token & context management**; keep that central to every change.

**The supported surface is GitHub Copilot in VS Code, and only that.** Copilot CLI and the Copilot cloud agent are explicitly not targets. The surfaces have different hook contracts, and half-supporting both is how five production defects hid: the hook layer was written against a Claude-Code-shaped contract (wrong tool names, wrong `tool_input` key, wrong output shapes, invented payload fields) while running under VS Code, leaving three "enforced" layers completely inert. When you touch a hook, the ground truth is a **captured payload** ([test/fixtures/hook-payloads/](test/fixtures/hook-payloads/)) — never the docs, and never an existing test's hand-authored payload. What a hook may emit is owned by [lib/hooks/output-schema.mjs](lib/hooks/output-schema.mjs); where a path lives in a `tool_input` is owned by [lib/hooks/tool-input.mjs](lib/hooks/tool-input.mjs). Do not add a sixth private parser.

The repo is developed as a backlog of self-contained issues: one issue per PR, `Closes #<N>` in the body, branch off `main`, squash-merge. Each issue body defers global rules to [CONTRIBUTING.md](CONTRIBUTING.md), which is the single source of truth for how code is built and **wins over an issue when they disagree** (unless the issue explicitly overrides it).

## Commands

`npm run verify` is the **single gate** — it is exactly what CI runs, so green locally means a green PR. Run it before every push.

| Command | What it does |
| --- | --- |
| `npm run verify` | The full gate: lint + typecheck + test + `check-contracts` + `check-docs-drift` + `check-script-refs` + `npm audit --audit-level=high` |
| `npm test` | `node --test` — the full suite |
| `npm run lint` | ESLint flat config (Node-target + 3 security plugins), `--max-warnings 0` |
| `npm run typecheck` | `tsc -p jsconfig.json` — JSDoc type check, no emit |
| `npm run check-contracts` / `worker-contract-check` | Agent/worker artifact return-shape contracts |
| `npm run check-docs-drift` | Fails if docs assert hook events, config keys, or state/gate names outside verified ground truth |
| `npm run eval:issue-quality` | Runs the issue-quality eval scorer |

**Run a single test file:** `node --test test/path/to/file.test.mjs`
**Filter by test name:** `node --test --test-name-pattern="partial name"`

There is **no build step** — `.mjs` runs directly on Node (types are JSDoc-only, checked by `tsc`). Node **24+** is required.

## Hard build constraints (easy to get wrong, enforced by CI)

- **All code is `.mjs` ES modules.** No CommonJS (`require`), no `.ts` sources, no `.ps1`. Use `import`/`export`.
- **Every file starts with `// @ts-check`** on line 1, with complete JSDoc types (`@typedef`, `@param`, `@returns`). Shared types live in [lib/types.mjs](lib/types.mjs) (typedef-only) and are imported, never re-declared.
- **Zero runtime dependencies by design.** `package.json` holds only dev tooling (ESLint, TypeScript, `@types/node`). Reach for `node:` built-ins first; a new runtime dep needs explicit PR justification.
- **Executable scripts export `main(args)`** and only run when executed directly (guarded by `isMainModule(import.meta.url)`), calling `assertNodeVersion(24)` from [lib/env-guard.mjs](lib/env-guard.mjs) first. This keeps them importable in tests without side effects. See CONTRIBUTING §6.
- **Cap tool output at the boundary.** Anything returning data to an agent must return `{ digest, fullOutputPath }`, never raw logs, unless `--include-full-output` is set. Use `buildLoopOutput` from [lib/loop/output-cap.mjs](lib/loop/output-cap.mjs). This (TCM-9) is the product's core discipline, not a nicety.
- **Deterministic logic.** Same input → same output. Avoid `Date.now()` / `Math.random()` inside anything snapshotted or replayed — inject them instead.
- **Cross-platform.** Hooks/scripts run on Linux, macOS, and Windows (CI's `hooks-smoke` job covers all three). Never assume POSIX paths or shells.
- **Never hand-edit generated blocks.** Sentinel-delimited sections (the capability table in `README.md`, all of `docs/CURRENT_BEHAVIOR.md`) are generated from metadata — edit the source registry and run `node scripts/generate-docs.mjs` / `node scripts/generate-current-behavior.mjs`.
- **Tests** use `node:test` + `node:assert/strict`, live under `test/` mirroring source paths as `*.test.mjs`, and **write only to temp dirs** (never into the repo tree).

Coding standards are enforced against `.github/instructions/*.md` (language-agnostic best practices, Pragmatic Programmer, security handbook, and hard `.mjs` regex/command-validation rules — no dynamic `RegExp` from runtime values; reuse `matchGlob` from [lib/gate-guard-core.mjs](lib/gate-guard-core.mjs)).

## Architecture (the big picture)

devmate is built on three ideas — read them before changing lane, gate, or agent behavior:

1. **Workflow-first, agent-second.** The procedure is *data*: a frozen gate-transition table ([lib/gate-transitions.mjs](lib/gate-transitions.mjs)) plus per-lane step lists. The orchestrator owns stage order; an agent is a worker *inside* the workflow, never the scheduler. Same request → same path.
2. **One code writer.** A single generic `fullstack` agent writes **all** product code and tests, shaped at dispatch time by a runtime *persona* from `.devmate/devmate.config.json`. Every other agent (router, discovery, tech-design, planner, rubber-duck, spec-writer, ui-ux, diagnose, security) only analyzes/plans/critiques/reviews and emits typed artifacts. `backend`/`frontend`/`editor` are thin persona-wrapper dispatch targets with no logic.
3. **Structural safety over prompt trust.** Correctness is enforced by typed artifacts, fail-closed hooks, scope contracts, and CI checks — not by instructions. Rules live where they can't be ignored.

### The three lanes

All work enters through `@orchestrator`, which has `@router` classify the request into a **lane** (feature / bug / chore) and **budget class** (`tiny` / `standard` / `large`), then runs that lane's gated procedure:

- **Feature** — the full pipeline: discovery + tech-design fan out → rubber-duck grill → plan → rubber-duck critique → `spec.md` → **human spec-approval gate** → `fullstack` ×N implements under TDD → security review → `pr-ready`.
- **Bug** — strict diagnose-before-fix: `@diagnose` reproduces and writes `DiagnosisResult` + `scope.md` → grill → `fullstack` writes a failing regression test first → verify → security → human `pr-ready`.
- **Chore** — mechanical edits under `persona=editor`; escalates to the feature lane if scope is exceeded.

Gate order is fixed by the unified transition table. Prose "milestones" (e.g. `design-done`, `backend-ready`, `diagnosis-done`) are **not** gate values and never appear in `state.workflowGate`. Full step lists and gate maps: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the integrated end-to-end walkthrough: [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md).

### Enforcement layers

- **Hooks** ([hooks/hooks.json](hooks/hooks.json) + `hooks/*.mjs` and hook-invoked `scripts/*.mjs`) fire on the 8 VS Code lifecycle events. `PreToolUse` gate-guard blocks tool calls that violate gate state or persona/`scope.md` boundaries (fail-closed). `PostToolUse` validates output contracts, enforces scope, meters the session budget, and re-verifies the approved spec's digest (a silent edit rolls the gate back).
- **Typed artifacts** in `.devmate/session/{taskId}/` (`state.json`, `discovery.json`, `plan.json`, `spec.md`, `scope.md`, `diagnosis.json`, `trace.jsonl`, …) are how agents communicate — **not** chat context. No agent may claim knowledge it doesn't hold as a readable artifact. Anything unproven is tagged `[UNVERIFIED]`.
- **Memory** is a 3-stage pipeline: collect task-local facts (`.devmate/memory/tasks/<taskId>.jsonl`) → transactionally promote to the repo ledger (`.devmate/state/repo/repo.jsonl`) → render the marker-bounded section of `.devmate/MEMORY.md`. Paths are centralized in [lib/memory/paths.mjs](lib/memory/paths.mjs).

### Repository layout

| Path | What lives here |
| --- | --- |
| `lib/` | Pure, testable logic, grouped by concern (`loop/`, `memory/`, `context/`, `orchestrator/`, `routing/`, `skills/`, `workflow/`, `gate-*`, …). |
| `scripts/` | Executable entrypoints & CI guards — every one exports `main(args)`. Documented in [docs/SCRIPTS.md](docs/SCRIPTS.md). |
| `hooks/` | Copilot hook handlers wired via `hooks/hooks.json`. |
| `agents/` | `*.agent.md` agent definitions (roster & contracts in [docs/AGENTS.md](docs/AGENTS.md)). |
| `skills/` | Skills as trigger stubs (`skills/<id>/SKILL.md`) + lazy `refs/` (progressive disclosure). |
| `config/` | Runtime policy (e.g. `model-policy.json`). Model IDs are never hardcoded. |
| `test/`, `evals/` | `*.test.mjs` suites (mirror source paths) and quality evals. |
| `.devmate/` | Per-repo runtime: `devmate.config.json` (personas, health predicates), memory, session state. |
| `docs/` | Design reference + generated docs. [docs/README.md](docs/README.md) is the index. |

## Context management — the secret sauce

The 12 **TCM rules** (Token & Context Management) are the reason this project exists. The core idea: *context is the architecture boundary* — the system decides what enters the active prompt, what stays a pointer, what gets summarized, and what is never loaded unless a stage needs it. Highlights: budgeted `OutputContract` per task (TCM-1); evidence is a pointer `{path, lineRange, …}`, not pasted content (TCM-3); skills are progressive-disclosure stubs + lazy refs (TCM-4/5); tool output capped at the boundary (TCM-9); workers return typed contracts, not transcripts (TCM-10). Full catalog with per-pattern **enforcement status** is [docs/PATTERNS.md](docs/PATTERNS.md).

**When relying on any documented behavior, check its enforcement tag in PATTERNS.md** (`structural` / `ci-enforced` / `hook-runtime` / `prompt-only` / `aspirational`). A `prompt-only` or `aspirational` pattern is not actually wired — don't assume it fires at runtime.

## Where to read next

- [CONTRIBUTING.md](CONTRIBUTING.md) — engineering conventions & Definition of Done (authoritative for *how* to build).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, lane procedures, gate maps, artifact/state model.
- [docs/AGENTS.md](docs/AGENTS.md) — the agent roster, per-agent contracts, and the `docs-sync` invariant.
- [docs/PATTERNS.md](docs/PATTERNS.md) — the TCM + workflow patterns, each with honest enforcement status.
- [docs/README.md](docs/README.md) — index to the full design-doc set.

Every claim about a Copilot capability (agents, prompts, skills, hooks) is grounded to official VS Code docs only; anything unverified is marked `[UNVERIFIED]` and kept configurable.
